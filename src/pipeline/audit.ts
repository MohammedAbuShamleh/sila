import path from "node:path";
import type { Config } from "../config.js";
import { Store, transcriptGone, type FactRow } from "../store/db.js";
import { Git } from "../store/git.js";
import { claimInSlot, paths, readAllNotes, type NoteRecord } from "../store/vault.js";
import { indexable } from "../util/arabic.js";
import { writeFileAtomic } from "../util/fsatomic.js";
import { acquireLock } from "../util/lock.js";
import { equivalent, sameKey } from "./reconcile.js";
import { rejectedLiveSubjects, undefinedLiveTools, type RejectedSubject, type UndefinedTool } from "./run.js";

/**
 * `sila audit` — the weekly reading, with no model and no human judgement in it.
 *
 * Every defect this project found so far was found by looking: a slot taken by
 * a different claim, a key that drifted six minutes after its twin, a subject
 * the guard started rejecting and silently stopped showing anyone. Looking does
 * not scale — 354 live slots across 14 subjects is already past what an eye
 * catches — so each of those classes is written here as a mechanical check over
 * what the vault already holds. No call to the model, no reading of a
 * transcript, no cost.
 *
 * It reports and stops. Not one of these findings is safe to act on
 * automatically: a near-key pair may be two real facts (`tender-delete`
 * against `tender-items`), an unmentioned live row may be a note somebody
 * put back by hand, a stale fact may simply still be true. The whole value is
 * in naming them for a human — the same judgement `sila doctor` asks for, on a
 * wider surface. Which is also why the report is a file in the vault rather
 * than only stdout: it commits, so next week's reading can be diffed against
 * this one.
 */

/** How the index and the notes disagree about a live row. */
export type OrphanWhy = "no-note" | "not-claimed" | "reworded";

export interface OrphanFact {
  subject: string;
  key: string;
  claim: string;
  sessionId: string;
  confidence: number;
  createdAt: string;
  why: OrphanWhy;
  /** What the note says in that slot instead, when it says something. */
  noteClaim?: string;
}

/** Which signal made two live keys of one subject look like one slot. */
export type NearWhy = "same-key" | "key-subset" | "key-same-noun" | "claim-overlap";

export interface NearPair {
  subject: string;
  a: { key: string; claim: string; sessionId: string };
  b: { key: string; claim: string; sessionId: string };
  why: NearWhy;
  /** The words both claims use, for `claim-overlap`. */
  shared?: string[];
}

export interface StaleFact {
  subject: string;
  key: string;
  claim: string;
  /** Session date of the newest note that still claims this slot. */
  lastSeen: string;
  /** Days since that note's session. */
  age: number;
  project: string;
  /** Session date of the project's newest session, and how long ago that was. */
  projectLast: string;
  projectAge: number;
}

export interface StalePending {
  sessionId: string;
  agent: string;
  detail: string;
  /** When the session itself ran — what the wait is measured from. */
  startedAt: string;
  /** When the scan last tried it. Every scan retries, so this is never old. */
  processedAt: string;
  age: number;
}

/** A session that was waiting for its CLI when its transcript went — see stalePending. */
export interface GonePending {
  sessionId: string;
  agent: string;
  startedAt: string;
  processedAt: string;
  sourceFile: string;
}

export interface AuditReport {
  /** The day the audit ran. A date, not a moment: two runs on one quiet day leave the file byte-identical, so there is nothing to commit. */
  day: string;
  days: number;
  pendingDays: number;
  orphans: OrphanFact[];
  near: NearPair[];
  rejected: RejectedSubject[];
  undefinedTools: UndefinedTool[];
  stale: StaleFact[];
  pending: StalePending[];
  /** Waits whose transcript has gone, at any age: not waiting, lost. */
  gone: GonePending[];
  /** What was looked at, so an empty report can be told from an empty vault. */
  scanned: { facts: number; notes: number; subjects: number };
}

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.floor((b - a) / DAY_MS);
}

/** Lower-case words of a key's noun part, split at case humps and at anything that is not a letter or digit. */
function keyWords(noun: string): string[] {
  return noun
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter(Boolean);
}

