import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { injectAllowed, injectSetting, projectDirOf, projectRootOf, setInjectSetting } from "../config.js";
import type { FactRow, SessionRow, Store } from "../store/db.js";
import { transcriptGone } from "../store/db.js";
import { gitStateOf } from "../store/git.js";
import { paths, renderResume } from "../store/vault.js";
import type { Resume } from "../types.js";
import { readFileIfExists, slug, writeFileAtomic } from "../util/fsatomic.js";

/**
 * What an agent reads before it starts working.
 *
 * This is the only output of the whole system that costs something on every
 * single later request, so it is capped in characters and ordered by value.
 * An uncapped brief is a silent tax: it grows with the vault, nobody notices,
 * and every session afterwards pays it.
 *
 * The order — resume, then facts, then open questions, then decisions, then
 * history — is the order in which things stop being worth their tokens. Where
 * the last session stopped is the first thing the next one needs; a current
 * fact is always worth knowing; last month's session titles almost never are,
 * which is why history is assembled last and is the first thing dropped.
 */

// The engine's name before it was published as sila, kept on purpose: these
// two lines are how a later injection finds the block it wrote in a
// project's CLAUDE.local.md, AGENTS.md or GEMINI.md. Renamed, every block
// already injected would be orphaned — never updated again, and a second
// block written beside it with the new marker.
const BEGIN = "<!-- memory-engine:begin -->";
const END = "<!-- memory-engine:end -->";
/** How the freshness stamp opens — what stampWorks finds it by. */
const STAMP = "_محدَّث";

/**
 * The agent files of a folder.
 *
 * In a git repository Claude Code's copy goes to CLAUDE.local.md, which the
 * docs (code.claude.com/docs/en/memory) load at launch exactly like
 * CLAUDE.md. What the docs do *not* do is gitignore it: they recommend the
 * user add it to .gitignore. So the rename alone keeps nothing out of a
 * repository — `injectBrief` is what refuses to write one git would carry.
 * AGENTS.md and GEMINI.md have no local variant in their own docs and stay
 * as they are.
 */
function agentFilesFor(cwd: string): string[] {
  return [projectRootOf(cwd) ? "CLAUDE.local.md" : "CLAUDE.md", "AGENTS.md", "GEMINI.md"];
}

/** This very CLI, by full path — see scanCommand. */
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/**
 * The command the freshness stamp tells an agent to run: node and this CLI by
 * full path, and the vault the brief belongs to. A deploy assumes no PATH
 * (the user's call, 2026-10-01) — `mem scan`, as the stamp said, ran nowhere
 * on this machine: `mem` was never put on PATH, and the hook and the task
 * name both by full path for the same reason.
 */
export function scanCommand(vault: string): string {
  return `"${process.execPath}" "${CLI}" scan --vault "${path.resolve(vault)}"`;
}

