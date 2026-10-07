import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentId, CliName } from "./types.js";
import { CLI_FOR_AGENT } from "./types.js";
import { slug, writeFileAtomic } from "./util/fsatomic.js";

/**
 * Configuration, and the walls that decide what may leave the machine.
 *
 * `walls` is the only field the user must fill in by hand, and it is the only
 * one whose default is deliberately useless: an empty list means "everything
 * may be summarized by the model". That is announced by `sila doctor` rather
 * than quietly assumed, because the failure mode — a folder of real case files
 * summarized over the network — is not recoverable by editing a config later.
 */

export const WallSchema = z.object({
  name: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  /** true = summarized on this machine, with no network call of any kind. */
  localOnly: z.boolean().default(true),
  /**
   * Added to localOnly, not instead of it. When a session may leave the
   * machine at all, it may only go to the CLI of the agent that produced it:
   * a Codex session to codex, never to claude or gemini. If that CLI is
   * missing or fails, the session waits as pending-extraction — it does not
   * fall back to another vendor. Constant 12: extraction must not widen the
   * circle of who has seen the data.
   */
  sameProvider: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  vault: z.string().min(1),
  sources: z.object({
    claudeCode: z.string().nullable().default(null),
    codex: z.string().nullable().default(null),
    gemini: z.string().nullable().default(null),
  }),
  walls: z.array(WallSchema).default([]),
  /** Below this, a claim waits for a human instead of entering the vault. */
  confidenceFloor: z.number().min(0).max(1).default(0.75),
  /** Sessions where the user typed less than this carry no intent worth keeping. */
  minUserChars: z.number().int().min(0).default(200),
  /** Hard ceiling on the distilled text sent per session. */
  distillMaxChars: z.number().int().min(1000).default(24000),
  /** Hard ceiling on a brief, so memory cannot tax every later request. */
  briefMaxChars: z.number().int().min(500).default(6000),
  /**
   * After a scan, inject each touched project's BRIEF.md into the agent files
   * of its folder (CLAUDE.md, AGENTS.md, GEMINI.md). What makes a session-end
   * hook worth having: the next session opens with the memory already there.
   */
  briefSync: z.boolean().default(true),
  /**
   * Per-project switch for that injection, by project name: `{"memory-engine":
   * false}` keeps the brief out of that folder however the scan is started.
   * The brief is a digest of the user's sessions; in a repository that gets
   * published it is personal data in a public place, and a project-wide
   * `briefSync: false` is too blunt for one such repository among many.
   */
  inject: z.record(z.boolean()).default({}),
  /**
   * What a tool subject admits, by subject name, beside the engine's own
   * (DEFINITIONS in extract.ts). A tool subject with no line here or there is
   * not shown to the extractor at all, and `sila doctor` names it: a tool's
   * name alone does not say where it ends.
   */
  definitions: z.record(z.string().trim().min(1)).default({}),
  git: z.boolean().default(true),
  extractor: z
    .object({
      /**
       * "anthropic" calls the API with ANTHROPIC_API_KEY. "cli" runs the
       * installed agent CLIs in print mode — no key, the user's own login —
       * trying `cliOrder` in turn. "local" never leaves the machine.
       */
      provider: z.enum(["anthropic", "cli", "local"]).default("anthropic"),
      /** Which CLIs to try, first to last. Editable; a missing one is skipped. */
      cliOrder: z.array(z.enum(["gemini", "codex", "claude"])).default(["gemini", "codex", "claude"]),
      /**
       * Per-CLI model overrides. `model` below names a Claude model, which the
       * claude CLI accepts; gemini and codex take their own defaults unless a
       * name is given here.
       */
      cliModels: z.record(z.string()).default({}),
      // A bulk extractor over hundreds of sessions: the current Sonnet is
      // the deliberate default here — $2/$10 per million against Opus's
      // $5/$25 — and the model is one config field away when a project
      // proves to need more.
      model: z.string().default("claude-sonnet-5"),
      /** Stops a runaway scan from spending the month's budget in one go. */
      dailyCallLimit: z.number().int().min(0).default(200),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Wall = z.infer<typeof WallSchema>;

export function defaultVault(): string {
  return process.env["MEMORY_VAULT"] ?? path.join(os.homedir(), ".memory");
}

/**
 * Where each agent keeps its sessions.
 *
 * These paths move between vendor releases, which is why `doctor` reports what
 * it actually found rather than what this function believes.
 */
export function defaultSources(): Record<string, string> {
  const home = os.homedir();
  const claudeRoot = process.env["CLAUDE_CONFIG_DIR"] ?? path.join(home, ".claude");
  const codexRoot = process.env["CODEX_HOME"] ?? path.join(home, ".codex");
  return {
    claudeCode: path.join(claudeRoot, "projects"),
    codex: path.join(codexRoot, "sessions"),
    gemini: path.join(home, ".gemini", "tmp"),
  };
}

export function configPath(vault: string): string {
  return path.join(vault, "engine.config.json");
}

export function loadConfig(vault: string): Config {
  const file = configPath(vault);
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Absent or unreadable config is not fatal: `doctor` must work before
    // `init`. It is also why walls default to empty *and* are warned about.
    raw = {};
  }
  const merged: Record<string, unknown> = {
    sources: defaultSources(),
    ...(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}),
    // The vault on the command line wins over whatever the file remembers.
    vault,
  };
  return ConfigSchema.parse(merged);
}

export function writeConfig(cfg: Config): void {
  writeFileAtomic(configPath(cfg.vault), `${JSON.stringify(cfg, null, 2)}\n`);
}

/**
 * Write the fields a newer schema added into a config file written by an
 * older one, so the user can see the policy they are now under rather than
 * having a default applied silently. Returns the names of the walls touched.
 *
 * Only `sameProvider` so far. The in-memory default already makes every wall
 * same-provider; this makes the file say so.
 */
export function migrateConfig(vault: string): string[] {
  const file = configPath(vault);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const walls = Array.isArray(raw["walls"]) ? (raw["walls"] as Array<Record<string, unknown>>) : [];
  const migrated: string[] = [];
  for (const w of walls) {
    if (w && typeof w === "object" && !("sameProvider" in w)) {
      w["sameProvider"] = true;
      migrated.push(String(w["name"] ?? "?"));
    }
  }
  if (migrated.length) writeFileAtomic(file, `${JSON.stringify(raw, null, 2)}\n`);
  return migrated;
}

/**
 * Canonical form for path comparison.
 *
 * Comparing raw path strings to enforce a security boundary is unsound on
 * Windows: `C:\PROGRA~1` and `C:\Program Files` are the same directory,
 * `C:/code` and `C:\code` are the same directory, and a symlink is the same
 * directory under a different name. Any of those mismatches would read as
 * "outside every wall", which fails *open* — the session gets sent. So the
 * real path is resolved when the directory exists, and the textual form is
 * normalized when it does not.
 */
export function canonical(p: string): string {
  let out = p;
  try {
    out = fs.realpathSync.native(p);
  } catch {
    out = path.resolve(p);
  }
  return out.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when `child` is `parent` or sits underneath it. */
function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

const SOURCE_AGENT: Record<string, AgentId> = { claudeCode: "claude-code", codex: "codex", gemini: "gemini" };

/**
 * The agent whose session store a transcript sits in, from its path alone.
 *
 * What lets `scan --file` take a transcript without being told who wrote
 * it: a session-end hook hands over a path, not a vendor. A file under no
 * configured root is null, never a guess — the wrong adapter would read it
 * as empty and the session would be filed as tiny.
 */
export function agentForSourceFile(cfg: Config, file: string): AgentId | null {
  const target = canonical(file);
  for (const [key, root] of Object.entries(cfg.sources)) {
    if (root && isUnder(target, canonical(root))) return SOURCE_AGENT[key] ?? null;
  }
  return null;
}

/**
 * The wall a session with no known working directory falls under.
 *
 * Unknown is not the same as unclassified: a folder the user never listed
 * was at least *seen*, while a session with no cwd could have come from
 * anywhere — a beneficiary case file as easily as a scratch script. So it is
 * walled off by construction and summarized locally, the same way the
 * redactor fails closed. Its name doubles as the project it files under.
 */
const UNKNOWN_WALL: Wall = { name: "unsorted", paths: [], localOnly: true, sameProvider: true };

/**
 * The wall governing a working directory. Never null: a cwd nobody can name
 * gets the synthetic local-only wall above.
 *
 * Longest match wins, so a nested exception inside a broader wall behaves the
 * way a reader of the config would expect.
 */
export function wallFor(cfg: Config, cwd: string | null): Wall | null {
  if (!cwd) return UNKNOWN_WALL;
  const target = canonical(cwd);
  let best: Wall | null = null;
  let bestLen = -1;
  for (const wall of cfg.walls) {
    for (const raw of wall.paths) {
      const base = canonical(raw);
      if (isUnder(target, base) && base.length > bestLen) {
        best = wall;
        bestLen = base.length;
      }
    }
  }
  return best;
}

/**
 * Three rules, on purpose.
 *
 * A session with no cwd stays local no matter what — see UNKNOWN_WALL. With
 * no walls defined at all the engine has no policy for the rest, and says so
 * loudly in `sila doctor` instead of pretending to protect anything. But once
 * a single wall exists the user has started classifying their folders, and
 * from that point an unlisted folder is an *unclassified* one — so it stays
 * local too. Being wrong that way costs a weaker note; the other way leaks.
 */
export function mayUseNetwork(cfg: Config, cwd: string | null): boolean {
  if (cfg.extractor.provider === "local") return false;
  const wall = wallFor(cfg, cwd);
  if (!wall) return cfg.walls.length === 0;
  return !wall.localOnly;
}

/**
 * Whether a session that may leave the machine is confined to its own
 * agent's CLI. The default is yes — for a listed wall, an unlisted folder and
 * an unknown cwd alike — because widening the circle must be a choice someone
 * wrote down, never the result of a folder nobody got around to listing.
 */
export function sameProviderFor(cfg: Config, cwd: string | null): boolean {
  return wallFor(cfg, cwd)?.sameProvider ?? true;
}

/** Where a session's text goes: kept here, to its agent's CLI, or to the configured provider. */
export type Destination =
  | { kind: "local" }
  | { kind: "cli"; clis: CliName[] }
  | { kind: "api"; model: string };

/**
 * Where a session's text goes, as the scan sends it — for doctor and the dry
 * run. Both used to name the config's defaults instead: on a fresh config
 * doctor said the API key was missing so extraction would be local, and the
 * dry run named the API model, while every session left for its own
 * agent's CLI. The scan's two rules, in its order: mayUseNetwork, then
 * sameProviderFor.
 */
export function destinationFor(cfg: Config, agent: AgentId, cwd: string | null): Destination {
  if (!mayUseNetwork(cfg, cwd)) return { kind: "local" };
  if (sameProviderFor(cfg, cwd)) return { kind: "cli", clis: [CLI_FOR_AGENT[agent]] };
  return cfg.extractor.provider === "cli"
    ? { kind: "cli", clis: [...cfg.extractor.cliOrder] }
    : { kind: "api", model: cfg.extractor.model };
}

const rootCache = new Map<string, string | null>();

/**
 * The repository root a working directory sits in: the nearest ancestor
 * (itself included) that holds a `.git` entry — a directory, or the file a
 * worktree leaves behind. Null when there is none.
 *
 * This is what makes a project one thing across agents. Codex started in
 * `backend/` and Claude Code started at the top are the same repository, and
 * a memory filed under "backend" would be invisible to the other.
 */
export function projectRootOf(cwd: string): string | null {
  const start = path.resolve(cwd);
  const cached = rootCache.get(start);
  if (cached !== undefined) return cached;
  let dir = start;
  let found: string | null = null;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(start, found);
  return found;
}

/**
 * The project a session belongs to: its wall's name, else the name of the
 * repository root, else the folder name.
 */
export function projectOf(cfg: Config, cwd: string | null): string {
  const wall = wallFor(cfg, cwd);
  if (wall) return wall.name;
  if (!cwd) return "unsorted";
  const dir = projectRootOf(cwd) ?? cwd;
  const base = path.basename(dir.replace(/[\\/]+$/, ""));
  return base || "unsorted";
}

/**
 * What the config says about injecting a project's brief: `true` is the
 * user's explicit approval, `false` a stop, `undefined` no word either way.
 * Matched on slugs, like `--project`.
 */
export function injectSetting(cfg: Config, project: string): boolean | undefined {
  const want = slug(project);
  for (const [name, on] of Object.entries(cfg.inject)) if (slug(name) === want) return on;
  return undefined;
}

/** Whether a project's brief may be written into its folder at all. */
export function injectAllowed(cfg: Config, project: string): boolean {
  return injectSetting(cfg, project) !== false;
}

/**
 * Write one project's inject switch into engine.config.json — the file, not
 * just the parsed copy, because the stop has to outlast this process: a
 * detached scan's warning lands in a log nobody reads, and only the file is
 * still there at the next scan. The file is edited as JSON rather than
 * re-serialized from the schema, so every other field stays as the user
 * wrote it; an existing entry under a slug-equal name is updated in place.
 */
export function setInjectSetting(cfg: Config, project: string, on: boolean): void {
  const file = configPath(cfg.vault);
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const inject = raw["inject"] && typeof raw["inject"] === "object" ? (raw["inject"] as Record<string, unknown>) : {};
  const want = slug(project);
  const name = Object.keys(inject).find((k) => slug(k) === want) ?? project;
  inject[name] = on;
  raw["inject"] = inject;
  writeFileAtomic(file, `${JSON.stringify(raw, null, 2)}\n`);
  cfg.inject[name] = on;
}

/**
 * The directory a project's agent files live in — where a brief gets
 * injected. A wall's first listed path when the session is walled, else the
 * repository root, else the cwd itself. Null for a session with no cwd.
 */
export function projectDirOf(cfg: Config, cwd: string | null): string | null {
  if (!cwd) return null;
  const wall = wallFor(cfg, cwd);
  if (wall && wall.paths.length) return wall.paths[0] ?? null;
  return projectRootOf(cwd) ?? cwd;
}