function keyParts(key: string): { prefix: string; words: string[] } {
  const dot = key.indexOf(".");
  return dot > 0
    ? { prefix: key.slice(0, dot).toLowerCase(), words: keyWords(key.slice(dot + 1)) }
    : { prefix: "", words: keyWords(key) };
}

/** Words of a claim worth comparing: normalized as search normalizes, and long enough not to be a function word. */
function claimWords(claim: string): Set<string> {
  return new Set(indexable(claim).split(" ").filter((w) => w.length >= 4));
}

/**
 * Whether two live keys of one subject look like one slot — the drift check,
 * as it was run by hand on 2026-09-24, in code.
 *
 * Four signals, strongest first, each of them mechanical:
 *
 *   same-key       `sameKey` calls them one slot, yet both are live. Only a
 *                  vault older than constant 14 can hold such a pair.
 *   key-subset     Same prefix, and one's words are all of the other's:
 *                  `gotcha.git` inside `gotcha.git-diff-pathspec`, three of
 *                  the six drifts seen.
 *   key-same-noun  Same words under different prefixes:
 *                  `decision.tender-minimum` against `arch.*`, the second.
 *   claim-overlap  The keys share nothing but the claims do — the fifth drift,
 *                  `gotcha.claude-cli-shell` against `gotcha.tinker`, which no
 *                  reading of the keys could have caught.
 *
 * Deliberately not a judgement: `arch.tender-delete` and
 * `arch.tender-items` are two slots, and this reports them as a pair to look
 * at, not as one to merge. Constant 14 stands — the merge is the user's, by
 * hand, through `sila move`.
 */
export function nearWhy(
  a: { key: string; claim: string },
  b: { key: string; claim: string },
): { why: NearWhy; shared?: string[] } | null {
  if (sameKey(a.key, b.key)) return { why: "same-key" };
  const x = keyParts(a.key);
  const y = keyParts(b.key);
  const sx = new Set(x.words);
  const sy = new Set(y.words);
  const same = sx.size === sy.size && [...sx].every((w) => sy.has(w));
  if (x.prefix === y.prefix && x.words.length && y.words.length && !same) {
    const subset = [...sx].every((w) => sy.has(w)) || [...sy].every((w) => sx.has(w));
    if (subset) return { why: "key-subset" };
  }
  if (x.prefix !== y.prefix && same && sx.size) return { why: "key-same-noun" };
  const wa = claimWords(a.claim);
  const wb = claimWords(b.claim);
  const shared = [...wa].filter((w) => wb.has(w));
  const smaller = Math.min(wa.size, wb.size);
  // Four shared words, and a third of the shorter claim. Both numbers were
  // measured on the real vault (361 live slots, 2026-09-25) rather than
  // guessed: at three, seven of the 25 pairs were a short claim against
  // a project's `stack.db` — any two short claims about one table share three words
  // — and the two pairs that are known drift share six and five, so four
  // drops the noise with margin. The ratio cannot go above a third without
  // losing them (0.38 and 0.42). This is the weakest of the four signals and
  // the reason the section is a list to skim, not a list of defects.
  if (shared.length >= 4 && smaller > 0 && shared.length / smaller >= 1 / 3) return { why: "claim-overlap", shared };
  return null;
}

const NEAR_RANK: Record<NearWhy, number> = { "same-key": 0, "key-subset": 1, "key-same-noun": 2, "claim-overlap": 3 };

/**
 * Live rows no note stands behind.
 *
 * Markdown is the source and SQLite is derived (constant 3), so a live row
 * whose note does not claim it is a row the next `sila reindex` loses. Three
 * shapes, and each one has been seen: a note deleted or reverted by hand
 * (`no-note`), `sila accept` writing confidence into the index alone
 * (`not-claimed` — the standing defect), and an index built before a rule
 * changed, whose slot the note now words differently (`reworded`).
 *
 * The row's own session is what is asked, not any note: a claim is filed
 * under the session that made it, and that session's note is the record of it.
 */