export function buildBrief(store: Store, vault: string, project: string, maxChars = 6000): string {
  // Line one is a freshness stamp with an instruction attached. A brief is
  // read by an agent that cannot tell how old it is, and the injected copy in
  // a project's CLAUDE.md outlives the scan that wrote it; the stamp turns
  // "is this current?" into something the reader can act on.
  const stamp = `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`;
  const head = [
    `${STAMP} ${stamp} — إن مضى أكثر من يوم على هذا الختم فشغّل \`${scanCommand(vault)}\` قبل الاعتماد عليه._`,
    "",
    `# ذاكرة ${project}`,
    "",
  ];

  const sections: string[][] = [
    resumeSection(store, project),
    factsSection(store, project),
    pendingSection(store, project),
    decisionsSection(store, vault, project),
    historySection(store, project),
  ];

  const out = [...head];
  let used = out.join("\n").length;
  for (const section of sections) {
    if (!section.length) continue;
    const cost = section.join("\n").length + 1;
    if (used + cost > maxChars) {
      // The section that runs out of room is cut to whole lines and the rest
      // are dropped entirely. Nothing after a truncation point is promoted
      // past it: the ordering *is* the priority, so skipping ahead to a
      // smaller later section would quietly invert it.
      const room = maxChars - used;
      const taken: string[] = [];
      let spent = 0;
      for (const line of section) {
        if (spent + line.length + 1 > room) break;
        taken.push(line);
        spent += line.length + 1;
      }
      if (taken.length > 2) out.push(...taken, "");
      break;
    }
    out.push(...section, "");
    used += cost;
  }

  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * Where the most recent session stopped, from that session alone.
 *
 * Only the latest one: a resume block from three sessions ago describes a
 * state that no longer exists, and stacking them would make the reader guess
 * which is current — the one thing this section exists to remove.
 *
 * Its command goes when it cannot work (constant 21, commandWorks): a command
 * that cannot work is worse than none. Only the command — where the session
 * stopped and what it touched stay true, and the note keeps all of it.
 */
function resumeSection(store: Store, project: string): string[] {
  const last = store.recentSessions(project, 1)[0];
  if (!last?.resume_json) return [];
  let r: Resume;
  try {
    r = JSON.parse(last.resume_json) as Resume;
  } catch {
    return [];
  }
  const command = r.resumeCommand && !commandWorks(last, r.resumeCommand) ? null : r.resumeCommand;
  const lines = renderResume({ ...r, files: r.files ?? [], resumeCommand: command }, 10);
  if (!lines.length) return [];
  const when = (last.started_at ?? last.processed_at).slice(0, 10);
  return [`## استئناف — آخر جلسة (${when} · ${last.agent})`, "", ...lines];
}

/**
 * Live facts for every subject this project's sessions ever touched.
 *
 * Facts are keyed by subject, not by project, so the link runs through the
 * session that produced them. A subject discussed in two projects therefore
 * shows up in both briefs — which is correct: the claim is true regardless of
 * where it was learned.
 */
function factsSection(store: Store, project: string): string[] {
  const rows = store.db
    .prepare(
      `SELECT f.* FROM facts f
        JOIN sessions s ON s.id = f.session_id
        WHERE s.project = ? AND f.superseded_by IS NULL AND f.retracted_at IS NULL
        GROUP BY f.subject, f.key
        ORDER BY f.subject, f.key`,
    )
    .all(project) as FactRow[];
  if (!rows.length) return [];

  const bySubject = new Map<string, FactRow[]>();
  for (const r of rows) {
    const list = bySubject.get(r.subject) ?? [];
    list.push(r);
    bySubject.set(r.subject, list);
  }

  const out = ["## ما هو صحيح الآن", ""];
  for (const [subject, facts] of bySubject) {
    out.push(`**${subject}**`);
    for (const f of facts) out.push(`- ${f.key}: ${f.claim}`);
    out.push("");
  }
  return out;
}

/**
 * Open questions come second, above decisions, because they are the only
 * section that asks the reader for something rather than telling it something.
 *
 * From the latest session only, like the resume block: a claim queued three
 * sessions ago is either decided by now (then it is not pending) or stale
 * enough that raising it again costs the user more than it tells the agent.
 * The full queue stays in `_inbox/pending.md`.
 */
function pendingSection(store: Store, project: string): string[] {
  const last = store.recentSessions(project, 1)[0];
  if (!last) return [];
  const rows = store.db
    .prepare(
      `SELECT subject, key, claim, reason FROM pending
        WHERE session_id = ? AND status = 'waiting'
        ORDER BY created_at DESC LIMIT 12`,
    )
    .all(last.id) as Array<{ subject: string; key: string; claim: string; reason: string }>;
  if (!rows.length) return [];
  return [
    "## معلّق — من آخر جلسة، ينتظر قرار المستخدم",
    "",
    ...rows.map((r) => `- \`${r.subject}.${r.key}\` — ${r.claim}`),
    "",
    "_لا تعتمد على هذه. اسأل المستخدم إن كانت ذات صلة._",
  ];
}

/**
 * Decisions are read back out of the session notes rather than the database.
 *
 * The `engine:facts` trailer carries only what the database is derived from,
 * so the notes stay the single source for prose. Parsing our own rendered
 * Markdown is the price of keeping that trailer minimal — and the reason
 * `renderSessionNote` must keep emitting this heading verbatim.
 */
function decisionsSection(store: Store, vault: string, project: string): string[] {
  const sessions = store.recentSessions(project, 12);
  const lines: string[] = [];
  for (const s of sessions) {
    if (!s.note_path) continue;
    const md = readFileIfExists(path.join(vault, s.note_path));
    if (!md) continue;
    for (const item of bulletsUnder(md, "قرارات")) {
      if (lines.length >= 12) break;
      lines.push(`- ${item}`);
    }
    if (lines.length >= 12) break;
  }
  if (!lines.length) return [];
  return ["## قرارات سابقة", "", ...lines];
}

function historySection(store: Store, project: string): string[] {
  const rows: SessionRow[] = store.recentSessions(project, 8);
  if (!rows.length) return [];
  return [
    "## جلسات أخيرة",
    "",
    ...rows.map((r) => {
      const when = (r.started_at ?? r.processed_at).slice(0, 10);
      return `- ${when} · ${r.agent} · ${r.id}`;
    }),
  ];
}

/** Bullets under a `## <heading>` section, stopping at the next heading. */
function bulletsUnder(md: string, heading: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      inside = line.replace(/^##\s+/, "").trim() === heading;
      continue;
    }
    if (inside && line.startsWith("- ")) out.push(line.slice(2).trim());
  }
  return out;
}

export function briefPath(vault: string, project: string): string {
  return path.join(paths(vault).projects, slug(project), "BRIEF.md");
}

