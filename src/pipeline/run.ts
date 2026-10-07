import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { agentForSourceFile, canonical, injectAllowed, mayUseNetwork, projectDirOf, projectOf, sameProviderFor } from "../config.js";
import { adapterFor } from "../adapters/index.js";
import type { Activity } from "../adapters/base.js";
import { fingerprint } from "../adapters/base.js";
import type { FactRow } from "../store/db.js";
import { Store, transcriptGone } from "../store/db.js";
import { Git } from "../store/git.js";
import type { NoteRecord } from "../store/vault.js";
import {
  claimInSlot,
  initVault,
  noteExtractor,
  noteProse,
  noteTouches,
  parseFactsTrailer,
  paths,
  readAllNotes,
  readNote,
  renderSessionNote,
  selectResumeFiles,
  sessionNotePath,
  writeSubject,
} from "../store/vault.js";
import { staleBriefs, describeStop, injectBrief, writeBrief } from "../serve/brief.js";
import { distill } from "./distill.js";
import { probeCwd } from "./dryrun.js";
import { reportDryRun } from "./dryrun-report.js";
import type { CliRunner } from "./extract.js";
import { definitionsFor, extractNote, factsContext, neutralCwd } from "./extract.js";
import { redact, scrubNote } from "./redact.js";
import type { AnchorReason, Anchored } from "./reconcile.js";
import {
  anchorSubjects,
  applyMoves,
  applyRetractions,
  canonicalizeFacts,
  carryConfirmed,
  liveFactsAsOf,
  partOfProject,
  rebaseSubjects,
  recordLinks,
  retractUnconfirmed,
} from "./reconcile.js";
import type { RawSession, SessionNote, Usage } from "../types.js";
import { CLI_FOR_AGENT } from "../types.js";
import { readFileIfExists, sha256, slug, writeFileAtomic } from "../util/fsatomic.js";
import { acquireLock } from "../util/lock.js";

/**
 * The orchestrator: discover → fingerprint → distill → redact → extract →
 * write the note → rebase → commit.
 *
 * Three ordering rules govern everything here, and all three exist to protect
 * the append-only model rather than to go faster:
 *
 *  1. The session date decides, not the processing order. Supersession is
 *     order-dependent, and the order sessions reach a scan is not the order
 *     they happened in — a pending session is read days late, a `--force`
 *     re-read today. So claims are not applied as they arrive: the note is
 *     written, and every subject it touches is re-derived from all the notes
 *     that mention it, in session-date order, by the same replay `reindex`
 *     runs (see rebaseSubjects). An older session never displaces a newer
 *     one, and a rebuild lands on the slots the scan left. What the
 *     extractor is shown of memory follows the same rule: what was known
 *     before the session's date (see liveFactsAsOf), so a session read late
 *     is judged against the memory of its own day, not against what later
 *     sessions learned.
 *
 *  2. Extraction is concurrent, application is not. Network calls run in
 *     batches, but results are written in sorted order inside each batch, and
 *     one batch fully lands before the next starts. The cost is a little
 *     throughput at each batch boundary; the alternative is letting completion
 *     order — i.e. network latency — decide what the next session is shown.
 *
 *  3. One scan per vault at a time. A session-end hook and `sila watch` can
 *     both start one, and two scans writing one note each from the same
 *     session would leave the index with both readings. The lock in
 *     util/lock.ts is what enforces it.
 */

export interface ScanOptions {
  limit: number;
  concurrency: number;
  dryRun: boolean;
  force: boolean;
  onlyAgent?: string | undefined;
  /** A project name or its slug; sessions of every other project are skipped. */
  onlyProject?: string | undefined;
  /** One transcript, by path — what a session-end hook hands over. Nothing else is discovered. */
  onlyFile?: string | undefined;
  /** Take the lock even from a live holder — see util/lock.ts. */
  breakLock?: boolean | undefined;
  /** Test seam: stands in for every agent CLI, as in extractNote. */
  runner?: CliRunner | undefined;
  /** Test seam: the moment the scan starts, for a case replayed at the time it happened. */
  now?: number | undefined;
  /** This run's cap on a distilled session, in place of the config's — for one session whose reply keeps breaking. */
  maxChars?: number | undefined;
}

export interface ScanResult {
  discovered: number;
  processed: number;
  skippedUnchanged: number;
  /** Transcripts whose file changed and whose distilled text did not — see sameText. */
  unchangedText: number;
  skippedTiny: number;
  skippedOtherProject: number;
  /** Transcripts written to within the last two minutes, or with a turn still running: sessions still going, read when they end — see OPEN_SESSION_MS and stillOpen. */
  skippedOpen: number;
  /** Sessions the engine's own CLI extraction calls left behind. */
  skippedSelf: number;
  /**
   * Changed transcripts past `--limit`, left for the next scan. The scan used
   * to stop looking at the limit and say nothing, and the summary's counts
   * then fell short of what it had discovered; it now goes on counting, and
   * the summary says it stopped and how many wait.
   */
  leftAtLimit: number;
  /**
   * Sessions read before whose reading this time did not replace their note:
   * their own CLI did not answer, or a local reading met a model note. Each
   * has its line on stderr; this is its place in the summary's arithmetic.
   */
  keptPrevious: number;
  /** Sessions whose own agent's CLI could not answer; retried next scan. */
  pendingExtraction: number;
  /** The same sessions, each with its agent and its provider's words — see waitingLines. */
  waiting: Array<{ agent: string; detail: string | null }>;
  factsAdded: number;
  factsSuperseded: number;
  factsRetracted: number;
  /** Slots put back by session date — a claim the processing order had let an older session displace. */
  factsRestored: number;
  /** New subjects put back on their project: a file, a class, a ticket, or another spelling of a live one. */
  subjectsAnchored: number;
  /** Claims a re-read filed where a human had moved them — the note's ledger, see applyMoves. */
  movesApplied: number;
  /** Claims a human confirmed at 1.0 that a re-read did not repeat, kept in its note — see carryConfirmed. */
  confirmedCarried: number;
  queued: number;
  quarantined: number;
  failed: number;
  modelCalls: number;
  usage: UsageTally;
  /**
   * The same, by who answered — a CLI's name, or "api". Only claude names a
   * price; a single sum printed as one line showed codex's six calls of
   * 2026-09-26 as zero tokens beside claude's dollars.
   */
  usageBy: Record<string, UsageTally>;
  /** Agent files the brief was injected into after this scan. */
  synced: string[];
  /** Projects whose injection this scan stopped, each with the report that says why. */
  injectStopped: string[];
  /** Projects whose written brief offered something that no longer works — a dead resume command, a stamp that does not run — rewritten; see staleBriefs. */
  briefsRewritten: string[];
  commit: string | null;
}

type UsageTally = Usage & { calls: number; costUsd: number };

function emptyTally(model: string): UsageTally {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model, calls: 0, costUsd: 0 };
}