export function orphanFacts(live: readonly FactRow[], notes: readonly NoteRecord[]): OrphanFact[] {
  const byId = new Map<string, NoteRecord>();
  for (const n of notes) byId.set(n.sessionId.trim(), n);
  const out: OrphanFact[] = [];
  for (const f of live) {
    const note = byId.get(f.session_id.trim());
    const row = {
      subject: f.subject,
      key: f.key,
      claim: f.claim,
      sessionId: f.session_id,
      confidence: f.confidence,
      createdAt: f.created_at,
    };
    if (!note) {
      out.push({ ...row, why: "no-note" });
      continue;
    }
    const held = claimInSlot(note.facts, f.subject, f.key);
    if (!held) out.push({ ...row, why: "not-claimed" });
    else if (!equivalent(held.claim, f.claim)) out.push({ ...row, why: "reworded", noteClaim: held.claim });
  }
  return out;
}

/** Every pair of live slots of one subject that looks like one slot. See nearWhy. */
export function nearKeys(live: readonly FactRow[]): NearPair[] {
  const bySubject = new Map<string, FactRow[]>();
  for (const f of live) {
    const list = bySubject.get(f.subject) ?? [];
    list.push(f);
    bySubject.set(f.subject, list);
  }
  const out: NearPair[] = [];
  for (const [subject, facts] of bySubject) {
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i]!;
        const b = facts[j]!;
        // Two live rows in one slot are not two keys — that divergence is the
        // orphan check's, and pairing a slot with itself would bury the report.
        if (a.key === b.key) continue;
        const hit = nearWhy(a, b);
        if (!hit) continue;
        out.push({
          subject,
          a: { key: a.key, claim: a.claim, sessionId: a.session_id },
          b: { key: b.key, claim: b.claim, sessionId: b.session_id },
          why: hit.why,
          ...(hit.shared ? { shared: hit.shared } : {}),
        });
      }
    }
  }
  return out.sort(
    (p, q) => NEAR_RANK[p.why] - NEAR_RANK[q.why] || p.subject.localeCompare(q.subject) || p.a.key.localeCompare(q.a.key),
  );
}

/**
 * Live claims no note has restated for `days`, in a project still being worked
 * on.
 *
 * Not a defect by itself — most of what memory is for is exactly the fact
 * nobody restates. What makes a pair of dates worth printing is the gap: the
 * project has had sessions since, and none of them said this. That is where a
 * claim that quietly stopped being true sits, and nothing in the engine can
 * tell one from a claim that simply held.
 *
 * `lastSeen` is the newest note that claims the slot, not the row's
 * `created_at`: a re-read that says the same thing again is a confirmation,
 * and the rebase leaves the row's date where the first reading put it. A claim
 * a human confirmed at 1.0 is skipped — it is immune by constant 5, and
 * nothing a session does or does not say bears on it.
 */
export function staleFacts(
  store: Store,
  live: readonly FactRow[],
  notes: readonly NoteRecord[],
  now: string,
  days: number,
): StaleFact[] {
  const lastSeen = new Map<string, string>();
  for (const n of notes) {
    for (const f of n.facts) {
      const slot = `${f.subject.trim()}\u0000${f.key.trim()}`;
      const prev = lastSeen.get(slot);
      if (!prev || n.date > prev) lastSeen.set(slot, n.date);
    }
  }
  const projectLast = new Map<string, string>(
    (
      store.db
        .prepare(
          `SELECT project, MAX(COALESCE(started_at, processed_at)) AS last
             FROM sessions WHERE status = 'ok' GROUP BY project`,
        )
        .all() as Array<{ project: string; last: string | null }>
    )
      .filter((r): r is { project: string; last: string } => !!r.last)
      .map((r) => [r.project, r.last]),
  );
  const subjectProjects = new Map<string, string[]>();
  const out: StaleFact[] = [];
  // One line per slot. An index holding two live rows for one slot is a
  // divergence the orphan check reports; saying the slot twice here would only
  // make its age harder to read, and which of the two claims is shown then
  // does not matter — both are that slot's.
  const done = new Set<string>();
  for (const f of live) {
    if (f.confidence >= 1) continue;
    const slot = `${f.subject}\u0000${f.key}`;
    if (done.has(slot)) continue;
    const seen = lastSeen.get(slot) ?? f.created_at;
    const age = daysBetween(seen, now);
    if (age < days) continue;
    let projects = subjectProjects.get(f.subject);
    if (!projects) {
      projects = store.projectsOf(f.subject);
      subjectProjects.set(f.subject, projects);
    }
    // A tool's facts belong to every project that met it, so the liveliest of
    // them is what says whether anyone is still in a position to restate this.
    let best: { project: string; last: string } | null = null;
    for (const p of projects) {
      const last = projectLast.get(p);
      if (last && (!best || last > best.last)) best = { project: p, last };
    }
    if (!best) continue;
    const projectAge = daysBetween(best.last, now);
    if (projectAge > days) continue;
    out.push({
      subject: f.subject,
      key: f.key,
      claim: f.claim,
      lastSeen: seen,
      age,
      project: best.project,
      projectLast: best.last,
      projectAge,
    });
    done.add(slot);
  }
  return out.sort((a, b) => b.age - a.age || a.subject.localeCompare(b.subject) || a.key.localeCompare(b.key));
}