export function writeBrief(store: Store, vault: string, project: string, maxChars = 6000): string {
  const p = briefPath(vault, project);
  writeFileAtomic(p, buildBrief(store, vault, project, maxChars));
  return p;
}

/** A project whose written brief, or the copy of it in its folder, offers something that no longer works. */
export interface StaleBrief {
  project: string;
  /** BRIEF.md offers it. */
  brief: boolean;
  /** The folder whose agent files offer it, when the brief may be injected there. */
  dir: string | null;
}

/**
 * Whether a written stamp's command still runs: not the bare `mem` it used
 * to say, and every path it names still there. Not whether it is the command
 * this build would write — two nodes on one machine would then rewrite every
 * brief on every scan; any command that runs is a stamp that works.
 */
function stampWorks(text: string): boolean {
  const line = text.split("\n").find((l) => l.startsWith(STAMP));
  const command = line ? /`([^`]+)`/.exec(line)?.[1] : undefined;
  if (!command) return true;
  if (/^mem\b/.test(command)) return false;
  return [...command.matchAll(/"([^"]+)"/g)].every((m) => fs.existsSync(m[1] ?? ""));
}

/**
 * Projects whose written brief offers something that no longer works
 * (constant 21) — in BRIEF.md, or in the agent files it was injected into: a
 * resume command whose transcript or folder has gone, or a freshness stamp
 * whose command does not run.
 *
 * buildBrief writes neither, but a brief is written when its project is
 * touched, and a project nobody works on is never touched again: the
 * BRIEF.md of one such project, and the three files in its folder, went on
 * offering `claude --resume 0d25a429…` for days after the transcript went.
 * The scan asks every project here, and rewrites what still offers one; once
 * rewritten nothing does, and this finds nothing — so a quiet scan writes
 * nothing. Only our block of an agent file is read: what the author wrote
 * outside it is theirs.
 */
export function staleBriefs(cfg: Config, store: Store): StaleBrief[] {
  const out: StaleBrief[] = [];
  const projects = store.db.prepare("SELECT DISTINCT project FROM sessions WHERE status = 'ok'").all() as Array<{ project: string }>;
  for (const { project } of projects) {
    const last = store.recentSessions(project, 1)[0];
    if (!last) continue;
    const dead = deadResume(last);
    // As renderResume fences it: the same words in a decision's prose are not an offer.
    const fenced = dead ? ["```bash", dead, "```"].join("\n") : null;
    const offers = (text: string | null) => !!text && ((!!fenced && text.includes(fenced)) || !stampWorks(text));
    const brief = offers(readFileIfExists(briefPath(cfg.vault, project)));
    const folder =
      cfg.briefSync && injectAllowed(cfg, project)
        ? (projectDirOf(cfg, last.cwd) ?? cfg.walls.find((w) => w.name === project)?.paths[0] ?? null)
        : null;
    // CLAUDE.md as well in a repository: an older scan wrote its block there.
    const files = folder ? [...new Set(["CLAUDE.md", ...agentFilesFor(folder)])] : [];
    const injected = !!folder && files.some((name) => offers(blockOf(readFileIfExists(path.join(folder, name)))));
    if (brief || injected) out.push({ project, brief, dir: injected ? folder : null });
  }
  return out;
}

/** A session's resume command when it no longer works (see commandWorks), or nothing. */
function deadResume(last: SessionRow): string | null {
  let resume: string | null = null;
  try {
    resume = last.resume_json ? ((JSON.parse(last.resume_json) as Resume).resumeCommand ?? null) : null;
  } catch {
    return null;
  }
  if (!resume || commandWorks(last, resume)) return null;
  return resume;
}

/**
 * Whether a session's resume command can run: the transcript it reopens is
 * there, and so is the folder it opens with `cd`. Every adapter starts its
 * command with `cd "<the session's folder>"`, and the folder is read off the
 * command — the thing that would fail — not off the row, whose cwd a
 * reindex leaves empty. Three briefs on 2026-10-01 offered a `cd` into a
 * folder that had gone (three projects), their
 * transcripts still there. Whether the agent's CLI is installed is not asked
 * (the user's call, 2026-10-01).
 */
function commandWorks(row: SessionRow, command: string): boolean {
  if (transcriptGone(row)) return false;
  const folder = /^cd "([^"]+)"/.exec(command)?.[1];
  return !folder || fs.existsSync(folder);
}

/** Our block of an agent file, or nothing. */
function blockOf(text: string | null): string | null {
  if (text === null) return null;
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  return start >= 0 && end > start ? text.slice(start, end) : null;
}

/**
 * Inject the brief into the agent files of a working directory.
 *
 * Reads the already-written `BRIEF.md` rather than rebuilding it, which is why
 * this needs no `Store`: `sila brief --sync` writes the brief first, and that
 * file is then the one thing both the agent files and the user are looking at.
 * Two independent renderings of the same brief could otherwise disagree.
 *
 * Everything outside the marked block belongs to the user and is preserved
 * byte for byte. Only files that actually changed are returned, so running
 * this hourly from cron produces no git noise on the days nothing moved.
 */
export function syncAgentFiles(vault: string, cwd: string, project: string): string[] {
  const brief = readFileIfExists(briefPath(vault, project));
  if (brief === null) return [];

  const block = [BEGIN, brief.trimEnd(), END].join("\n");
  const written: string[] = [];
  const names = agentFilesFor(cwd);

  // The block used to go to CLAUDE.md in repositories too. One still there
  // is moved, not duplicated: our block is cut out and everything the author
  // wrote around it stays.
  if (names[0] === "CLAUDE.local.md") {
    const old = path.join(cwd, "CLAUDE.md");
    const existing = readFileIfExists(old);
    if (existing !== null && existing.includes(BEGIN)) {
      writeFileAtomic(old, removeBlock(existing));
      written.push(old);
    }
  }

  for (const name of names) {
    const file = path.join(cwd, name);
    const existing = readFileIfExists(file);
    const next = existing === null ? `${block}\n` : replaceBlock(existing, block);
    if (existing === next) continue;
    writeFileAtomic(file, next);
    written.push(file);
  }
  return written;
}

/** An agent file git would carry out of the machine, and why. */
export interface Exposure {
  file: string;
  state: "tracked" | "untracked" | "unknown";
}

/**
 * The agent files of `cwd` that a commit would publish.
 *
 * Asked before anything is written, of the files that do not exist yet as
 * much as of those that do — "untracked" is what `git add -A` would pick up.
 * Fails closed: a folder under a `.git` that git itself cannot be asked about
 * (git missing, a broken repository) counts as exposed, because the question
 * is whether a digest of the user's sessions ends up somewhere public, and
 * "could not tell" is not "no".
 */
export function exposedAgentFiles(cwd: string): Exposure[] {
  if (!projectRootOf(cwd)) return [];
  const out: Exposure[] = [];
  for (const name of agentFilesFor(cwd)) {
    const file = path.join(cwd, name);
    const state = gitStateOf(file);
    if (state === "ignored") continue;
    out.push({ file, state: state === "none" ? "unknown" : state });
  }
  return out;
}

/**
 * The only way a brief reaches a project folder.
 *
 * A file git would publish stops the injection for the whole project — not
 * a warning, which a detached scan writes to a log nobody reads, while the
 * digest sits in the next `git add -A`. The stop is written into
 * engine.config.json as `"inject": {"<project>": false}`, so it outlasts this
 * run and holds until the user lifts it: removing the entry once the files
 * are in .gitignore, or setting it to `true`, which is the explicit approval
 * to write even into a file git carries. Nothing in the folder is touched
 * when the injection stops, the legacy CLAUDE.md block included.
 */
export function injectBrief(cfg: Config, project: string, cwd: string): { written: string[]; stopped: Exposure[] } {
  const setting = injectSetting(cfg, project);
  if (setting === false) return { written: [], stopped: [] };
  if (setting !== true) {
    const exposed = exposedAgentFiles(cwd);
    if (exposed.length) {
      setInjectSetting(cfg, project, false);
      return { written: [], stopped: exposed };
    }
  }
  return { written: syncAgentFiles(cfg.vault, cwd, project), stopped: [] };
}

/** What a stopped injection says, wherever it is reported. */
export function describeStop(project: string, stopped: Exposure[]): string {
  const how = { tracked: "متتبَّع في git", untracked: "غير متجاهَل في git", unknown: "في مستودع تعذّر سؤاله" };
  const dir = stopped[0] ? path.dirname(stopped[0].file) : "";
  return (
    `⛔ أوقفتُ حقن موجز ${project} في ${dir}: ` +
    stopped.map((e) => `${path.basename(e.file)} (${how[e.state]})`).join("، ") +
    ` — كُتب "inject": {"${project}": false} في engine.config.json. ` +
    `بعد إضافتها إلى .gitignore احذف البند، أو اجعله true لتقرّ الحقن ولو نُشر.\n`
  );
}

/** The file without our block; the author's text on either side is kept, and an emptied file stays, empty. */
function removeBlock(existing: string): string {
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start < 0 || end < start) return existing;
  const rest = (existing.slice(0, start) + existing.slice(end + END.length)).replace(/\n{3,}/g, "\n\n").trim();
  return rest ? `${rest}\n` : "";
}

function replaceBlock(existing: string, block: string): string {
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  // No block yet: append rather than prepend, so a hand-written file keeps its
  // own opening lines where the author put them.
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${block}\n`;
}
