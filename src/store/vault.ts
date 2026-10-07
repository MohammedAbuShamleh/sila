import path from "node:path";
import fs from "node:fs";
import type { FactRow, Store } from "./db.js";
import type { AgentId, Fact, MoveRecord, NoteEvents, Resume, RetractedFact, SessionNote } from "../types.js";
import { ensureDir, readFileIfExists, slug, writeFileAtomic } from "../util/fsatomic.js";

/**
 * Layout — every path here is plain UTF-8 Markdown the user can open, edit or
 * delete by hand:
 *
 *   subjects/<kind>/<name>.md     one file per person / project / term
 *   sessions/<yyyy>/<mm>/*.md     one dated note per session
 *   projects/<name>/BRIEF.md      what an agent reads at session start
 *   _inbox/pending.md             claims waiting on a human decision
 *   _inbox/quarantine.md          sessions withheld by the redactor
 *   .index/memory.db              disposable; rebuilt by `sila reindex`
 *
 * Session notes are the ground truth. Each one carries its extracted facts in
 * a machine-readable trailer, so the database and the subject files are both
 * derived artifacts and can be regenerated from the notes alone.
 */

const FACTS_OPEN = "<!-- engine:facts";
const FACTS_CLOSE = "-->";

// Headings of the derived sections. `sila retract` finds them to know where
// a note's prose ends, so they are constants rather than literals.
const FACTS_HEADING = "## حقائق مستخلصة";
const REPLACED_HEADING = "## استُبدل";
const RETRACTED_HEADING = "## سُحب";

export function paths(vault: string) {
  return {
    subjects: path.join(vault, "subjects"),
    sessions: path.join(vault, "sessions"),
    projects: path.join(vault, "projects"),
    inbox: path.join(vault, "_inbox"),
  };
}

/**
 * `sessions/<yyyy>/<mm>/<yyyy>-<mm>-<dd>-<agent>-<short-id>.md`
 *
 * Nothing about the note's *content* is in its name — not the title, which a
 * re-extraction is free to change. That is what lets a session be processed
 * again and land on the same path, overwriting its previous note in place
 * rather than leaving it beside a new one for `reindex` to replay twice.
 *
 * Callers pass the best date they have (start, else end); "now" is the last
 * resort for a session with no timestamp at all, and is the one case where
 * the path can differ between two runs.
 */