/**
 * Sessions still waiting for their own agent's CLI after `days`.
 *
 * Under a same-provider wall a session is only ever summarized by the CLI that
 * produced it, and there is no fallback (constant 12): a missing CLI means the
 * session waits, and waits silently, in the next scan and every scan after it.
 * Ten codex sessions in the real vault have waited since April and May. A week
 * is long enough to mean the CLI is not coming back on its own.
 *
 * The wait is measured from the session's own date, not from `processed_at`:
 * every scan retries a pending session and writes the attempt into that
 * column, so the ten that have waited five months all looked like they were
 * processed minutes ago — the first run of this check on the real vault
 * reported none of them. `processed_at` is still shown, as the last attempt.
 *
 * A session whose transcript has gone is not here: it is not waiting, since
 * no scan will find it to try again (see gonePending).
 */
export function stalePending(store: Store, now: string, days: number): StalePending[] {
  return store
    .pendingExtractions()
    .filter((s) => !transcriptGone(s))
    .map((s) => ({
      sessionId: s.id,
      agent: s.agent,
      detail: s.detail ?? "",
      startedAt: s.started_at ?? s.processed_at,
      processedAt: s.processed_at,
      age: daysBetween(s.started_at ?? s.processed_at, now),
    }))
    .filter((s) => s.age >= days)
    .sort((a, b) => b.age - a.age);
}

/**
 * Sessions that were waiting for their CLI when their transcript went.
 *
 * Named apart from the waits, and at any age: a scan sees only what is on
 * disk, so it never meets one of these again, and a week of waiting would
 * only have hidden for a week that nothing is coming. There is no note to
 * lose — a wait has none — and nothing to run.
 */
