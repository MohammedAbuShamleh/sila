import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Every write into the vault goes through here.
 *
 * A half-written subject file is worse than a missing one: the user opens it,
 * sees a truncated claim, and trusts it. temp + fsync + rename makes the file
 * either the old one or the new one, never a blend — rename is atomic within
 * a filesystem, and fsync before it is what makes the content durable rather
 * than merely visible.
 */

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file));
  // The pid/counter suffix keeps two concurrent writers from colliding on the
  // same temp path; the rename below still decides which one wins.
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

let tmpCounter = 0;

export function readFileIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Filename-safe without being ASCII-only.
 *
 * Arabic subject names are the common case here, so transliterating or
 * stripping them would make the vault unreadable to its owner — the one
 * property the whole design is built to preserve. Only characters that are
 * actually unsafe in a path are removed.
 */
export function slug(input: string): string {
  const unsafe = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  let swept = "";
  for (const ch of input.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    swept += code < 0x20 || code === 0x7f || unsafe.has(ch) ? " " : ch;
  }
  const cleaned = swept
    .replace(/[.\s]+$/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  // Windows reserves these stems regardless of extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return `_${cleaned}`;
  return (cleaned || "untitled").slice(0, 80);
}