export function sessionNotePath(vault: string, when: string | null, sessionId: string): string {
  const d = when ? new Date(when) : new Date();
  const safe = isNaN(d.getTime()) ? new Date() : d;
  const yyyy = String(safe.getUTCFullYear());
  const mm = String(safe.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(safe.getUTCDate()).padStart(2, "0");
  const colon = sessionId.indexOf(":");
  const agent = colon > 0 ? sessionId.slice(0, colon) : "unknown";
  const short = (colon > 0 ? sessionId.slice(colon + 1) : sessionId).slice(0, 8);
  return path.join(paths(vault).sessions, yyyy, mm, `${yyyy}-${mm}-${dd}-${agent}-${short}.md`);
}

/**
 * Which touched paths are worth listing for a resume.
 *
 * The adapters report every path a tool read or wrote, and a session that
 * built something touched its own scratch files, the temp directory and the
 * agent's memory folder along the way. None of those is a place the next
 * session picks up from. Past `max`, the most recently modified paths are
 * the ones closest to where the work stopped; up to it, first-seen order is
 * kept, because that is the order the session met them in. A path segment
 * literally named `temp` or `tmp` is excluded wherever it sits — the rare
 * project folder called that loses its resume list, which is cheaper than
 * every session listing its scratch.
 */
const RESUME_SKIP = [/\/temp\//, /\/tmp\//, /\/scratchpad\//, /\/\.claude\/projects\/[^/]+\/memory\//];

export function selectResumeFiles(files: string[], mtimeOf: (file: string) => number, max = 15): string[] {
  const kept = files.filter((f) => {
    const norm = `/${f.replace(/\\/g, "/").toLowerCase()}/`;
    return !RESUME_SKIP.some((re) => re.test(norm));
  });
  if (kept.length <= max) return kept;
  return kept
    .map((f, i) => ({ f, i, m: mtimeOf(f) }))
    .sort((a, b) => b.m - a.m || a.i - b.i)
    .slice(0, max)
    .map((x) => x.f);
}

/** The lines of a resume block, shared by the note and the brief. The command's fence is what staleBriefs in brief looks for. */
export function renderResume(r: Resume, maxFiles: number): string[] {
  const lines: string[] = [];
  if (r.where) lines.push(`- **وقفنا عند:** ${r.where}`);
  if (r.next) lines.push(`- **الخطوة التالية:** ${r.next}`);
  if (r.files.length) {
    const shown = r.files.slice(0, maxFiles).map((f) => `\`${f}\``).join("، ");
    const more = r.files.length > maxFiles ? ` … و${r.files.length - maxFiles} أخرى` : "";
    lines.push(`- **ملفات لُمست:** ${shown}${more}`);
  }
  if (r.resumeCommand) lines.push("", "```bash", r.resumeCommand, "```");
  return lines;
}

export function renderSessionNote(args: {
  note: SessionNote;
  sessionId: string;
  agent: AgentId;
  sourceFile: string;
  startedAt: string | null;
  usedModel: boolean;
  /** Claims of earlier extractions of this session that this one withdrew or worded anew. */
  retracted?: RetractedFact[];
  /** Slots a human moved out of this session's earlier notes — carried forward, see MoveRecord. */
  moves?: MoveRecord[];
  /**
   * sha256 of the distilled text this note was read from — see sameText in
   * run. Required, and checked: a note written without it is the trap the
   * 67 notes of before daadd4d fell into — the first time something outside
   * the engine moved their transcript's mtime, a model call to read an
   * unchanged session again. A path that forgets it fails here, loudly,
   * rather than writing a note that will cost a call ten days from now.
   */
  distilled: string;
}): string {
  if (!/^[0-9a-f]{64}$/.test(args.distilled)) {
    throw new Error(`${args.sessionId}: ملاحظة بلا بصمة نصها — لا تُكتب`);
  }
  const { note, sessionId, agent, sourceFile, startedAt, usedModel } = args;
  const retracted = args.retracted ?? [];
  const moves = args.moves ?? [];
  const fm = [
    "---",
    `session: ${sessionId}`,
    `agent: ${agent}`,
    `project: ${note.project}`,
    `date: ${startedAt ?? ""}`,
    `extractor: ${usedModel ? "model" : "local"}`,
    `source: ${sourceFile.replace(/\\/g, "/")}`,
    "---",
    "",
  ].join("\n");

  const out: string[] = [fm, `# ${note.title}`, "", note.summary, ""];

  const section = (heading: string, lines: string[]) => {
    if (!lines.length) return;
    out.push(`## ${heading}`, ...lines.map((l) => `- ${l}`), "");
  };

  section("عملنا", note.did);
  section(
    "قرارات",
    note.decisions.map((d) => (d.why ? `**${d.what}** — ${d.why}` : `**${d.what}**`)),
  );
  section(
    "رُفض",
    note.rejected.map((d) => (d.why ? `~~${d.what}~~ — ${d.why}` : `~~${d.what}~~`)),
  );
  section("معلّق", note.open);

  // Where the session stopped and how to pick it up — the part of a note
  // that is read the morning after, before anything else in it.
  const resumeLines = note.resume ? renderResume(note.resume, 20) : [];
  if (resumeLines.length) out.push("## استئناف", "", ...resumeLines, "");

  out.push(...renderFactsTail(note, retracted, moves, args.distilled));
  return out.join("\n");
}

/**
 * Everything in a note that is derived from its facts: the two visible
 * sections and the machine-readable trailer.
 *
 * Split out because `sila retract` rewrites exactly this part of an existing
 * note and nothing else. The prose above it belongs to the extraction that
 * produced it and must survive untouched.
 */
function renderFactsTail(
  note: Pick<SessionNote, "facts" | "links" | "project" | "resume">,
  retracted: RetractedFact[],
  moves: readonly MoveRecord[] = [],
  distilled?: string,
  inferred?: InferredDigest,
): string[] {
  const out: string[] = [];

  if (note.facts.length) {
    out.push(
      FACTS_HEADING,
      ...note.facts.map((f) => `- \`${f.subject}.${f.key}\` — ${f.claim} _(${f.confidence.toFixed(2)})_`),
      "",
    );
  }

  // An earlier reading's wording of a slot this reading fills again was
  // replaced, not withdrawn — the replay files it the same way (fileReplaced
  // in reconcile). The trailer keeps both in one list; only the heading
  // tells them apart, and it is read off the facts by claimInSlot, as the
  // replay reads it.
  const nowIn = (f: RetractedFact) => claimInSlot(note.facts, f.subject, f.key);
  const replaced = retracted.filter((f) => nowIn(f));
  const withdrawn = retracted.filter((f) => !nowIn(f));
  const struck = (f: RetractedFact, tail: string) => {
    const why = f.reason ? ` — ${f.reason}` : "";
    return `- ~~\`${f.subject}.${f.key}\` — ${f.claim}~~${tail} _(${f.retractedAt.slice(0, 10)}${why})_`;
  };

  if (replaced.length) {
    out.push(REPLACED_HEADING, ...replaced.map((f) => struck(f, ` → ${nowIn(f)?.claim ?? ""}`)), "");
  }

  if (withdrawn.length) {
    out.push(RETRACTED_HEADING, ...withdrawn.map((f) => struck(f, "")), "");
  }

  // Machine-readable trailer. Invisible in any Markdown renderer, and the
  // reason `sila reindex` can rebuild the entire database from the vault.
  // Retractions ride here too: this note is rewritten in place, so the
  // trailer is the only surviving record of what earlier readings claimed.
  // So does the resume block — the brief is rebuilt from it after a reindex.
  // And the moves a human made out of this note: they are what keeps a
  // re-read from filing the claim back where the model first put it, so they
  // must outlive the rewrite. Written only when there are any, so a note no
  // hand has touched is byte-identical to what it was.
  // And the fingerprint of the text the note was read from: it lives here,
  // not in the index, so a rebuild keeps it — a transcript the index forgot
  // is still known to say what it said.
  out.push(
    FACTS_OPEN,
    JSON.stringify(
      {
        facts: note.facts,
        links: note.links,
        project: note.project,
        retracted,
        resume: note.resume ?? null,
        ...(moves.length ? { moves } : {}),
        ...(distilled ? { distilled } : {}),
        ...(inferred ? { distilledInferred: inferred } : {}),
      },
      null,
      0,
    ),
    FACTS_CLOSE,
    "",
  );

  return out;
}

/**
 * Withdraw one fact from a note that is already on disk.
 *
 * The database alone is not enough: `reindex` replays the trailer, so a fact
 * struck only in SQLite comes back live on the next rebuild. The claim moves
 * from `facts` to `retracted` in the same file that made it, which is what
 * keeps the Markdown the source of truth (constant 3).
 *
 * Returns null when the note does not claim it — already withdrawn, or the
 * fact came from a different session than the caller thinks.
 */
export function retractInNote(
  notePath: string,
  subject: string,
  key: string,
  at: string,
  reason: string,
): RetractedFact | null {
  const md = readFileIfExists(notePath);
  if (md === null) return null;
  const trailer = parseFactsTrailer(md);
  if (!trailer) return null;

  const idx = trailer.facts.findIndex((f) => f.subject === subject && f.key === key);
  if (idx < 0) return null;
  const [fact] = trailer.facts.splice(idx, 1);
  if (!fact) return null;

  const gone: RetractedFact = { ...fact, createdAt: noteDate(md) || at, retractedAt: at, reason };
  writeFileAtomic(notePath, withFactsTail(md, trailer, [...(trailer.retracted ?? []), gone]));
  return gone;
}

/**
 * Put one withdrawn claim back into the note that made it — the mirror of
 * retractInNote, for `sila restore`.
 *
 * The latest withdrawn wording of the slot goes back into `facts` as it was:
 * its words, its confidence, nothing added. The replay then revives the row
 * that was withdrawn, or inserts it if the index lost it — a withdrawal
 * whose reason was wrong, most often a re-read that no longer saw the part
 * of the transcript the claim came from. What it does not do is make the
 * claim immune: only a claim a human confirmed at 1.0 is (constant 5), and
 * a restore says the withdrawal was wrong, not that the claim is beyond the
 * model. `confirm` says exactly that, and puts the claim back at 1.0: the
 * user's word (2026-09-25), asked for by name and never the default. A
 * source slot of a move is refused — its claim lives at the target, and the
 * caller is told where.
 *
 * Returns null when the note has nothing withdrawn in that slot, or still
 * claims it.
 */
export function restoreInNote(
  notePath: string,
  subject: string,
  key: string,
  opts: { confirm?: boolean } = {},
): { fact: Fact } | { movedTo: MoveRecord } | null {
  const md = readFileIfExists(notePath);
  if (md === null) return null;
  const trailer = parseFactsTrailer(md);
  if (!trailer) return null;
  const inSlot = (f: { subject: string; key: string }) => f.subject.trim() === subject.trim() && f.key.trim() === key.trim();
  if (trailer.facts.some(inSlot)) return null;
  const movedTo = (trailer.moves ?? []).find(inSlot);
  if (movedTo) return { movedTo };

  const retracted = [...(trailer.retracted ?? [])];
  const idx = retracted.map(inSlot).lastIndexOf(true);
  if (idx < 0) return null;
  const [back] = retracted.splice(idx, 1);
  if (!back) return null;
  const fact: Fact = {
    subject: back.subject,
    subjectKind: back.subjectKind,
    key: back.key,
    claim: back.claim,
    confidence: opts.confirm ? 1 : back.confidence,
  };
  writeFileAtomic(notePath, withFactsTail(md, { ...trailer, facts: [...trailer.facts, fact] }, retracted));
  return { fact };
}

/** The note's own date: when what it claims was learned. The frontmatter is the only place that survived the first rendering. */
export function noteDate(md: string): string {
  return /^date: (.*)$/m.exec(md)?.[1]?.trim() ?? "";
}

/**
 * A note on disk with its derived part regenerated from a changed trailer —
 * the one way `sila retract` and `sila move` rewrite a note. Everything from
 * the first derived heading onward is regenerated; the prose before it is
 * left exactly as the extraction wrote it.
 */
export function withFactsTail(
  md: string,
  trailer: NonNullable<ReturnType<typeof parseFactsTrailer>>,
  retracted: RetractedFact[],
): string {
  const cut = [FACTS_HEADING, REPLACED_HEADING, RETRACTED_HEADING, FACTS_OPEN]
    .map((marker) => md.indexOf(marker))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  const head = cut === undefined ? md : md.slice(0, cut);
  return [
    head.trimEnd(),
    "",
    ...renderFactsTail(
      { ...trailer, resume: trailer.resume ?? undefined },
      retracted,
      trailer.moves ?? [],
      trailer.distilled,
      trailer.distilledInferred,
    ),
  ].join("\n");
}

/**
 * An inferred digest — «بصمة مُستنتَجة»: the text is what it was at the last
 * reading, as far as we know; not that it was read now.
 *
 * A note written before the trailer carried `distilled` has no record of the
 * text it was read from, and the first time its transcript's fingerprint
 * moved — batches of old Claude Code transcripts have their mtime set back to
 * seven days ago, from outside the engine — the scan could not tell and paid
 * a model call to read an unchanged session again: $5.28 in four days. This
 * is the digest of what today's adapter distils from the file, recorded
 * without a call, beside the evidence it rests on: the file is as long as it
 * was at the reading that wrote the note. It is kept apart from `distilled`
 * so that no one takes it for a real one; a reading replaces it with one.
 */
export interface InferredDigest {
  /** sha256 of the distilled text, computed when inferred. */
  sha256: string;
  /** When it was inferred. */
  at: string;
  /** The reading it vouches for: the session row's processed_at, which wrote this note. */
  readAt: string;
  /** The transcript's size at that reading, and when inferred. */
  size: number;
}

/**
 * The same note with an inferred digest in its trailer, and nothing else
 * changed — not the derived sections either, which an older version may have
 * rendered by other rules: rewriting them is a reading's job, or a hand's.
 * Null when the trailer cannot be read back byte for byte.
 */
export function withInferredDigest(md: string, inferred: InferredDigest): string | null {
  const start = md.indexOf(FACTS_OPEN);
  const end = start < 0 ? -1 : md.indexOf(FACTS_CLOSE, start);
  if (end < 0) return null;
  const body = md.slice(start + FACTS_OPEN.length, end);
  const json = body.trim();
  let trailer: Record<string, unknown>;
  try {
    trailer = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (JSON.stringify(trailer, null, 0) !== json) return null;
  const next = body.replace(json, JSON.stringify({ ...trailer, distilledInferred: inferred }, null, 0));
  return md.slice(0, start + FACTS_OPEN.length) + next + md.slice(end);
}

/** Which extractor wrote a note, from its frontmatter; null for anything that is not one of ours. */
export function noteExtractor(md: string): "model" | "local" | null {
  const m = /^extractor: (model|local)$/m.exec(md.replace(/\r\n/g, "\n"));
  return m ? (m[1] as "model" | "local") : null;
}

export function parseFactsTrailer(md: string): {
  facts: SessionNote["facts"];
  links: SessionNote["links"];
  project: string;
  retracted?: RetractedFact[];
  resume?: Resume | null;
  moves?: MoveRecord[];
  distilled?: string;
  distilledInferred?: InferredDigest;
} | null {
  const start = md.indexOf(FACTS_OPEN);
  if (start < 0) return null;
  const end = md.indexOf(FACTS_CLOSE, start);
  if (end < 0) return null;
  try {
    return JSON.parse(md.slice(start + FACTS_OPEN.length, end).trim());
  } catch {
    return null;
  }
}

/** A note's frontmatter as key → value; empty when it has none. */
export function frontmatter(md: string): Record<string, string> {
  const block = md.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** A session note read back from disk: the events it holds, and what else reindex needs of it. */
export interface NoteRecord extends NoteEvents {
  file: string;
  md: string;
  fm: Record<string, string>;
  trailer: ReturnType<typeof parseFactsTrailer>;
  /** Slots a human moved out of this note. Not an event the replay applies — the claims already sit where the move put them. */
  moves: MoveRecord[];
}

/** One note file, or null when it is not a session note of ours. */
export function readNote(file: string): NoteRecord | null {
  const md = readFileIfExists(file);
  if (md === null) return null;
  const fm = frontmatter(md);
  const sessionId = fm["session"];
  if (!sessionId) return null;
  const trailer = parseFactsTrailer(md);
  return {
    file,
    md,
    fm,
    trailer,
    sessionId,
    date: fm["date"] ?? "",
    facts: trailer?.facts ?? [],
    retracted: trailer?.retracted ?? [],
    links: trailer?.links ?? [],
    moves: trailer?.moves ?? [],
  };
}

/** Session date, then session id: the one order claims are applied in, by scan and reindex alike. */
export function byDate(a: { date: string; sessionId: string }, b: { date: string; sessionId: string }): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** Every session note in the vault, oldest session first. */
export function readAllNotes(vault: string): NoteRecord[] {
  return listSessionNotes(vault)
    .map(readNote)
    .filter((n): n is NoteRecord => n !== null)
    .sort(byDate);
}

/**
 * The claim a note files in a slot, if it files one. A withdrawal the same
 * note records from that slot is a replacement: the note and the replay both
 * read it off here.
 */
export function claimInSlot(facts: readonly Fact[], subject: string, key: string): Fact | undefined {
  return facts.find((f) => f.subject.trim() === subject.trim() && f.key.trim() === key.trim());
}

/** Whether a note says anything — a claim or a withdrawal — about `subject`. */
export function noteTouches(note: NoteEvents, subject: string): boolean {
  return note.facts.some((f) => f.subject.trim() === subject) || note.retracted.some((f) => f.subject.trim() === subject);
}

/**
 * The human-readable part of a note: no frontmatter, no trailer.
 *
 * This is what goes into the search index, from `scan` and from `reindex`
 * alike, so the two can never disagree about what a note "says". Indexing the
 * raw file put `session:` and `source:` lines into every snippet and let the
 * trailer's JSON keys match queries they had nothing to do with.
 */
export function noteProse(md: string): string {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const start = body.indexOf(FACTS_OPEN);
  return (start >= 0 ? body.slice(0, start) : body).trim();
}

export function subjectPath(vault: string, kind: string, subject: string): string {
  return path.join(paths(vault).subjects, slug(kind), `${slug(subject)}.md`);
}

/**
 * Renders a subject file from the database.
 *
 * Three sections, always in this order. "الحالي" is what is true now.
 * "استُبدل" is every claim that used to be true, struck through, with the date
 * it stopped being true and what replaced it. "سُحب" is every claim withdrawn
 * by a re-reading of its own session — not replaced by anything, just no
 * longer held. A correction adds a line to one of the last two; it never
 * removes one from the file.
 */
export function renderSubject(store: Store, subject: string, kind: string): string {
  const live = store.liveFacts(subject);
  const all = store.db
    .prepare("SELECT * FROM facts WHERE subject = ? AND superseded_by IS NOT NULL ORDER BY superseded_at DESC")
    .all(subject) as FactRow[];
  const retracted = store.retractedFacts(subject);

  const byId = new Map<number, FactRow>();
  for (const f of [...live, ...all, ...retracted]) byId.set(f.id, f);

  const head = [
    "---",
    `name: ${subject}`,
    `kind: ${kind}`,
    `facts: ${live.length}`,
    `superseded: ${all.length}`,
    `retracted: ${retracted.length}`,
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    `# ${subject}`,
    "",
  ];

  const body: string[] = ["## الحالي", ""];
  if (!live.length) body.push("_لا شيء بعد._", "");
  for (const f of live) {
    body.push(`- **${f.key}** — ${f.claim}  <sub>${f.created_at.slice(0, 10)} · ${f.session_id}</sub>`);
  }
  body.push("");

  if (all.length) {
    body.push("## استُبدل", "");
    for (const f of all) {
      const next = f.superseded_by != null ? byId.get(f.superseded_by) : undefined;
      // A successor that was itself later retracted leaves this slot empty;
      // say so, or the arrow reads as if the successor still stands.
      const arrow = next ? ` → ${next.claim}${next.retracted_at ? " (سُحب لاحقاً)" : ""}` : "";
      body.push(
        `- ~~**${f.key}** — ${f.claim}~~${arrow}  <sub>حتى ${(f.superseded_at ?? "").slice(0, 10)}</sub>`,
      );
    }
    body.push("");
  }

  if (retracted.length) {
    body.push("## سُحب", "");
    for (const f of retracted) {
      body.push(
        `- ~~**${f.key}** — ${f.claim}~~  <sub>سُحب ${(f.retracted_at ?? "").slice(0, 10)} · ${f.session_id}</sub>`,
      );
    }
    body.push("");
  }

  return [...head, ...body].join("\n");
}

export function writeSubject(vault: string, store: Store, subject: string, kind: string): string {
  const p = subjectPath(vault, kind, subject);
  writeFileAtomic(p, renderSubject(store, subject, kind));
  return p;
}

export function initVault(vault: string): void {
  const p = paths(vault);
  for (const dir of Object.values(p)) ensureDir(dir);
  const readme = path.join(vault, "README.md");
  if (!readFileIfExists(readme)) {
    writeFileAtomic(
      readme,
      [
        "# مخزن الذاكرة",
        "",
        "ملفات Markdown عادية. اقرأها، عدّلها، احذفها — هي لك.",
        "",
        "- `subjects/` — ملف لكل شخص/مشروع/مصطلح. قسم «الحالي» وقسم «استُبدل» وقسم «سُحب».",
        "- `sessions/` — ملاحظة مؤرخة لكل جلسة، مع حقائقها في ذيل مقروء آلياً.",
        "- `projects/*/BRIEF.md` — ما يقرأه الوكيل في بداية كل جلسة.",
        "- `_inbox/` — ما ينتظر قرارك، وما حُجب لأسباب أمنية.",
        "- `.index/` — قاعدة بيانات مؤقتة. احذفها متى شئت ثم `sila reindex`.",
        "",
        "كل تشغيل يُنهى بـ commit. لاسترجاع أي شيء: `git log`, `git revert`.",
        "",
      ].join("\n"),
    );
  }
}

export function listSessionNotes(vault: string): string[] {
  const root = paths(vault).sessions;
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  }
  return out.sort();
}
