import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { writeBrief } from "../serve/brief.js";
import { Store } from "../store/db.js";
import { Git } from "../store/git.js";
import { noteProse, readAllNotes, writeSubject } from "../store/vault.js";
import { acquireLock } from "../util/lock.js";
import type { RebaseOutcome } from "./reconcile.js";
import { rebaseSubjects, recordLinks, replayNote } from "./reconcile.js";
import { writeInbox } from "./run.js";

/**
 * Every subject re-derived from the notes, on the index as it stands.
 *
 * What `reindex` would give, without what `reindex` costs. Nothing is
 * deleted: rows keep their ids, the queue keeps its ids and decisions, and
 * sessions keep their fingerprints — a rebuild resets those, and the next
 * scan then re-reads every transcript, through the model for any whose note
 * carries no digest of its text (sameText in run). This is how an
 * index built before the session date decided the order is brought into
 * line with its notes — and a note put back by hand, a reverted re-read,
 * brings back its facts, its queue, its resume block and its search text.
 *
 * Only the subject files and briefs whose facts or resume moved are
 * rewritten, so the vault's commit shows the correction and nothing else.
 */
export function rebaseAll(
  cfg: Config,
  opts: { breakLock?: boolean } = {},
): RebaseOutcome & { subjects: number; notes: number; resumes: number; commit: string | null } {
  const release = acquireLock(cfg.vault, opts);
  const store = new Store(cfg.vault);
  try {
    const notes = readAllNotes(cfg.vault);
    // Every subject anything was ever said about: a fact row, a note, or a
    // queued claim alone — a claim below the floor never gets a fact row, and
    // its item would outlive the note that raised it.
    const subjects = new Set([...store.allSubjects(), ...store.pendingSubjects()]);
    for (const n of notes) for (const f of [...n.facts, ...n.retracted]) subjects.add(f.subject.trim());
    const out = rebaseSubjects(store, subjects, notes, cfg.confidenceFloor, new Date().toISOString());
    // Links are a set of pairs the notes name, first namer by session date —
    // what reindex rebuilds. Kept by adding only, they would keep the pairs of
    // a note put back.
    const linksBefore = store.linkCount();
    store.db.transaction(() => {
      store.clearLinks();
      for (const n of notes) recordLinks(store, n.links, n.sessionId);
    })();
    const linksMoved = store.linkCount() !== linksBefore;

    const projects = new Set<string>();
    let resumes = 0;
    // The resume block the brief opens with is read from the session row, not
    // the note. A note put back by hand — a reverted re-read — would leave the
    // brief quoting a reading the vault no longer holds.
    // Search is read from the index too; the same note put back must be found
    // by what it says now.
    for (const n of notes) {
      const row = store.getSession(n.sessionId);
      if (!row) continue;
      store.indexNote(n.sessionId, n.trailer?.project ?? row.project, /^# (.+)$/m.exec(n.md)?.[1] ?? "", noteProse(n.md));
      const resume = n.trailer?.resume ? JSON.stringify(n.trailer.resume) : null;
      if ((row.resume_json ?? null) === resume) continue;
      store.setResume(n.sessionId, resume);
      projects.add(row.project);
      resumes++;
    }
    for (const subject of out.changed) {
      writeSubject(cfg.vault, store, subject, store.kindOf(subject));
      for (const p of store.projectsOf(subject)) projects.add(p);
    }
    for (const p of projects) writeBrief(store, cfg.vault, p, cfg.briefMaxChars);
    writeInbox(store, cfg.vault);

    const commit = out.changed.length || resumes || linksMoved
      ? new Git(cfg.vault, cfg.git).commit(
          `rebase: ${out.changed.length} موضوعاً من ${subjects.size} بترتيب تاريخ الجلسة · +${out.inserted} صف · ${out.superseded} استبدال · ${out.retracted} سحب · ${out.restored} أُعيد` + (resumes ? ` · ${resumes} استئنافاً` : ""),
        )
      : null;
    return { ...out, subjects: subjects.size, notes: notes.length, resumes, commit };
  } finally {
    store.close();
    release();
  }
}

/**
 * Proves the Markdown is the source of truth: delete .index/ and this rebuilds
 * every fact, link and search row from the notes alone.
 *
 * Notes are replayed with the same `replayNote` a scan's rebase uses, in the
 * same order — session date, then session id — so a rebuild lands on the
 * slots the scans left, whatever order those scans met the sessions in.
 *
 * Under the scan lock: deleting the index out from under a running scan
 * would leave that scan writing into a database nothing reads.
 */
export function rebuildIndex(cfg: Config, opts: { breakLock?: boolean } = {}): { notes: number; facts: number; subjects: number } {
  const release = acquireLock(cfg.vault, opts);
  try {
    return rebuildLocked(cfg);
  } finally {
    release();
  }
}

function rebuildLocked(cfg: Config): { notes: number; facts: number; subjects: number } {
  const vault = cfg.vault;
  const dbFile = path.join(vault, ".index", "memory.db");
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      // An index that cannot be deleted is open elsewhere — an MCP server, a
      // scan. Replaying onto it would insert every claim a second time.
      throw new Error(`تعذّر حذف ${f} (${code}): الفهرس مفتوح في عملية أخرى — خادم MCP أو مسح. أغلقها ثم أعد المحاولة.`);
    }
  }

  const store = new Store(vault);
  try {
    const notes = readAllNotes(vault);
    const now = new Date().toISOString();
    store.db.transaction(() => {
      for (const n of notes) {
        const project = n.trailer?.project ?? n.fm["project"] ?? "unsorted";
        store.upsertSession({
          id: n.sessionId,
          agent: n.fm["agent"] ?? "unknown",
          source_file: n.fm["source"] ?? "",
          content_hash: "REINDEXED",
          cwd: null,
          project,
          started_at: n.fm["date"] || null,
          processed_at: now,
          status: "ok",
          note_path: path.relative(vault, n.file).replace(/\\/g, "/"),
          // The brief opens with the last session's resume block; it comes back
          // from the trailer like the facts do, or the rebuilt brief would lose it.
          resume_json: n.trailer?.resume ? JSON.stringify(n.trailer.resume) : null,
        });
        const title = /^# (.+)$/m.exec(n.md)?.[1] ?? "";
        // The same prose scan indexed, so search results do not change shape
        // depending on which path built the index.
        store.indexNote(n.sessionId, n.trailer?.project ?? "unsorted", title, noteProse(n.md));
        replayNote(store, n, cfg.confidenceFloor);
      }
    })();

    for (const s of store.subjects()) writeSubject(vault, store, s.subject, s.subject_kind);
    // Briefs are derived from the database just like subject files are; a
    // rebuild that regenerated one and not the other would leave agents
    // reading a brief the notes no longer support.
    const projects = store.db.prepare("SELECT DISTINCT project FROM sessions WHERE status = 'ok'").all() as Array<{
      project: string;
    }>;
    for (const p of projects) writeBrief(store, vault, p.project, cfg.briefMaxChars);
    writeInbox(store, vault);
    const st = store.stats();
    return { notes: notes.length, facts: st.facts ?? 0, subjects: st.subjects ?? 0 };
  } finally {
    store.close();
  }
}