/**
 * The scan summary's cost lines, one per provider that answered. Input is
 * uncached input for every provider (see codexReply); a provider that names
 * no price is said to, rather than shown as free.
 */
export function usageLines(by: Readonly<Record<string, UsageTally>>): string {
  return Object.entries(by)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([who, u]) =>
        `\n  ${who} ${u.calls} · رموز ${u.inputTokens}↓ ${u.outputTokens}↑` +
        (u.cacheReadTokens ? ` · من الذاكرة المؤقتة ${u.cacheReadTokens}` : "") +
        (u.costUsd ? ` · $${u.costUsd.toFixed(4)}` : " · بلا سعر من المزوّد"),
    )
    .join("");
}

/**
 * Sessions waiting on their own agent's CLI, counted by provider and by what
 * the provider said — for the scan summary and `sila stats`. A count alone
 * ("ينتظر استخلاصه 6") hid that all six were codex at its usage limit. The
 * provider is the session's agent's CLI, which same-provider makes the only
 * one it could have waited on; the reason is the provider's message as it
 * came, never read for meaning, so a vendor rewording it changes the line and
 * nothing else.
 */
export function waitingLines(rows: ReadonlyArray<{ agent: string; detail?: string | null | undefined }>): string {
  const groups = new Map<string, { provider: string; reason: string; count: number }>();
  for (const r of rows) {
    const provider = (CLI_FOR_AGENT as Record<string, string>)[r.agent] ?? r.agent;
    // callCli names the CLI before its message; the line names it already.
    const said = (r.detail ?? "").trim();
    const reason = (said.startsWith(`${provider}: `) ? said.slice(provider.length + 2) : said) || "بلا سبب مسجَّل";
    const key = `${provider}\n${reason}`;
    const g = groups.get(key) ?? { provider, reason, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
    .map((g) => `\n  ${g.provider} ${g.count} — ${g.reason}`)
    .join("");
}

interface Candidate {
  file: string;
  agent: string;
  mtimeMs: number;
}

/**
 * `--file` named a transcript that is not there.
 *
 * A SessionEnd payload names its transcript whether or not one was written:
 * a session closed without a word has none, and the hook's child scan used
 * to die on it with a stack trace in hook.log and a non-zero exit. It is the
 * one outcome a hook meets often enough to deserve a sentence, not a trace
 * (the user's call, 2026-09-25). Typed, so the CLI can tell it from a real
 * failure — as it tells LockHeldError.
 */
export class MissingTranscriptError extends Error {
  constructor(readonly file: string) {
    super(`${file} غير موجود — جلسة انتهت بلا نص؛ لا شيء يُقرأ`);
    this.name = "MissingTranscriptError";
  }
}

/**
 * How recently a transcript must have been written to for the scan to treat
 * its session as still open and leave it alone.
 *
 * A scan reads every transcript whose fingerprint changed, and a session
 * that is still running changes its fingerprint with every turn. The full
 * scan of 2026-09-24 read the very session that was running it, halfway
 * through, and filed a gotcha from a test harness as if it were a fact about
 * schtasks. Two minutes of quiet is longer than a turn and shorter than a
 * coffee; a session that goes quiet longer than that and then resumes is
 * read twice, which the fingerprint gate already survives. The session-end
 * hook names its transcript with --file and is exempt: it fires when the
 * session is over, and the file was written seconds ago (the user's rule,
 * 2026-09-24).
 */
export const OPEN_SESSION_MS = 2 * 60_000;

/**
 * How long a turn that started and never finished stays open.
 *
 * A running turn's last record is usually recent, though a tool can hold it
 * silent for minutes; one whose agent died leaves its turn open forever —
 * Codex's `task_started` with nothing after it, Claude Code's prompt or tool
 * call with no answer. Six hours of silence says the second, and the session
 * is read as it stands (the user's rule, 2026-09-26; for Claude Code,
 * 2026-09-28).
 */
export const OPEN_TURN_MS = 6 * 3_600_000;

/** Whether the records say the session is still being written — see Adapter.activity. */
export function stillOpen(seen: Activity, now: number): boolean {
  return now - seen.at < (seen.busy ? OPEN_TURN_MS : OPEN_SESSION_MS);
}

/** How many readings in a week make a session worth a look — the user's line, 2026-09-27. */
export const REREAD_DAYS = 7;
export const REREAD_OVER = 3;

/**
 * Sessions read more than `over` times in `days` days, most first — for
 * `sila doctor`. Two files sharing one session id were re-read by turns for
 * three days, 66 rewrites of one note, and nobody saw it: no one reading is
 * wrong, only the count is. This catches the class — a fingerprint that never
 * settles, a transcript still being written, a gate that keys on the wrong
 * thing — not that one case. Null without git.
 */
export function frequentRereads(git: Git, days = REREAD_DAYS, over = REREAD_OVER): Array<{ note: string; count: number }> | null {
  const counts = git.noteRewrites(days);
  if (!counts) return null;
  return [...counts]
    .filter(([, n]) => n > over)
    .map(([note, count]) => ({ note, count }))
    .sort((a, b) => b.count - a.count || a.note.localeCompare(b.note));
}

export interface OpenSession {
  agent: string;
  file: string;
  /** mtime: written in the last two minutes; busy: a turn running; quiet: a turn finished under two minutes ago. */
  why: "mtime" | "busy" | "quiet";
  /** Epoch ms of the write that keeps it open. */
  lastMs: number;
}

/**
 * Every transcript the scan would leave alone right now as a session still
 * going, by the same two rules — for `sila doctor`. A rule that skips things
 * leaves no trace when it works and none when it fails: the scheduled scan of
 * 2026-09-26 read a live Codex turn and nothing said the rule had not seen
 * it. Unlike the scan, every file is asked, changed or not.
 */
export async function openSessions(cfg: Config, now = Date.now()): Promise<OpenSession[]> {
  const out: OpenSession[] = [];
  for (const [key, root] of Object.entries(cfg.sources)) {
    if (!root) continue;
    const adapter = adapterFor(key);
    if (!adapter) continue;
    for (const file of await adapter.discover(root)) {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs < OPEN_SESSION_MS) {
        out.push({ agent: adapter.id, file, why: "mtime", lastMs: mtimeMs });
        continue;
      }
      const seen = await adapter.activity(file).catch(() => null);
      if (seen && stillOpen(seen, now)) out.push({ agent: adapter.id, file, why: seen.busy ? "busy" : "quiet", lastMs: seen.at });
    }
  }
  return out;
}

/** Memory as it stood before a session: the project's live facts, and every live subject. */
interface MemoryAsOf {
  facts: FactRow[];
  subjects: ReadonlySet<string>;
}

export async function scan(cfg: Config, opts: ScanOptions): Promise<ScanResult> {
  initVault(cfg.vault);
  // Taken before the store opens and released after it closes, so a scan
  // that fails halfway still hands the vault back.
  const release = acquireLock(cfg.vault, { breakLock: opts.breakLock === true });
  const store = new Store(cfg.vault);
  try {
    return await scanLocked(opts.maxChars ? { ...cfg, distillMaxChars: opts.maxChars } : cfg, opts, store);
  } finally {
    store.close();
    release();
  }
}

async function scanLocked(cfg: Config, opts: ScanOptions, store: Store): Promise<ScanResult> {
  const git = new Git(cfg.vault, cfg.git);

  const result: ScanResult = {
    discovered: 0,
    processed: 0,
    skippedUnchanged: 0,
    unchangedText: 0,
    skippedTiny: 0,
    skippedOtherProject: 0,
    skippedOpen: 0,
    skippedSelf: 0,
    leftAtLimit: 0,
    keptPrevious: 0,
    pendingExtraction: 0,
    waiting: [],
    factsAdded: 0,
    factsSuperseded: 0,
    factsRetracted: 0,
    factsRestored: 0,
    subjectsAnchored: 0,
    movesApplied: 0,
    confirmedCarried: 0,
    queued: 0,
    quarantined: 0,
    failed: 0,
    modelCalls: 0,
    usage: emptyTally(cfg.extractor.model),
    usageBy: {},
    synced: [],
    injectStopped: [],
    briefsRewritten: [],
    commit: null,
  };

  // Matched on slugs from both sides, so "برنامج تجريبي" and
  // "برنامج-تجريبي" name the same project.
  const wantProject = opts.onlyProject ? slug(opts.onlyProject) : null;

  // ---- discover -----------------------------------------------------------
  const candidates: Candidate[] = [];
  if (opts.onlyFile) {
    // The transcript that just closed, named by the hook. Its agent is read
    // off its location unless the caller says otherwise; a file under no
    // source root is refused, not guessed — `--limit 1` used to take the
    // oldest changed file instead, which is the finished session only by
    // luck.
    const file = path.resolve(opts.onlyFile);
    const agent = opts.onlyAgent ?? agentForSourceFile(cfg, file);
    if (!agent) throw new Error(`${file} لا يقع تحت أي مصدر معروف — مرّر --agent`);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      throw new MissingTranscriptError(file);
    }
    candidates.push({ file, agent, mtimeMs });
  } else {
    for (const [key, root] of Object.entries(cfg.sources)) {
      if (!root) continue;
      const adapter = adapterFor(key);
      if (!adapter) continue;
      if (opts.onlyAgent && adapter.id !== opts.onlyAgent) continue;
      for (const file of await adapter.discover(root)) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        candidates.push({ file, agent: adapter.id, mtimeMs });
      }
    }
  }
  result.discovered = candidates.length;

  // Oldest first — see rule 1 above. File mtime stands in for the session
  // date so the sort costs no reads; a transcript's last write is a faithful
  // proxy for when its work happened.
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // ---- fingerprint gate ---------------------------------------------------
  const todo: Candidate[] = [];
  const startedAt = opts.now ?? Date.now();
  for (const c of candidates) {
    // Still being written: a session that has not ended. Before the
    // fingerprint, so an open transcript is not even hashed; --force does
    // not override it, only the hook's --file does (see OPEN_SESSION_MS).
    if (!opts.onlyFile && startedAt - c.mtimeMs < OPEN_SESSION_MS) {
      result.skippedOpen++;
      continue;
    }
    if (!opts.force) {
      let hash: string;
      try {
        hash = fingerprint(c.file);
      } catch {
        continue;
      }
      // What this file was found to be the last time — see recordUnread. A
      // short transcript is judged again when the threshold it fell under has
      // changed; one with no turn in it is short under any.
      const seen = store.fileVerdict(c.file, hash);
      if (seen?.status === "skipped") {
        result.skippedSelf++;
        continue;
      }
      if (seen?.status === "empty") {
        if (seen.min_user_chars == null || seen.min_user_chars === cfg.minUserChars) {
          result.skippedTiny++;
          continue;
        }
      } else if (seen) {
        result.skippedUnchanged++;
        continue;
      }
    }

    // Silence is not an ending: the agent's records say when it last wrote
    // and whether a turn is running — Codex's mtime is no clock at all, and
    // Claude Code's stops while a tool runs. Read only for a file that
    // changed — the end of it, not all of it — and, like the mtime rule, not
    // for the one --file names, nor overridden by --force.
    if (!opts.onlyFile) {
      const adapter = adapterFor(c.agent);
      const seen = adapter ? await adapter.activity(c.file).catch(() => null) : null;
      if (seen && stillOpen(seen, startedAt)) {
        result.skippedOpen++;
        continue;
      }
    }

    // The project filter has to sit here, before `--limit` is consumed, or
    // `--project acme --limit 20` could spend its twenty slots on twenty
    // files from other projects and process nothing. The probe reads only the
    // opening records, and it skips a file only on a *positive* mismatch: an
    // unreadable cwd is "unknown", not "other", and the full parse in
    // prepare() gets the final say on those.
    if (wantProject) {
      let cwd = await probeCwd(c.file, c.agent);
      if (!cwd) {
        // The probe could not place the file. Passing it through "to let
        // prepare() decide" is wrong here: it would take a --limit slot, and
        // the unplaceable files are the oldest ones — `--limit 3` once spent
        // all three slots on empty transcripts and never reached the project.
        // So the file is parsed in full right here; it is a rare case.
        const adapter = adapterFor(c.agent);
        const session = adapter ? await adapter.parse(c.file) : null;
        if (!session) {
          result.skippedTiny++;
          continue;
        }
        cwd = session.cwd;
      }
      if (slug(projectOf(cfg, cwd)) !== wantProject) {
        result.skippedOtherProject++;
        continue;
      }
    }

    // Past the limit the gate goes on, so what waits is counted, not guessed.
    if (todo.length >= opts.limit) {
      result.leftAtLimit++;
      continue;
    }
    todo.push(c);
  }

  if (opts.dryRun) {
    await reportDryRun(
      cfg,
      candidates.length,
      todo,
      result.skippedUnchanged,
      opts.onlyProject ? { project: opts.onlyProject, skipped: result.skippedOtherProject } : null,
      result.skippedOpen,
      { limit: opts.limit, left: result.leftAtLimit },
      { tiny: result.skippedTiny, self: result.skippedSelf },
    );
    return result;
  }

  // ---- process ------------------------------------------------------------
  const batchSize = Math.max(1, Math.min(opts.concurrency, 16));
  const touched = new Map<string, string>();
  const projectsTouched = new Set<string>();
  const projectDirs = new Map<string, string>();
  const degraded: string[] = [];
  // Read before, and its provider did not answer this time: nothing stood in
  // for it, so it is not a fallback — it used to be printed as one.
  const unanswered: string[] = [];
  // Every note in the vault, by file — what a rebase replays from. Read once,
  // on the first session that needs it, and kept current as notes are written.
  let notes: Map<string, NoteRecord> | null = null;
  const noteIndex = (): Map<string, NoteRecord> => (notes ??= new Map(readAllNotes(cfg.vault).map((n) => [n.file, n])));
  // What the extractor is shown of a project's memory: what was known before
  // the session's date — rule 1 applied to what the model reads, too. The
  // facts shown are the project's own, and a defined tool's from any project
  // (offeredFacts); the subjects the guard checks against are every live one,
  // and are never sent anywhere.
  const tools = new Set(Object.entries(definitionsFor(cfg)).filter(([, d]) => d.trim()).map(([t]) => t));
  const memoryAsOf = (project: string, date: string, agent: string | null): MemoryAsOf => {
    const all = [...noteIndex().values()];
    const ours = new Set(all.filter((n) => (n.trailer?.project ?? n.fm["project"]) === project).map((n) => n.sessionId));
    const live = liveFactsAsOf(store, all, date, cfg.confidenceFloor, () => true);
    return { facts: offeredFacts(live, ours, agent, tools), subjects: new Set(live.map((f) => f.subject)) };
  };

  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);

    const prepared = await Promise.all(
      batch.map(async (c) => {
        try {
          return { c, outcome: await prepare(c, cfg, store, result, wantProject, memoryAsOf, opts.force, opts.runner) };
        } catch (err) {
          return { c, error: err };
        }
      }),
    );

    // Apply in batch order, never completion order — rule 2.
    for (const entry of prepared) {
      if ("error" in entry && entry.error) {
        result.failed++;
        process.stderr.write(`فشل ${entry.c.file}: ${String(entry.error).slice(0, 160)}\n`);
        continue;
      }
      const outcome = "outcome" in entry ? entry.outcome : undefined;
      if (!outcome) continue;

      if (outcome.kind === "tiny") {
        recordUnread(cfg, store, entry.c, outcome);
        result.skippedTiny++;
        continue;
      }
      if (outcome.kind === "filtered") {
        result.skippedOtherProject++;
        continue;
      }
      if (outcome.kind === "self") {
        recordUnread(cfg, store, entry.c, outcome);
        result.skippedSelf++;
        continue;
      }
      if (outcome.kind === "quarantined") {
        result.quarantined++;
        continue;
      }
      if (outcome.kind === "same") {
        // The file moved and the text did not: its new fingerprint is
        // recorded, so the next scan passes it at the cheap gate.
        const earlier = store.getSession(outcome.session.id);
        if (earlier) store.upsertSession({ ...earlier, content_hash: outcome.session.contentHash, source_file: outcome.session.sourceFile });
        result.unchangedText++;
        continue;
      }
      if (outcome.kind === "pending") {
        // The session's own CLI could not answer, and nothing else is allowed
        // to. No note is written; the row says why, and the fingerprint gate
        // lets it through again next time. A session that already has a note
        // from an earlier reading keeps it — a failed re-read is not a reason
        // to demote what was read fine before.
        const s = outcome.session;
        if (outcome.garbled) keepGarbled(cfg.vault, s.id, outcome.garbled);
        const earlier = store.getSession(s.id);
        if (earlier?.status === "ok") {
          unanswered.push(`${s.id}: ${outcome.reason}`);
          result.keptPrevious++;
          continue;
        }
        store.upsertSession({
          id: s.id,
          agent: s.agent,
          source_file: s.sourceFile,
          content_hash: s.contentHash,
          cwd: s.cwd,
          project: outcome.project,
          started_at: s.startedAt,
          processed_at: new Date().toISOString(),
          status: "pending-extraction",
          note_path: null,
          detail: outcome.reason,
        });
        result.pendingExtraction++;
        result.waiting.push({ agent: s.agent, detail: outcome.reason });
        continue;
      }

      const { session, note: raw, usedModel, project } = outcome;
      if (outcome.degradedReason) degraded.push(`${session.id}: ${outcome.degradedReason}`);
      if (outcome.garbled) keepGarbled(cfg.vault, session.id, outcome.garbled);

      const now = new Date().toISOString();
      // The session's date: where its note sits, and where its claims land
      // among everyone else's — in this scan and in every rebuild after it.
      const date = session.startedAt ?? session.endedAt;
      const notePath = sessionNotePath(cfg.vault, date, session.id);
      const previousMd = readFileIfExists(notePath) ?? "";

      // A local note never overwrites a model note. The local extractor
      // claims no facts, and constant 11 already keeps it from retracting
      // any — but writing its note in place of the model's left the facts
      // live in the database and absent from the Markdown, which is the one
      // state `reindex` cannot rebuild. Seen live: a CLI failure on a
      // `--force` re-read turned a five-fact note into an empty local one
      // while all five stayed live. The earlier note stands; the file's new
      // fingerprint is recorded so the next scan does not repeat this.
      if (!usedModel && noteExtractor(previousMd) === "model") {
        const earlier = store.getSession(session.id);
        if (earlier?.status === "ok") {
          store.upsertSession({ ...earlier, source_file: session.sourceFile, content_hash: session.contentHash, processed_at: now, project });
          degraded.push(`${session.id}: ${outcome.degradedReason ?? "محلي"} — بقيت ملاحظة النموذج السابقة`);
          result.keptPrevious++;
          continue;
        }
      }

      for (const a of outcome.anchored) {
        process.stderr.write(`${session.id}: موضوع ${a.from}.${a.key} ← ${a.to}.${a.toKey} (${a.why})\n`);
      }
      result.subjectsAnchored += outcome.anchored.length;

      // The earlier note's trailer: its retractions and its moves ride along
      // into the new note — that file is about to be overwritten, and the
      // trailer is the only place they live.
      const previous = parseFactsTrailer(previousMd);

      // The mapped keys are what the note records — see canonicalizeFacts
      // for why this cannot wait for the replay. Mapped first, too, so a
      // claim is matched to the slot an earlier reading filled by the
      // vault's spelling of its key. Then the moves a human made out of this
      // session's earlier notes: a claim the model files again where it
      // first put it goes where the move put it (applyMoves), before the
      // withdrawals below are worked out — so the moved slot counts as
      // confirmed and the source slot is not reopened.
      const canon = canonicalizeFacts(store, raw.facts);
      for (const r of canon.remapped) process.stderr.write(`${session.id}: مفتاح ${r.subject}.${r.from} ← ${r.to}\n`);
      const placed = applyMoves(previous?.moves ?? [], canon.facts);
      for (const m of placed.moved) process.stderr.write(`${session.id}: نقل مسجّل ${m.from} ← ${m.to}\n`);
      result.movesApplied += placed.moved.length;
      // And what a human confirmed at 1.0 in the earlier note: it outlives a
      // reading that does not repeat it (constant 5), in the note as in the
      // index — see carryConfirmed.
      const carried = carryConfirmed(previous?.facts ?? [], placed.facts);
      for (const f of carried) process.stderr.write(`${session.id}: مثبَّت محمول ${f.subject}.${f.key}\n`);
      result.confirmedCarried += carried.length;
      const note =
        canon.remapped.length || placed.moved.length || carried.length ? { ...raw, facts: [...carried, ...placed.facts] } : raw;

      // A session seen before: whatever its earlier reading claimed and this
      // one does not repeat is withdrawn, and the withdrawal is recorded in
      // the note so the replay below — and every reindex — sees it. A claim
      // this reading words anew under the same key is recorded the same way
      // and filed by the replay as replaced, not withdrawn.
      // Only a reading that could have produced facts gets to withdraw them.
      // The local extractor never claims anything, so its silence is not
      // evidence — a `--force` run with the key unset, or after a folder was
      // walled off, must not quietly retract everything the model once found.
      const earlierNow = usedModel ? retractUnconfirmed(store, session.id, note, now) : [];
      // What the session named outright as no longer true, recorded in the
      // note before its claims so a slot both withdrawn and re-claimed ends up
      // holding the new claim. Keys are taken exactly as named: a missed
      // withdrawal leaves a slot the user can still retract by hand, a
      // remapped one empties the wrong slot. And a session only withdraws
      // what a session no newer than itself said.
      const index = noteIndex();
      const namedNow = usedModel
        ? applyRetractions(
            store,
            raw.retract ?? [],
            session.id,
            now,
            { date, dateOf: (id) => [...index.values()].find((n) => n.sessionId === id)?.date },
            note.facts,
          ).filter((n) => !earlierNow.some((e) => e.subject === n.subject && e.key === n.key && e.claim === n.claim))
        : [];
      const retracted = [...(previous?.retracted ?? []), ...earlierNow, ...namedNow];
      result.factsRetracted += [...earlierNow, ...namedNow].filter((r) => !claimInSlot(note.facts, r.subject, r.key)).length;

      const md = renderSessionNote({
        note,
        sessionId: session.id,
        agent: session.agent,
        sourceFile: session.sourceFile,
        startedAt: date,
        usedModel,
        retracted,
        moves: previous?.moves ?? [],
        distilled: outcome.digest,
      });
      writeFileAtomic(notePath, md);

      store.upsertSession({
        id: session.id,
        agent: session.agent,
        source_file: session.sourceFile,
        content_hash: session.contentHash,
        cwd: session.cwd,
        project,
        started_at: session.startedAt,
        processed_at: now,
        status: "ok",
        note_path: path.relative(cfg.vault, notePath).replace(/\\/g, "/"),
        detail: null,
        resume_json: note.resume ? JSON.stringify(note.resume) : null,
      });

      // The note on disk is now what this session says. Every subject it —
      // or the reading it replaced — mentions is re-derived from all the
      // notes that mention it, in session-date order: rule 1.
      const written = readNote(notePath);
      if (written) index.set(notePath, written);
      const kinds = new Map<string, string>();
      for (const f of [...(previous?.facts ?? []), ...retracted, ...note.facts]) kinds.set(f.subject.trim(), f.subjectKind);
      const subjects = [...kinds.keys()].filter(Boolean);
      const rebased = rebaseSubjects(
        store,
        subjects,
        [...index.values()].filter((n) => subjects.some((s) => noteTouches(n, s))),
        cfg.confidenceFloor,
        now,
      );
      result.factsAdded += rebased.inserted;
      result.factsSuperseded += rebased.superseded;
      result.factsRetracted += rebased.retracted;
      result.factsRestored += rebased.restored;
      result.queued += rebased.queued;
      for (const s of subjects) touched.set(s, kinds.get(s) ?? "term");
      recordLinks(store, note.links, session.id);

      // Index exactly what reindex will index later: the note's prose.
      store.indexNote(session.id, project, note.title, noteProse(md));
      projectsTouched.add(project);
      const dir = projectDirOf(cfg, session.cwd);
      if (dir) projectDirs.set(project, dir);
      result.processed++;
    }
  }

  // A brief offers nothing that cannot work (constant 21), and one already
  // written goes on offering it until something rewrites it — for a project
  // nobody works on, never. After the sessions, so a project whose last
  // session this scan just read is asked about that one.
  for (const d of staleBriefs(cfg, store)) {
    if (d.brief) projectsTouched.add(d.project);
    if (d.dir) projectDirs.set(d.project, d.dir);
    result.briefsRewritten.push(d.project);
  }

  // ---- derived artifacts --------------------------------------------------
  for (const [subject, kind] of touched) writeSubject(cfg.vault, store, subject, kind);
  for (const project of projectsTouched) writeBrief(store, cfg.vault, project, cfg.briefMaxChars);
  if (cfg.briefSync) {
    const sync = syncProjects(cfg, projectDirs);
    result.synced = sync.written;
    result.injectStopped = sync.stopped;
  }
  writeInbox(store, cfg.vault);
  store.setMeta("last_scan", new Date().toISOString());

  if (degraded.length) {
    process.stderr.write(
      `\nتراجَع إلى الاستخلاص المحلي في ${degraded.length} جلسة:\n${degraded
        .slice(0, 5)
        .map((d) => `  ${d}`)
        .join("\n")}\n`,
    );
  }

  if (unanswered.length) {
    process.stderr.write(
      `\nلم يُجب مزوّدها في ${unanswered.length} جلسة لها ملاحظة — لم تُقرأ ثانية، وبقيت ملاحظتها السابقة:\n${unanswered
        .slice(0, 5)
        .map((d) => `  ${d}`)
        .join("\n")}\n`,
    );
  }

  if (result.processed || result.quarantined || result.pendingExtraction || result.briefsRewritten.length) {
    // A partial scan must say so in the vault's own history. Six months on,
    // `git log` is the only record of why one project moved and the rest
    // did not, and "scan:" alone would read as a full pass.
    const scope = [
      opts.onlyProject ? `--project ${opts.onlyProject}` : "",
      opts.onlyAgent ? `--agent ${opts.onlyAgent}` : "",
      opts.onlyFile ? "--file" : "",
      opts.force ? "--force" : "",
      opts.maxChars ? `--max-chars ${opts.maxChars}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const tally =
      `${result.processed} جلسة · +${result.factsAdded} حقيقة · ${result.factsSuperseded} استبدال` +
      (result.factsRetracted ? ` · ${result.factsRetracted} سحب` : "") +
      (result.factsRestored ? ` · ${result.factsRestored} أُعيد بتاريخ الجلسة` : "") +
      (result.pendingExtraction ? ` · ${result.pendingExtraction} تنتظر` : "") +
      (result.leftAtLimit ? ` · توقّف عند الحدّ ${opts.limit}، بقي ${result.leftAtLimit}` : "") +
      (result.briefsRewritten.length ? ` · أُعيد موجز كان يعرض ما لا يعمل: ${result.briefsRewritten.join("، ")}` : "");
    result.commit = git.commit(`scan${scope ? ` ${scope}` : ""}: ${tally}`);
  }
  return result;
}

/**
 * Inject each touched project's brief into the agent files of its folder.
 *
 * Folders that no longer exist are skipped, not created: the brief goes where
 * the project lives, and a deleted project has nowhere to live. Only the
 * files that actually changed come back, which keeps a session-end hook
 * quiet on the days nothing moved. A project whose files git would publish
 * is stopped instead — see injectBrief — and the report comes back with the
 * result: `sila scan` prints it, into hook.log when detached.
 */
export function syncProjects(cfg: Config, projectDirs: Map<string, string>): { written: string[]; stopped: string[] } {
  const written: string[] = [];
  const stopped: string[] = [];
  for (const [project, dir] of projectDirs) {
    if (!injectAllowed(cfg, project)) continue;
    if (!fs.existsSync(dir)) continue;
    const r = injectBrief(cfg, project, dir);
    written.push(...r.written);
    if (r.stopped.length) stopped.push(describeStop(project, r.stopped));
  }
  return { written, stopped };
}

/** A transcript read and set aside — see recordUnread. `hash` is its fingerprint before the read. */
type Unread =
  | { kind: "tiny"; hash: string | null; session: RawSession | null; userChars?: number | undefined }
  | { kind: "self"; hash: string; session: RawSession };

type Prepared =
  | Unread
  | { kind: "filtered" }
  | { kind: "quarantined" }
  | { kind: "same"; session: RawSession }
  | { kind: "pending"; session: RawSession; project: string; reason: string; garbled?: string[] | undefined }
  | {
      kind: "ok";
      session: RawSession;
      note: SessionNote;
      usedModel: boolean;
      project: string;
      /** sha256 of the distilled text the note is read from, for its trailer. */
      digest: string;
      degradedReason?: string | undefined;
      /** Both replies, when neither could be read — see keepGarbled. */
      garbled?: string[] | undefined;
      /** New subjects put back on the project — see anchorSubjects. */
      anchored: Anchored[];
    };

/**
 * Everything that can happen before the database is touched.
 *
 * Kept free of writes so it is safe to run several at once, and so the only
 * ordering-sensitive work — the note and the rebase — stays on the single
 * sequential path.
 */
async function prepare(
  c: Candidate,
  cfg: Config,
  store: Store,
  result: ScanResult,
  wantProject: string | null,
  memoryAsOf: (project: string, date: string, agent: string | null) => MemoryAsOf,
  force: boolean,
  runner?: CliRunner,
): Promise<Prepared> {
  const adapter = adapterFor(c.agent);
  // Only `--agent` can name one there is no adapter for; nothing to record.
  if (!adapter) return { kind: "tiny", hash: null, session: null };

  // Taken before the read: a file that grows while it is read is judged
  // again next time, never passed on what the read did not see.
  const hash = fingerprint(c.file);
  const session = await adapter.parse(c.file);
  if (!session) return { kind: "tiny", hash, session: null };

  // The CLI provider runs each extraction from an empty directory of its own.
  // A CLI that persists sessions anyway leaves a transcript there, and the
  // next scan would find it and extract the extractor. Those are not memories.
  if (session.cwd && canonical(session.cwd) === canonical(neutralCwd())) return { kind: "self", hash, session };

  const project = projectOf(cfg, session.cwd);
  // The gate's probe was advisory; this is the decision, made from the full
  // parse. A file the probe could not place ends here if it belongs elsewhere.
  if (wantProject && slug(project) !== wantProject) return { kind: "filtered" };

  const distilled = distill(session, cfg.distillMaxChars);
  // A session where the user barely typed carries no intent to remember. The
  // agent's own output is not evidence of anything worth keeping.
  if (distilled.userChars < cfg.minUserChars) return { kind: "tiny", hash, session, userChars: distilled.userChars };

  const digest = sha256(distilled.text);
  if (!force && sameText(cfg, store, session.id, digest)) return { kind: "same", session };

  // The security barrier. Nothing below this line may reach the network
  // before redact() has both rewritten the text and re-verified its own work.
  const redaction = redact(distilled.text);
  if (!redaction.safe) {
    const reason = redaction.findings.map((f) => `${f.kind}×${f.count}`).join(", ");
    store.quarantine(session.id, session.sourceFile, reason);
    store.upsertSession({
      id: session.id,
      agent: session.agent,
      source_file: session.sourceFile,
      content_hash: session.contentHash,
      cwd: session.cwd,
      project,
      started_at: session.startedAt,
      processed_at: new Date().toISOString(),
      status: "quarantined",
      note_path: null,
      detail: reason,
    });
    return { kind: "quarantined" };
  }

  // Per-run budget only. Enforcing a true daily ceiling needs the spend table
  // that cost tracking will add; until then a fresh run starts a fresh count,
  // which is stated rather than pretended otherwise.
  const budgetLeft = cfg.extractor.dailyCallLimit === 0 || result.modelCalls < cfg.extractor.dailyCallLimit;
  const useModel = mayUseNetwork(cfg, session.cwd) && budgetLeft;
  if (useModel) result.modelCalls++;
  // Only when a model will read it. The local extractor claims nothing, so
  // handing it the vault's facts would cost a read for no possible use.
  // And only what was known before this session's date: see liveFactsAsOf.
  // A tool's facts from other projects only under a same-provider wall: the
  // CLI is then known, and it is the one that read those sessions.
  const memory = useModel
    ? memoryAsOf(project, session.startedAt ?? session.endedAt, sameProviderFor(cfg, session.cwd) ? session.agent : null)
    : null;
  // What the guard asks of a subject, and what decides what the model is
  // shown: a folder of the project is a part of it, not an entity.
  const folders = memory ? projectFolders(projectDirOf(cfg, session.cwd)) : [];

  const extracted = await extractNote({
    session,
    distilled,
    redactedText: redaction.text,
    cfg,
    useModel,
    sameProvider: sameProviderFor(cfg, session.cwd),
    context: memory ? factsContext(memory.facts, project, undefined, folders, definitionsFor(cfg), redaction.text) : "",
    ...(runner ? { runner } : {}),
  });

  if (extracted.pending) return { kind: "pending", session, project, reason: extracted.pending, garbled: extracted.garbled };

  if (extracted.usage) {
    const who = extracted.usage.cli ?? "api";
    for (const tally of [result.usage, (result.usageBy[who] ??= emptyTally(extracted.usage.model))]) {
      tally.inputTokens += extracted.usage.inputTokens;
      tally.outputTokens += extracted.usage.outputTokens;
      tally.cacheReadTokens += extracted.usage.cacheReadTokens;
      tally.cacheWriteTokens += extracted.usage.cacheWriteTokens;
      tally.costUsd += extracted.usage.costUsd ?? 0;
      tally.calls += extracted.calls ?? 1;
    }
    // A garbled reply asked for again spent a call of the budget too.
    result.modelCalls += (extracted.calls ?? 1) - 1;
  }

  // Defence in depth: the note is scrubbed on the way in, even though the text
  // it was built from was already clean. The model can echo, and the local
  // extractor quotes the user verbatim.
  //
  // The resume block is assembled here, not by the extractor: the model owns
  // "where" and "next", the adapter owns the paths it saw and the command
  // that reopens the session, and only this point sees all three.
  const note = scrubNote({
    ...extracted.note,
    project,
    resume: {
      where: extracted.note.resume?.where ?? "",
      next: extracted.note.resume?.next ?? "",
      files: selectResumeFiles(session.files, mtimeOrZero),
      resumeCommand: adapter.resumeCommand(session),
    },
  });

  // A new subject named like a file, a class or a ticket goes back to the
  // project it is part of, before the note records it.
  const anchoring = memory ? anchorSubjects(note.facts, project, memory.subjects, folders) : { facts: note.facts, anchored: [] };

  return {
    kind: "ok",
    session,
    note: { ...note, facts: anchoring.facts },
    usedModel: extracted.usedModel,
    project,
    digest,
    degradedReason: extracted.degradedReason,
    garbled: extracted.garbled,
    anchored: anchoring.anchored,
  };
}

/**
 * Whether a session's note was read from exactly this distilled text.
 *
 * The file fingerprint — size and mtime — is the cheap gate and stays first:
 * it lets an untouched transcript through without a read. But a file can
 * change without its session changing. The Codex app appends a
 * `thread_settings_applied` record to a thread whenever it is opened, and the
 * 25 September session grew 2,678 bytes on 2026-09-26 while its turns, and
 * the text distilled from them, stayed byte-identical: a paid call for
 * nothing, on every visit to an old thread. What the model would be sent is
 * the measure — the same text is the same reading.
 *
 * The digest is read from the note's trailer, not the index (constant 3): a
 * rebuilt index remembers no fingerprints, and this is what keeps the scan
 * after `reindex` from sending every transcript to the model again. Only a
 * note that is the session's reading by the model counts — a pending or
 * quarantined row is tried again whatever its text, and a local note may be
 * read by the model now that it could not be then. An inferred digest counts
 * too — see InferredDigest: it says the text was this at the last reading, as
 * far as we know, which is the question asked here.
 */
function sameText(cfg: Config, store: Store, sessionId: string, digest: string): boolean {
  const row = store.getSession(sessionId);
  if (row?.status !== "ok" || !row.note_path) return false;
  const md = readFileIfExists(path.join(cfg.vault, row.note_path));
  if (md === null || noteExtractor(md) !== "model") return false;
  const trailer = parseFactsTrailer(md);
  return trailer?.distilled === digest || trailer?.distilledInferred?.sha256 === digest;
}

/**
 * A transcript read and set aside, recorded so the next scan does not read it
 * again — `empty` for one too short to read, `skipped` for the extractor's own.
 *
 * Without a row neither ever passed the cheap gate: each was parsed on every
 * scan and took a `--limit` seat doing it, 35 of every 100 on 2026-09-30 (16
 * files with no turn in them, 6 under the threshold, 13 of the extractor's
 * own). Now each is read once per change of its file. A short one carries the
 * threshold it fell under, and a changed `minUserChars` judges it again — a
 * verdict made under one threshold says nothing under another (the user's
 * rule, 2026-10-01). One with no turn in it carries none: no threshold makes
 * it readable.
 *
 * Keyed by its session id; a file that yields no session has none, and is
 * keyed by its path. A row that says more is never overwritten: a session
 * read before keeps its note and its row though its text now falls under a
 * raised threshold, and a wait or a quarantine stays what it is. The price of
 * the rows: they have no note, so `reindex` does not bring them back, and the
 * first scan after it reads each of these once.
 */
function recordUnread(cfg: Config, store: Store, c: Candidate, u: Unread): void {
  if (u.hash === null) return;
  const s = u.session;
  const id = s?.id ?? `${c.agent}:${c.file}`;
  const earlier = store.getSession(id);
  if (earlier && earlier.status !== "empty" && earlier.status !== "skipped") return;
  const judged = u.kind === "tiny" && u.userChars !== undefined;
  store.upsertSession({
    id,
    agent: c.agent,
    source_file: c.file,
    content_hash: u.hash,
    cwd: s?.cwd ?? null,
    project: projectOf(cfg, s?.cwd ?? null),
    started_at: s?.startedAt ?? null,
    processed_at: new Date().toISOString(),
    status: u.kind === "self" ? "skipped" : "empty",
    note_path: null,
    detail:
      u.kind === "self"
        ? "جلسة المستخلِص نفسه"
        : judged
          ? `${u.userChars} حرفاً من المستخدم، تحت الحدّ ${cfg.minUserChars}`
          : "لا دور فيها يُقرأ",
    min_user_chars: judged ? cfg.minUserChars : null,
  });
}

/**
 * The replies a reading could not read, kept where a person can look.
 *
 * A garbled reply left no trace: twice in a row for 461b6fab on 2026-09-23,
 * at two different places, and nothing to tell a cut-off answer from a stray
 * quote. Each is written to `.index/garbled/`, which git ignores, after the
 * redactor — it is model output about a session, and nothing enters the
 * vault unredacted (constant 4); one the redactor cannot vouch for is
 * withheld and the file says so.
 */
function keepGarbled(vault: string, sessionId: string, replies: string[]): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  replies.forEach((text, i) => {
    const file = path.join(vault, ".index", "garbled", `${slug(sessionId)}-${stamp}-${i + 1}.txt`);
    const r = redact(text);
    writeFileAtomic(file, r.safe ? r.text : `محجوب: ${r.findings.map((f) => `${f.kind}×${f.count}`).join(", ")}\n`);
    process.stderr.write(`${sessionId}: حُفظ الرد ${i + 1} في ${path.relative(vault, file)}\n`);
  });
}

/**
 * The live facts a reading is shown: its project's, and a defined tool's from
 * any project.
 *
 * A tool crosses projects by definition — its gotcha shows up with the tool
 * anywhere — and by the user's call, 2026-09-24: three of the first drifts
 * were in tooling, and a reading in one project never saw tooling's facts
 * from another. Only those another reading by the same agent made, and only
 * when there is an agent to match (a same-provider wall): that session's CLI
 * is this session's CLI, so no provider sees what it had not (constant 12).
 * `agent` null — a wall that may try several CLIs — shows the project's own.
 */
export function offeredFacts<T extends { subject: string; session_id: string }>(
  live: readonly T[],
  ours: ReadonlySet<string>,
  agent: string | null,
  tools: ReadonlySet<string>,
): T[] {
  return live.filter((f) => ours.has(f.session_id) || (agent !== null && tools.has(f.subject) && f.session_id.startsWith(`${agent}:`)));
}

export interface RejectedSubject {
  subject: string;
  kind: string;
  /** The project whose sessions filed these facts, and whose extractor no longer sees them. */
  project: string;
  facts: number;
  why: AnchorReason;
}

/**
 * Live subjects the guard would reject if they were new — per project,
 * because a folder of one project is not a folder of another.
 *
 * Each is hidden from its project's extractor (factsContext), so no session
 * can supersede or withdraw its facts; `sila move` is the way out. A rule
 * made stricter later turns a live subject into one of these without a
 * word: the folder rule, on 2026-09-23, hid one subject that was the whole
 * memory of its project. `sila doctor` prints them so that is seen.
 *
 * A project's folders come from one of its sessions' cwd, or from the wall
 * of its name when the index has no cwd (a rebuilt one).
 */
export function rejectedLiveSubjects(cfg: Config, store: Store): RejectedSubject[] {
  const rows = store.db
    .prepare(
      `SELECT f.subject, f.subject_kind AS kind, s.project, s.cwd
         FROM facts f JOIN sessions s ON s.id = f.session_id
        WHERE f.superseded_by IS NULL AND f.retracted_at IS NULL`,
    )
    .all() as Array<{ subject: string; kind: string; project: string; cwd: string | null }>;
  const folders = new Map<string, string[]>();
  const foldersOf = (project: string): string[] => {
    let f = folders.get(project);
    if (!f) {
      const cwd = rows.find((r) => r.project === project && r.cwd)?.cwd ?? null;
      const dir = cwd ? projectDirOf(cfg, cwd) : (cfg.walls.find((w) => w.name === project)?.paths[0] ?? null);
      f = projectFolders(dir);
      folders.set(project, f);
    }
    return f;
  };
  const out = new Map<string, RejectedSubject>();
  for (const r of rows) {
    if (r.subject === r.project) continue;
    const why = partOfProject(r.subject, r.kind, foldersOf(r.project));
    if (!why) continue;
    const k = `${r.subject}\u0000${r.project}`;
    const hit = out.get(k) ?? { subject: r.subject, kind: r.kind, project: r.project, facts: 0, why };
    hit.facts++;
    out.set(k, hit);
  }
  return [...out.values()].sort((a, b) => b.facts - a.facts || a.subject.localeCompare(b.subject));
}

export interface UndefinedTool {
  subject: string;
  facts: number;
  /** The projects whose sessions filed its facts, and whose extractors no longer see it. */
  projects: string[];
}

/**
 * Live tool subjects with no line that says what they admit.
 *
 * Hidden from every extractor, name and facts (factsContext), so no session
 * can supersede or withdraw them until a definition is written or they are
 * moved — said by `sila doctor`, as rejectedLiveSubjects is. One the guard
 * rejects already (a path) is left to that list.
 */
export function undefinedLiveTools(cfg: Config, store: Store): UndefinedTool[] {
  const defs = definitionsFor(cfg);
  const rows = store.db
    .prepare(
      `SELECT f.subject, s.project
         FROM facts f JOIN sessions s ON s.id = f.session_id
        WHERE f.superseded_by IS NULL AND f.retracted_at IS NULL AND f.subject_kind = 'tool'`,
    )
    .all() as Array<{ subject: string; project: string }>;
  const out = new Map<string, UndefinedTool>();
  for (const r of rows) {
    if (r.subject === r.project || defs[r.subject]?.trim() || partOfProject(r.subject, "tool") !== null) continue;
    const hit = out.get(r.subject) ?? { subject: r.subject, facts: 0, projects: [] };
    hit.facts++;
    if (!hit.projects.includes(r.project)) hit.projects.push(r.project);
    out.set(r.subject, hit);
  }
  return [...out.values()].sort((a, b) => b.facts - a.facts || a.subject.localeCompare(b.subject));
}

/**
 * The folders at the root of a project, by name. Hidden ones (.git, .claude)
 * are not what a session calls a subject; a project that is gone, or has no
 * folder on this machine, has none.
 */
function projectFolders(dir: string | null): string[] {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** A path that is gone sorts last among resume files rather than failing the note. */
function mtimeOrZero(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The two files that ask something of the user.
 *
 * Regenerated whole on every scan rather than appended to, so an item that has
 * been decided disappears from the list instead of accumulating forever.
 */
export function writeInbox(store: Store, vault: string): void {
  const pending = store.db
    .prepare(
      `SELECT id, subject, subject_kind, key, claim, confidence, reason, session_id, created_at
         FROM pending WHERE status = 'waiting' ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: number;
    subject: string;
    key: string;
    claim: string;
    confidence: number;
    reason: string;
    session_id: string;
    created_at: string;
  }>;

  // A wait whose transcript has gone will not be tried again; it is said apart.
  const rows = store.pendingExtractions();
  const waiting = rows.filter((r) => !transcriptGone(r));
  const gone = rows.filter(transcriptGone);

  const pendingMd = [
    "# ينتظر قرارك",
    "",
    pending.length
      ? "`sila accept <id>` يثبّتها بثقة كاملة · `sila reject <id>` يرفضها."
      : "_لا شيء ينتظر._",
    "",
    ...pending.flatMap((p) => [
      `## [${p.id}] ${p.subject}.${p.key}`,
      "",
      p.claim,
      "",
      `- الثقة: ${p.confidence.toFixed(2)}`,
      `- السبب: ${p.reason}`,
      `- الجلسة: ${p.session_id}`,
      `- التاريخ: ${p.created_at.slice(0, 10)}`,
      "",
    ]),
    ...(waiting.length
      ? [
          "# جلسات تنتظر استخلاصها",
          "",
          "_بجدار same-provider: لا تُلخَّص إلا بـCLI وكيلها، ولا بديل. تُعاد في المسح التالي تلقائياً._",
          "",
          ...waiting.map((w) => `- \`${w.id}\` — ${w.detail ?? ""}  <sub>${w.processed_at.slice(0, 10)}</sub>`),
          "",
        ]
      : []),
    ...(gone.length
      ? [
          "# جلسات معلّقة نصّها مفقود",
          "",
          "_ليست تنتظر: نصّها ذهب من القرص، والمسح لا يرى إلا ما عليه، فلن تُعاد ولن تُقرأ._",
          "",
          ...gone.map((g) => `- \`${g.id}\` — نصّها مفقود: ${g.source_file || "(لا مسار مسجَّل)"}  <sub>${g.processed_at.slice(0, 10)}</sub>`),
          "",
        ]
      : []),
  ].join("\n");
  writeFileAtomic(path.join(paths(vault).inbox, "pending.md"), pendingMd);

  const quarantined = store.db
    .prepare("SELECT session_id, source_file, reason, created_at FROM quarantine ORDER BY created_at DESC")
    .all() as Array<{ session_id: string; source_file: string; reason: string; created_at: string }>;

  const quarantineMd = [
    "# محجوب — لم يُرسل ولم يُخزَّن",
    "",
    quarantined.length
      ? "هذه الجلسات طابقت قواعد حجب لم يستطع المحرّر إزالتها بثقة، فلم تُعالَج أصلاً. راجعها بنفسك."
      : "_لا شيء محجوب._",
    "",
    ...quarantined.map(
      (q) => `- \`${q.session_id}\` — ${q.reason}\n  ${q.source_file}  <sub>${q.created_at.slice(0, 10)}</sub>`,
    ),
    "",
  ].join("\n");
  writeFileAtomic(path.join(paths(vault).inbox, "quarantine.md"), quarantineMd);
}
