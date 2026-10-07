import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../util/fsatomic.js";

/**
 * The undo button.
 *
 * Nothing in this engine deletes, but everything in it rewrites: a subject
 * file is regenerated whole every time one of its facts changes. Git is what
 * makes that reversible — a bad scan is `git revert`, not a restore from a
 * backup nobody made.
 *
 * Failure here is never fatal. A vault without git still works; it just has
 * no history. Refusing to save a note because `git` is not installed would
 * trade the whole feature for one of its guarantees.
 */
export type GitFileState = "tracked" | "untracked" | "ignored" | "none";

/**
 * Where a file stands with the repository around it — for a warning that
 * must stay silent in a folder that is not a repository at all. A missing
 * git binary reads as "none": no repository can be seen, so nothing is
 * claimed about one. The file itself need not exist yet; "untracked" then
 * means "would be committed by `git add -A`".
 */
export function gitStateOf(file: string): GitFileState {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const ok = (args: string[]): boolean => {
    try {
      execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };
  if (!ok(["rev-parse", "--is-inside-work-tree"])) return "none";
  if (ok(["ls-files", "--error-unmatch", "--", name])) return "tracked";
  if (ok(["check-ignore", "-q", "--", name])) return "ignored";
  return "untracked";
}

export class Git {
  constructor(
    private readonly vault: string,
    private readonly enabled: boolean,
  ) {}

  private run(args: string[]): string | null {
    if (!this.enabled) return null;
    try {
      // Hidden for the same reason as the CLI calls: a detached scan has no
      // console, and each git call would flash one onto the screen.
      return execFileSync("git", ["-C", this.vault, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // A log of every note's history outgrows the default megabyte.
        maxBuffer: 64 * 1024 * 1024,
      }).trim();
    } catch {
      return null;
    }
  }

  init(): void {
    if (!this.enabled) return;
    if (!fs.existsSync(path.join(this.vault, ".git"))) {
      this.run(["init", "--quiet"]);
      // The index is derived and disposable; committing a live SQLite file
      // would add a large binary delta on every run and gain nothing.
      const ignore = path.join(this.vault, ".gitignore");
      if (!fs.existsSync(ignore)) {
        writeFileAtomic(ignore, [".index/", "*.tmp", ""].join("\n"));
      }
    }
    // Only set identity if the machine has none, so a global config wins.
    if (!this.run(["config", "user.email"])) {
      this.run(["config", "user.email", "sila@localhost"]);
      this.run(["config", "user.name", "sila"]);
    }
  }

  /**
   * How many scan commits rewrote each session note in the last `days` days —
   * each one an extraction of that session, since a scan writes a note only
   * after reading it, and git keeps a rewrite only when the note changed. The
   * vault's history is the one record of every reading; the index keeps the
   * last. Null without git. Commits of `sila move`/`retract`/`restore` are
   * hands, not readings, and are not counted.
   */
  noteRewrites(days: number): Map<string, number> | null {
    if (!this.enabled || !fs.existsSync(path.join(this.vault, ".git"))) return null;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const log = this.run(["-c", "core.quotepath=false", "log", `--since=${since}`, "--format=%x1e%s", "--name-only", "--", "sessions/"]);
    if (log === null) return this.unborn() ? new Map() : null;
    const counts = new Map<string, number>();
    for (const entry of log.split("\x1e")) {
      const [subject = "", ...files] = entry.split("\n").map((l) => l.trim());
      if (!/^scan\b/.test(subject)) continue;
      for (const f of files) if (f.endsWith(".md")) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Every commit that touched each session note, newest first: when, and the
   * subject that says what made it — a reading ("scan…") or a hand. For
   * inferDigests, which asks whether a note's last reading is the one its
   * index row remembers. Null without git.
   */
  noteHistory(): Map<string, Array<{ at: string; subject: string }>> | null {
    if (!this.enabled || !fs.existsSync(path.join(this.vault, ".git"))) return null;
    const log = this.run(["-c", "core.quotepath=false", "log", "--format=%x1e%cI%x1f%s", "--name-only", "--", "sessions/"]);
    if (log === null) return this.unborn() ? new Map() : null;
    const out = new Map<string, Array<{ at: string; subject: string }>>();
    for (const entry of log.split("\x1e")) {
      const [head = "", ...files] = entry.split("\n").map((l) => l.trim());
      const [at = "", subject = ""] = head.split("\x1f");
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const list = out.get(f) ?? [];
        list.push({ at, subject });
        out.set(f, list);
      }
    }
    return out;
  }

  /**
   * A repository with no commit yet — what init leaves until the first scan
   * writes something. git log fails there, and that failure read as "no
   * git": doctor on a fresh vault said "بلا git" two lines under "git ✓".
   * No commit is no rewrite, not an unknown.
   */
  private unborn(): boolean {
    return this.run(["rev-parse", "--git-dir"]) !== null && this.run(["rev-parse", "--verify", "--quiet", "HEAD"]) === null;
  }

  /** Returns the short sha, or null when there was nothing to commit. */
  commit(message: string): string | null {
    if (!this.enabled) return null;
    if (!fs.existsSync(path.join(this.vault, ".git"))) return null;
    this.run(["add", "-A"]);
    const staged = this.run(["diff", "--cached", "--name-only"]);
    if (!staged) return null;
    if (this.run(["commit", "-q", "-m", message]) === null) return null;
    return this.run(["rev-parse", "--short", "HEAD"]);
  }
}
