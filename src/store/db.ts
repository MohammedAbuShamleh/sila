import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { indexable } from "../util/arabic.js";

/**
 * SQLite is the *index*, never the source of truth. The Markdown vault is.
 * If this file is deleted, `sila reindex` rebuilds it from the .md files with
 * no loss. That inversion is what keeps the system honest: the thing you own
 * and can read is authoritative, and the fast thing is disposable.
 */

/**
 * `empty` is a transcript too short to read — under minUserChars, or with no
 * turn in it at all; `skipped` is one of the extractor's own sessions. Both
 * are recorded with their file's fingerprint so the cheap gate passes them
 * instead of reading them again on every scan; neither has a note.
 */
export type SessionStatus = "ok" | "quarantined" | "skipped" | "empty" | "pending-extraction";

export interface SessionRow {
  id: string;
  agent: string;
  source_file: string;
  content_hash: string;
  cwd: string | null;
  project: string;
  started_at: string | null;
  processed_at: string;
  status: SessionStatus;
  note_path: string | null;
  /** Why a session is waiting, when it is. */
  detail?: string | null;
  /** The note's resume block, serialized — what the brief opens with. */
  resume_json?: string | null;
  /**
   * For an `empty` row, the minUserChars it was judged under: a changed
   * threshold judges it again. Null when no threshold could change the
   * verdict — a file with no turn in it is empty at any.
   */
  min_user_chars?: number | null;
}

export interface FactRow {
  id: number;
  subject: string;
  subject_kind: string;
  key: string;
  claim: string;
  confidence: number;
  session_id: string;
  created_at: string;
  superseded_by: number | null;
  superseded_at: string | null;
  /** Set when a re-extraction of the same session no longer made this claim. */
  retracted_at: string | null;
}

export interface PendingRow {
  id: number;
  subject: string;
  subject_kind: string;
  key: string;
  claim: string;
  confidence: number;
  reason: string;
  session_id: string;
  created_at: string;
  /** waiting · accepted · rejected — or obsolete, when the claim's own note no longer queues it. */
  status: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  source_file   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  cwd           TEXT,
  project       TEXT NOT NULL,
  started_at    TEXT,
  processed_at  TEXT NOT NULL,
  status        TEXT NOT NULL,
  note_path     TEXT,
  detail        TEXT,
  resume_json   TEXT,
  min_user_chars INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_file ON sessions(source_file, content_hash);

-- Facts are append-only. A contradiction sets superseded_by on the old row and
-- inserts a new one; a re-extraction that no longer supports a claim sets
-- retracted_at on it. Nothing is ever UPDATEd away or DELETEd. A row is live
-- when both columns are NULL.
CREATE TABLE IF NOT EXISTS facts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject       TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,
  key           TEXT NOT NULL,
  claim         TEXT NOT NULL,
  confidence    REAL NOT NULL,
  session_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  superseded_by INTEGER,
  superseded_at TEXT,
  retracted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_slot ON facts(subject, key, superseded_by);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);

CREATE TABLE IF NOT EXISTS links (
  a         TEXT NOT NULL,
  b         TEXT NOT NULL,
  relation  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (a, b, relation)
);

-- Anything the engine is not confident about stops here and waits for a human.
CREATE TABLE IF NOT EXISTS pending (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  key         TEXT NOT NULL,
  claim       TEXT NOT NULL,
  confidence  REAL NOT NULL,
  reason      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'waiting'
);