export function gonePending(store: Store): GonePending[] {
  return store
    .pendingExtractions()
    .filter(transcriptGone)
    .map((s) => ({
      sessionId: s.id,
      agent: s.agent,
      startedAt: s.started_at ?? s.processed_at,
      processedAt: s.processed_at,
      sourceFile: s.source_file,
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId));
}

/** The five checks over one open store. No writing, no model, no network. */
export function auditReport(
  cfg: Config,
  store: Store,
  opts: { now?: string; days?: number; pendingDays?: number } = {},
): AuditReport {
  const now = opts.now ?? new Date().toISOString();
  const days = opts.days ?? 60;
  const pendingDays = opts.pendingDays ?? 7;
  const notes = readAllNotes(cfg.vault);
  const live = store.allLiveFacts();
  return {
    day: now.slice(0, 10),
    days,
    pendingDays,
    orphans: orphanFacts(live, notes),
    near: nearKeys(live),
    rejected: rejectedLiveSubjects(cfg, store),
    undefinedTools: undefinedLiveTools(cfg, store),
    stale: staleFacts(store, live, notes, now, days),
    pending: stalePending(store, now, pendingDays),
    gone: gonePending(store),
    scanned: { facts: live.length, notes: notes.length, subjects: new Set(live.map((f) => f.subject)).size },
  };
}

const WHY_AR: Record<OrphanWhy, string> = {
  "no-note": "لا ملاحظة لجلستها في المخزن",
  "not-claimed": "ملاحظة جلستها لا تدّعي الخانة",
  reworded: "ملاحظة جلستها تقول غير ما يقوله الفهرس",
};

const NEAR_AR: Record<NearWhy, string> = {
  "same-key": "مفتاحان يعدّهما sameKey خانة واحدة وكلاهما حيّ",
  "key-subset": "نفس البادئة، وكلمات أحدهما كلها في الآخر",
  "key-same-noun": "نفس الكلمات تحت بادئتين",
  "claim-overlap": "المفتاحان مختلفان والادعاءان يتشاركان كلماتهما",
};

const REASON_AR: Record<string, string> = {
  spelling: "تهجئة أخرى لموضوع حيّ",
  file: "اسم ملف أو اسم منقّط",
  class: "اسم كلاس",
  ticket: "رقم بند أو تذكرة",
  folder: "مجلد في جذر المشروع",
};

/**
 * The report as the user reads it: every finding with what to do about it, and
 * an explicit line saying nothing was changed. A section with no findings still
 * prints its heading with «لا شيء ✓» — an audit whose silence cannot be told
 * from an audit that did not run is worth nothing.
 */
/** A claim trimmed to what makes it recognizable; the subject file keeps the whole of it. */
function short(claim: string, max = 160): string {
  const one = claim.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function renderAudit(r: AuditReport): string {
  const total =
    r.orphans.length + r.near.length + r.rejected.length + r.undefinedTools.length + r.stale.length + r.pending.length + r.gone.length;
  const out: string[] = [
    "# فحص المخزن",
    "",
    `_${r.day} · ${r.scanned.facts} حقيقة حيّة · ${r.scanned.subjects} موضوعاً · ${r.scanned.notes} ملاحظة · ${total} ملاحظة للمراجعة_`,
    "",
    "بلا نموذج وبلا شبكة، وبلا إصلاح آلي: كل بند أدناه حكمه لك. الأوامر مذكورة تحت كل قسم.",
    "",
  ];

  const section = (heading: string, n: number, lines: string[], hint?: string) => {
    out.push(`## ${heading}`, "");
    if (!n) {
      out.push("لا شيء ✓", "");
      return;
    }
    out.push(...lines, "");
    if (hint) out.push(hint, "");
  };

  section(
    `حقائق حيّة لا تذكرها ملاحظة — ${r.orphans.length}`,
    r.orphans.length,
    r.orphans.map((o) =>
      [
        `- \`${o.subject}.${o.key}\` — ${short(o.claim)} _(${o.confidence.toFixed(2)} · ${o.sessionId})_`,
        `  - ${WHY_AR[o.why]}`,
        ...(o.noteClaim ? [`  - الملاحظة: ${short(o.noteClaim)}`] : []),
      ].join("\n"),
    ),
    "الملاحظات هي المصدر، فهذه الصفوف تفقدها إعادة البناء: `sila rebase` يطابق الفهرس مع الملاحظات، و`sila restore` يعيد ما سُحب خطأً.",
  );

  section(
    `مفاتيح متقاربة تحت موضوع واحد — ${r.near.length}`,
    r.near.length,
    r.near.map((p) =>
      [
        `- **${p.subject}** · \`${p.a.key}\` ↔ \`${p.b.key}\` — ${NEAR_AR[p.why]}`,
        `  - ${short(p.a.claim)} _(${p.a.sessionId})_`,
        `  - ${short(p.b.claim)} _(${p.b.sessionId})_`,
        ...(p.shared?.length ? [`  - كلمات مشتركة: ${p.shared.join("، ")}`] : []),
      ].join("\n"),
    ),
    "قد يكونا خانتين حقيقيتين (`tender-delete` و`tender-items`) — القرار بالعين. إن كانا واحدة: `sila move --plan` أو `sila retract`.",
  );

  const guard = r.rejected.length + r.undefinedTools.length;
  section(
    `مواضيع لا يراها أي مستخلص — ${guard}`,
    guard,
    [
      ...r.rejected.map(
        (s) => `- \`${s.subject}\` (${s.kind}) · ${s.facts} حقيقة · ${s.project} — يرفضه الحارس: ${REASON_AR[s.why] ?? s.why}`,
      ),
      ...r.undefinedTools.map((t) => `- \`${t.subject}\` · ${t.facts} حقيقة · ${t.projects.join("، ")} — أداة بلا تعريف`),
    ],
    "ما لا يُعرض على المستخلص لا تستبدله جلسة ولا تسحبه: `sila move --plan` للنقل، أو سطر في `definitions` بـ`engine.config.json` للأداة.",
  );

  section(
    `حقائق لم تُؤكَّد منذ ${r.days} يوماً ومشروعها نشط — ${r.stale.length}`,
    r.stale.length,
    r.stale.map(
      (s) =>
        `- \`${s.subject}.${s.key}\` — ${short(s.claim)}\n  - آخر ملاحظة تقولها: ${s.lastSeen.slice(0, 10)} (${s.age} يوماً)` +
        ` · آخر جلسة لـ${s.project}: ${s.projectLast.slice(0, 10)} (${s.projectAge} يوماً)`,
    ),
    "قدم الحقيقة ليس خطأً — والمشروع مستمر ولم يعد أحد يقولها. إن بطلت: `sila retract <subject> <key> --reason`.",
  );

  section(
    `جلسات معلّقة منذ أكثر من ${r.pendingDays} أيام — ${r.pending.length}`,
    r.pending.length,
    r.pending.map((s) => `- \`${s.sessionId}\` (${s.agent}) · جلسة ${s.startedAt.slice(0, 10)}، تنتظر ${s.age} يوماً · آخر محاولة ${s.processedAt.slice(0, 10)} · ${s.detail}`),
    "تحت جدار same-provider لا بديل عن CLI وكيلها (الثابت 12): ثبّت الـCLI، أو اقبل أنها لن تُقرأ.",
  );

  // The same check's other half, under its own heading: a lost session read
  // as one more wait would say something is coming.
  section(
    `جلسات معلّقة نصّها مفقود — ${r.gone.length}`,
    r.gone.length,
    r.gone.map((s) => `- \`${s.sessionId}\` (${s.agent}) · جلسة ${s.startedAt.slice(0, 10)} · نصّها مفقود: ${s.sourceFile || "(لا مسار مسجَّل)"} · آخر محاولة ${s.processedAt.slice(0, 10)}`),
    "ليست تنتظر: المسح لا يرى إلا ما على القرص، فلن يعيدها ولن تُقرأ، ولا ملاحظة لها تُفقد. إن نُقل نصّها إلى حيث يمشي المسح عادت في المسح التالي.",
  );

  return out.join("\n");
}

/** `_inbox/audit.md` — beside the two files that already ask something of the user. */
export function auditPath(vault: string): string {
  return path.join(paths(vault).inbox, "audit.md");
}

/**
 * The command: the five checks, the report written into the vault, one commit.
 *
 * The scan lock is taken although nothing here writes a fact. A scan halfway
 * through has notes on disk whose claims are not yet laid onto the index, and
 * an audit reading that moment would report orphans that are nothing but the
 * scan's own work in progress. A weekly check that refuses to run while a scan
 * runs is worth more than one that cries wolf — the price is that it has to be
 * run again ten minutes later, or with `--break-lock` when the holder is known
 * to be dead.
 */
export function runAudit(
  cfg: Config,
  opts: { now?: string; days?: number; pendingDays?: number; breakLock?: boolean } = {},
): AuditReport & { file: string; commit: string | null } {
  const release = acquireLock(cfg.vault, opts);
  const store = new Store(cfg.vault);
  try {
    const report = auditReport(cfg, store, opts);
    const file = auditPath(cfg.vault);
    writeFileAtomic(file, `${renderAudit(report)}\n`);
    const commit = new Git(cfg.vault, cfg.git).commit(`audit: ${report.day}`);
    return { ...report, file, commit };
  } finally {
    store.close();
    release();
  }
}
