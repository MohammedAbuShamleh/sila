import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./fsatomic.js";

/**
 * One scan at a time per vault.
 *
 * A session-end hook and `sila watch` can both start a scan, and two of them
 * at once would each write a reading of the same session — the index keeps
 * both. So a scan takes this lock first and the second one is told, not
 * queued: the hook's scan is cheap to lose because the next scan reads the
 * same files.
 *
 * The lock is a file created with O_EXCL, which is atomic on every platform
 * Node runs on. It records who holds it. A holder whose process is gone left
 * the lock behind by crashing, and it is taken over. A holder whose process
 * is alive keeps it, however old the lock is: age says nothing about a
 * machine that slept. On 2026-09-17 a scan slept eleven hours mid-run, the
 * first hook after waking took its lock for being old, and two scans ran
 * together for seventeen minutes. `--break-lock` is the way past a live
 * holder, for the rare case the user knows better — a hung scan, or a pid
 * the system has since given to another program.
 */

export class LockHeldError extends Error {
  constructor(
    readonly pid: number,
    readonly since: string,
  ) {
    super(pid ? `مسح آخر يعمل (pid ${pid} منذ ${since}${ageOf(since)})` : `ملف القفل غير مقروء — ربما يكتبه مسح بدأ للتو`);
    this.name = "LockHeldError";
  }
}

function ageOf(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  return minutes < 60 ? `، قبل ${minutes} دقيقة` : `، قبل ${Math.floor(minutes / 60)} ساعة`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours; that still counts.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Holder {
  pid: number;
  at: string;
  token: string;
}

/** Who holds the lock, or null when the file cannot be read as a lock. */
function readHolder(file: string): Holder | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const pid = typeof raw["pid"] === "number" ? raw["pid"] : 0;
    if (!pid) return null;
    return { pid, at: typeof raw["at"] === "string" ? raw["at"] : "", token: typeof raw["token"] === "string" ? raw["token"] : "" };
  } catch {
    return null;
  }
}

/**
 * Returns the release function. Throws LockHeldError while a live process
 * holds the lock, unless `breakLock` says to take it anyway.
 *
 * A lock file that cannot be read counts as held: the window between a
 * scan creating the file and writing into it is exactly when another scan
 * would find it empty, and "unreadable" must not mean "free".
 */
export function acquireLock(vault: string, opts: { breakLock?: boolean } = {}): () => void {
  const dir = path.join(vault, ".index");
  ensureDir(dir);
  const file = path.join(dir, "scan.lock");
  const token = crypto.randomUUID();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }));
      fs.closeSync(fd);
      return () => release(file, token);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readHolder(file);
      const live = holder === null || alive(holder.pid);
      if (live) {
        if (!opts.breakLock) throw new LockHeldError(holder?.pid ?? 0, holder?.at ?? "");
        process.stderr.write(
          `كسرتُ القفل${holder ? ` (pid ${holder.pid} منذ ${holder.at})` : " غير المقروء"} بـ--break-lock. إن كان ذلك المسح حيّاً فهما يعملان معاً الآن.\n`,
        );
      }
      // Dead holder, or broken on purpose: take it over and try once more.
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else took it first; the retry will say so */
      }
    }
  }
  throw new LockHeldError(0, "");
}

/**
 * Remove the lock only while it is still ours. A scan whose lock was broken
 * must not, when it finally ends, delete the lock of the scan that broke it
 * — that is how the vault was left unlocked with a scan still running.
 */
function release(file: string, token: string): void {
  if (readHolder(file)?.token !== token) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}