CREATE TABLE IF NOT EXISTS quarantine (
  session_id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  session_id UNINDEXED,
  project    UNINDEXED,
  title,
  body,
  norm,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/**
 * Whether a session's transcript is no longer where its row says it is.
 *
 * Asked of the disk, not the index. A transcript can go without the engine
 * doing anything: one project's transcript folder left `~/.claude/projects`
 * whole one night, and a session deleted in the desktop app can take its file
 * with it (f860a427, 2026-10-01). A scan sees only what is on disk, so it
 * never meets such a row again; this is how the rest of the engine tells.
 * A file that moved somewhere a scan walks — an archived Codex thread — reads
 * as gone until the next scan finds it and its row follows.
 */
export function transcriptGone(row: Pick<SessionRow, "source_file">): boolean {
  return !row.source_file || !fs.existsSync(row.source_file);
}

/** The slot is live: not replaced by a newer claim, not withdrawn by a re-read. */
const LIVE = "superseded_by IS NULL AND retracted_at IS NULL";

/**
 * A session row that must be looked at again on the next scan. Quarantined
 * ones wait for a redaction fix; pending ones wait for their own agent's CLI.
 */
const RETRY = "('quarantined', 'pending-extraction')";

export class Store {
  readonly db: Database.Database;

  /**
   * `null` opens a store that lives in memory only: the scratch space a
   * subject is replayed in before the result is laid onto the real index.
   */
  constructor(vault: string | null) {
    if (vault === null) {
      this.db = new Database(":memory:");
    } else {
      const dir = path.join(vault, ".index");
      fs.mkdirSync(dir, { recursive: true });
      this.db = new Database(path.join(dir, "memory.db"));
    }
    this.db.exec(SCHEMA);
    // CREATE TABLE IF NOT EXISTS leaves an older table as it was, so a column
    // added later has to be added here too. The index is disposable, so a
    // failed migration is not fatal either — `sila reindex` starts clean.
    for (const sql of [
      "ALTER TABLE facts ADD COLUMN retracted_at TEXT",
      "ALTER TABLE sessions ADD COLUMN detail TEXT",
      "ALTER TABLE sessions ADD COLUMN resume_json TEXT",
      "ALTER TABLE sessions ADD COLUMN min_user_chars INTEGER",
    ]) {
      try {
        this.db.exec(sql);
      } catch {
        /* already present */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Idempotency gate: has this exact file content already been processed? */
  isProcessed(id: string, contentHash: string): boolean {
    const row = this.db
      .prepare("SELECT content_hash, status FROM sessions WHERE id = ?")
      .get(id) as { content_hash: string; status: string } | undefined;
    return !!row && row.content_hash === contentHash && row.status !== "quarantined" && row.status !== "pending-extraction";
  }

  /**
   * Cheap pre-parse gate keyed on the file, not the parsed session id: what
   * this exact file was found to be the last time it was read — a session
   * read, too short to read, or the extractor's own — or nothing, when it
   * has to be read now.
   */
  fileVerdict(sourceFile: string, contentHash: string): Pick<SessionRow, "status" | "min_user_chars"> | undefined {
    return this.db
      .prepare(
        `SELECT status, min_user_chars FROM sessions WHERE source_file = ? AND content_hash = ? AND status NOT IN ${RETRY} LIMIT 1`,
      )
      .get(sourceFile, contentHash) as Pick<SessionRow, "status" | "min_user_chars"> | undefined;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  /**
   * The file is updated with its fingerprint: the two are one key for the
   * cheap gate (fileVerdict), and a session whose file moved — a Codex
   * thread archived — kept its first path, so no scan after matched it.
   */
  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent, source_file, content_hash, cwd, project, started_at, processed_at, status, note_path, detail, resume_json, min_user_chars)
         VALUES (@id, @agent, @source_file, @content_hash, @cwd, @project, @started_at, @processed_at, @status, @note_path, @detail, @resume_json, @min_user_chars)
         ON CONFLICT(id) DO UPDATE SET
           source_file  = excluded.source_file,
           content_hash = excluded.content_hash,
           processed_at = excluded.processed_at,
           status       = excluded.status,
           note_path    = excluded.note_path,
           project      = excluded.project,
           detail       = excluded.detail,
           resume_json  = excluded.resume_json,
           min_user_chars = excluded.min_user_chars`,
      )
      .run({ detail: null, resume_json: null, min_user_chars: null, ...row });
  }

  /** The resume block of a session, as its note now has it. */
  setResume(id: string, resumeJson: string | null): void {
    this.db.prepare("UPDATE sessions SET resume_json = ? WHERE id = ?").run(resumeJson, id);
  }

  /** Every session with a note, in note order — for a pass over the notes the index knows. */
  notedSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE note_path IS NOT NULL ORDER BY note_path").all() as SessionRow[];
  }

  /**
   * Sessions that carry something — a note, a wait, a quarantine — whose
   * transcript is gone, oldest first. A short or self row carries nothing,
   * and is left out.
   */
  withoutTranscript(): SessionRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM sessions WHERE status IN ('ok', 'pending-extraction', 'quarantined')
            ORDER BY COALESCE(started_at, processed_at), id`,
        )
        .all() as SessionRow[]
    ).filter(transcriptGone);
  }

  /** Sessions waiting for the CLI of their own agent — whether or not their transcript is still there; see transcriptGone. */
  pendingExtractions(): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status = 'pending-extraction' ORDER BY processed_at DESC")
      .all() as SessionRow[];
  }

  /** The live fact occupying a (subject, key) slot, if any. */
  currentFact(subject: string, key: string): FactRow | undefined {
    return this.db
      .prepare(`SELECT * FROM facts WHERE subject = ? AND key = ? AND ${LIVE} ORDER BY id DESC LIMIT 1`)
      .get(subject, key) as FactRow | undefined;
  }

  insertFact(
    f: Omit<FactRow, "id" | "superseded_by" | "superseded_at" | "retracted_at"> & { retracted_at?: string | null },
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO facts (subject, subject_kind, key, claim, confidence, session_id, created_at, retracted_at)
         VALUES (@subject, @subject_kind, @key, @claim, @confidence, @session_id, @created_at, @retracted_at)`,
      )
      .run({ ...f, retracted_at: f.retracted_at ?? null });
    return Number(info.lastInsertRowid);
  }

  supersede(oldId: number, newId: number, at: string): void {
    this.db.prepare("UPDATE facts SET superseded_by = ?, superseded_at = ? WHERE id = ?").run(newId, at, oldId);
  }

  /** A withdrawn row filed as replaced instead: it points at its successor and carries no withdrawal date. */
  replace(oldId: number, newId: number, at: string): void {
    this.db.prepare("UPDATE facts SET superseded_by = ?, superseded_at = ?, retracted_at = NULL WHERE id = ?").run(newId, at, oldId);
  }

  /** Withdraw a claim. The row stays, with the moment it stopped being held. */
  retract(id: number, at: string): void {
    this.db.prepare("UPDATE facts SET retracted_at = ? WHERE id = ? AND retracted_at IS NULL").run(at, id);
  }

  /** The note a session's claims were written into, for a retraction that must reach the Markdown too. */
  notePathOf(sessionId: string): string | null {
    const row = this.db.prepare("SELECT note_path FROM sessions WHERE id = ?").get(sessionId) as
      | { note_path: string | null }
      | undefined;
    return row?.note_path ?? null;
  }

  liveFacts(subject: string): FactRow[] {
    return this.db
      .prepare(`SELECT * FROM facts WHERE subject = ? AND ${LIVE} ORDER BY key`)
      .all(subject) as FactRow[];
  }

  /** Every subject the facts table has ever held a row for, live or not. */
  allSubjects(): string[] {
    return (this.db.prepare("SELECT DISTINCT subject FROM facts").all() as Array<{ subject: string }>).map((r) => r.subject);
  }

  /**
   * The kind a subject's file is filed under: the same choice `subjects()`
   * makes for reindex — the least kind among its live rows — falling back to
   * all rows once nothing about it is live.
   */
  kindOf(subject: string): string {
    const row = this.db
      .prepare(`SELECT subject_kind FROM facts WHERE subject = ? ORDER BY (${LIVE}) DESC, subject_kind LIMIT 1`)
      .get(subject) as { subject_kind: string } | undefined;
    return row?.subject_kind ?? "term";
  }

  /** The projects whose sessions said anything about a subject — the briefs it appears in. */
  projectsOf(subject: string): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT s.project FROM facts f JOIN sessions s ON s.id = f.session_id WHERE f.subject = ?")
        .all(subject) as Array<{ project: string }>
    ).map((r) => r.project);
  }

  /** Every key a subject has ever had, live or not, in the order the vault first saw it. */
  keysOf(subject: string): string[] {
    return (
      this.db.prepare("SELECT key FROM facts WHERE subject = ? GROUP BY key ORDER BY MIN(id)").all(subject) as Array<{ key: string }>
    ).map((r) => r.key);
  }

  /** Every row of a subject, live or not, in the order it was inserted. */
  factsOf(subject: string): FactRow[] {
    return this.db.prepare("SELECT * FROM facts WHERE subject = ? ORDER BY id").all(subject) as FactRow[];
  }

  /** A row's links and dates, set as a whole — how a rebase lays a replayed history onto existing rows. */
  setHistory(
    id: number,
    h: Pick<FactRow, "superseded_by" | "superseded_at" | "retracted_at" | "created_at">,
  ): void {
    this.db
      .prepare("UPDATE facts SET superseded_by = ?, superseded_at = ?, retracted_at = ?, created_at = ? WHERE id = ?")
      .run(h.superseded_by, h.superseded_at, h.retracted_at, h.created_at, id);
  }

  /** Every queued claim about a subject, whatever became of it. */
  pendingOf(subject: string): PendingRow[] {
    return this.db.prepare("SELECT * FROM pending WHERE subject = ? ORDER BY id").all(subject) as PendingRow[];
  }

  setPendingStatus(id: number, status: string): void {
    this.db.prepare("UPDATE pending SET status = ? WHERE id = ?").run(status, id);
  }

  /** Everything a session is currently on record as claiming. */
  liveFactsFromSession(sessionId: string): FactRow[] {
    return this.db
      .prepare(`SELECT * FROM facts WHERE session_id = ? AND ${LIVE} ORDER BY id`)
      .all(sessionId) as FactRow[];
  }

  /** Every live fact, one per slot, by subject then key. */
  allLiveFacts(): FactRow[] {
    return this.db.prepare(`SELECT * FROM facts WHERE ${LIVE} ORDER BY subject, key`).all() as FactRow[];
  }

  /** What a human confirmed with `sila accept` and has not since withdrawn. */
  acceptedFacts(): FactRow[] {
    return this.db.prepare("SELECT * FROM facts WHERE confidence >= 1 AND retracted_at IS NULL ORDER BY id").all() as FactRow[];
  }

  retractedFacts(subject: string): FactRow[] {
    return this.db
      .prepare("SELECT * FROM facts WHERE subject = ? AND retracted_at IS NOT NULL ORDER BY retracted_at DESC, id DESC")
      .all(subject) as FactRow[];
  }

  history(subject: string, key: string): FactRow[] {
    return this.db
      .prepare("SELECT * FROM facts WHERE subject = ? AND key = ? ORDER BY id")
      .all(subject, key) as FactRow[];
  }

  subjects(): Array<{ subject: string; subject_kind: string; n: number }> {
    return this.db
      .prepare(
        `SELECT subject, MIN(subject_kind) AS subject_kind, COUNT(*) AS n
         FROM facts WHERE ${LIVE} GROUP BY subject ORDER BY n DESC`,
      )
      .all() as Array<{ subject: string; subject_kind: string; n: number }>;
  }

  addPending(p: {
    subject: string;
    subject_kind: string;
    key: string;
    claim: string;
    confidence: number;
    reason: string;
    session_id: string;
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending (subject, subject_kind, key, claim, confidence, reason, session_id, created_at)
         VALUES (@subject, @subject_kind, @key, @claim, @confidence, @reason, @session_id, @created_at)`,
      )
      .run(p);
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM pending WHERE status='waiting'").get() as { c: number }).c;
  }

  /** Every subject the queue has held a claim about, whatever became of it. */
  pendingSubjects(): string[] {
    return (this.db.prepare("SELECT DISTINCT subject FROM pending").all() as Array<{ subject: string }>).map((r) => r.subject);
  }

  linkCount(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM links").get() as { c: number }).c;
  }

  /** Links are derived from the notes' trailers alone; a rebase lays them again from scratch. */
  clearLinks(): void {
    this.db.prepare("DELETE FROM links").run();
  }

  addLink(a: string, b: string, relation: string, sessionId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO links (a, b, relation, session_id) VALUES (?, ?, ?, ?)")
      .run(a, b, relation, sessionId);
  }

  quarantine(sessionId: string, sourceFile: string, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO quarantine (session_id, source_file, reason, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`,
      )
      .run(sessionId, sourceFile, reason, new Date().toISOString());
  }

  indexNote(sessionId: string, project: string, title: string, body: string): void {
    this.db.prepare("DELETE FROM notes_fts WHERE session_id = ?").run(sessionId);
    this.db
      .prepare("INSERT INTO notes_fts (session_id, project, title, body, norm) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, project, title, body, indexable(`${title}\n${body}`));
  }

  search(query: string, limit = 20, project?: string): Array<{ session_id: string; project: string; title: string; snippet: string }> {
    const norm = indexable(query);
    if (!norm) return [];
    const match = norm
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"*`)
      .join(" OR ");
    const sql = `
      SELECT session_id, project, title,
             snippet(notes_fts, 3, '«', '»', ' … ', 14) AS snippet
      FROM notes_fts
      WHERE norm MATCH ? ${project ? "AND project = ?" : ""}
      ORDER BY bm25(notes_fts, 0, 0, 3.0, 1.0, 2.0)
      LIMIT ?`;
    const args: unknown[] = project ? [match, project, limit] : [match, limit];
    return this.db.prepare(sql).all(...args) as Array<{
      session_id: string;
      project: string;
      title: string;
      snippet: string;
    }>;
  }

  recentSessions(project: string, limit: number): SessionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE project = ? AND status = 'ok' ORDER BY COALESCE(started_at, processed_at) DESC LIMIT ?",
      )
      .all(project, limit) as SessionRow[];
  }

  stats(): Record<string, number> {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      sessions: one("SELECT COUNT(*) c FROM sessions WHERE status='ok'"),
      quarantined: one("SELECT COUNT(*) c FROM quarantine"),
      pendingExtraction: one("SELECT COUNT(*) c FROM sessions WHERE status='pending-extraction'"),
      subjects: one(`SELECT COUNT(DISTINCT subject) c FROM facts WHERE ${LIVE}`),
      facts: one(`SELECT COUNT(*) c FROM facts WHERE ${LIVE}`),
      superseded: one("SELECT COUNT(*) c FROM facts WHERE superseded_by IS NOT NULL"),
      retracted: one("SELECT COUNT(*) c FROM facts WHERE retracted_at IS NOT NULL"),
      links: one("SELECT COUNT(*) c FROM links"),
      pending: one("SELECT COUNT(*) c FROM pending WHERE status='waiting'"),
    };
  }

  setMeta(k: string, v: string): void {
    this.db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  }

  getMeta(k: string): string | null {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined;
    return row?.v ?? null;
  }
}
