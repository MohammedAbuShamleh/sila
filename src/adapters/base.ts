import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { AgentId, RawSession } from "../types.js";

/**
 * What every adapter shares, and nothing more.
 *
 * `discover` and `parse` are separate so that a scan can decide what to skip
 * before paying to read it. That split is what makes a rescan over 700MB of
 * unchanged transcripts cost nothing.
 */
export interface Adapter {
  id: AgentId;
  discover(root: string): Promise<string[]>;
  parse(file: string): Promise<RawSession | null>;
  /**
   * The shell command that reopens this session in its own agent, when the
   * agent can do that by id. Vendor knowledge, so it lives here and not in
   * the pipeline. Null when the agent has no such command.
   */
  resumeCommand(session: RawSession): string | null;
  /**
   * When the agent last wrote to a transcript, and whether a turn of it is
   * still running — read from the records, because silence is not an ending
   * (constant 20): Codex's mtime stops at the file's first write, and Claude
   * Code's stops while a tool runs. Required, so that an agent cannot be
   * added without one; null when the records say nothing, and the mtime rule
   * alone then decides.
   */
  activity(file: string): Promise<Activity | null>;
}

export interface Activity {
  /** Epoch ms of the last record the agent stamped. */
  at: number;
  /** A turn has started and not finished. */
  busy: boolean;
}

export async function walk(root: string, keep: (p: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not a reason to abandon the scan
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && keep(p)) out.push(p);
    }
  }
  return out.sort();
}

/**
 * Line-by-line, never whole-file.
 *
 * These files reach hundreds of megabytes — a single transcript can exceed the
 * V8 string limit, so `JSON.parse` on the file is not slow, it throws. Reading
 * a line at a time also means a session still being written by a live agent
 * parses fine: the truncated final line fails its own `JSON.parse` and is
 * dropped, and everything before it is intact.
 */
export async function* readJsonl(file: string): AsyncGenerator<Record<string, unknown>> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.charAt(0) !== "{") continue;
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        yield rec as Record<string, unknown>;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * The same records, last first — for a question the end of a file answers.
 *
 * Read in chunks from the end, never whole: a line is decoded only once it
 * is complete, so a multibyte character split across two chunks is whole by
 * then, and a final line still being written fails its own `JSON.parse` and
 * is dropped, as in readJsonl. `maxBytes` bounds how far back it looks.
 */
export function* readJsonlBackward(file: string, maxBytes = 16 * 1024 * 1024): Generator<Record<string, unknown>> {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const floor = Math.max(0, size - maxBytes);
    let pos = size;
    let carry = Buffer.alloc(0);
    while (pos > floor) {
      const len = Math.min(64 * 1024, pos - floor);
      pos -= len;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      const buf = Buffer.concat([chunk, carry]);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        const rec = parseLine(buf.subarray(i + 1, end));
        if (rec) yield rec;
        end = i;
      }
      // What precedes the first newline began before this chunk — unless
      // this chunk starts the file, where it is the first line.
      carry = buf.subarray(0, end);
    }
    if (pos === 0 && carry.length) {
      const rec = parseLine(carry);
      if (rec) yield rec;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parseLine(bytes: Buffer): Record<string, unknown> | null {
  const trimmed = bytes.toString("utf8").trim();
  if (!trimmed || trimmed.charAt(0) !== "{") return null;
  try {
    const rec: unknown = JSON.parse(trimmed);
    return rec && typeof rec === "object" && !Array.isArray(rec) ? (rec as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Message content → the words a human would keep, plus the tool names.
 *
 * Tool *results* are dropped and never reassembled. They are around ninety
 * percent of the bytes in a transcript and carry essentially no durable
 * signal: a directory listing from March tells you nothing in June, while the
 * sentence "we're dropping Redis" tells you everything. Tool *names* survive
 * because the shape of the work is worth knowing; their output is not.
 *
 * This is the function to resist "fixing". Letting results back in does not
 * add information, it buries the information already here.
 */
export function contentToText(content: unknown): { text: string; tools: string[]; files: string[] } {
  const parts: string[] = [];
  const tools: string[] = [];
  const files: string[] = [];

  const visit = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;

    const b = node as Record<string, unknown>;
    const type = typeof b["type"] === "string" ? (b["type"] as string) : "";

    // Tool traffic: keep the name and the paths it touched, discard the
    // payload in both directions.
    if (type === "tool_use" || type === "function_call" || type === "custom_tool_call") {
      const name = b["name"];
      tools.push(typeof name === "string" && name ? name : "tool");
      collectFiles(b["input"] ?? b["arguments"] ?? b["args"], files);
      return;
    }
    if (type === "local_shell_call") {
      tools.push("shell");
      return;
    }
    if (
      type === "tool_result" ||
      type === "function_call_output" ||
      type === "custom_tool_call_output" ||
      type === "local_shell_call_output"
    ) {
      return;
    }
    // Reasoning is the model talking to itself. Not a memory.
    if (type === "thinking" || type === "redacted_thinking" || type === "reasoning") return;
    // Gemini shapes.
    if (b["functionCall"] && typeof b["functionCall"] === "object") {
      const fc = b["functionCall"] as Record<string, unknown>;
      const name = fc["name"];
      tools.push(typeof name === "string" && name ? name : "tool");
      collectFiles(fc["args"], files);
      return;
    }
    if (b["functionResponse"]) return;

    if (typeof b["text"] === "string") {
      parts.push(b["text"] as string);
      return;
    }
    if (typeof b["content"] === "string" || Array.isArray(b["content"])) {
      visit(b["content"]);
    }
  };

  visit(content);
  return { text: parts.join("\n").trim(), tools, files: [...new Set(files)].slice(0, 200) };
}

/** The argument names the three agents use for "which file". */
const FILE_KEYS = ["file_path", "path", "absolute_path", "notebook_path", "filePath"];

/**
 * The paths a tool call names, and nothing else from it.
 *
 * Claude Code and Gemini pass an object; Codex passes `arguments` as a JSON
 * string, and its `apply_patch` names files inside the patch text itself.
 * The rest of the call — the new content of an Edit, the command of a shell
 * call — is exactly what constant 7 keeps out.
 */
function collectFiles(input: unknown, out: string[]): void {
  let obj = input;
  if (typeof obj === "string") {
    for (const m of obj.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push((m[1] ?? "").trim());
    try {
      obj = JSON.parse(obj);
    } catch {
      return;
    }
  }
  if (!obj || typeof obj !== "object") return;
  const rec = obj as Record<string, unknown>;
  for (const k of FILE_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  // A patch tucked inside an object field (Codex's custom_tool_call).
  for (const k of ["input", "patch"]) {
    const v = rec[k];
    if (typeof v === "string") {
      for (const m of v.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push((m[1] ?? "").trim());
    }
  }
}

/**
 * Identity of a file's *content*, without reading it.
 *
 * Size plus mtime, not a hash: hashing 700MB on every scan to discover that
 * nothing changed would cost more than the work being avoided. The tradeoff is
 * that an edit preserving both size and mtime goes unnoticed, which for
 * append-only transcripts written by other programs does not happen —
 * and `--force` exists for when it does.
 */
export function fingerprint(file: string): string {
  const st = fs.statSync(file);
  return `${st.size}:${Math.floor(st.mtimeMs)}`;
}

/** A session id as all three agents write one. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
