import fs from "node:fs";
import path from "node:path";
import type { Activity, Adapter } from "./base.js";
import { UUID, contentToText, fingerprint, readJsonl, readJsonlBackward, walk } from "./base.js";
import type { RawSession, Role, Turn } from "../types.js";

/**
 * Layout:  <root>/<encoded-project-path>/<session-uuid>.jsonl
 *
 * The directory name is the project's absolute path with every
 * non-alphanumeric character replaced by "-", so it is lossy and cannot be
 * reversed reliably. We therefore take `cwd` from inside the records, which
 * every modern record carries, and fall back to the decoded folder name.
 *
 * Files beginning with "agent-" are subagent sidechains. They are skipped:
 * they duplicate the parent's work without carrying the parent's intent.
 */
export const claudeCodeAdapter: Adapter = {
  id: "claude-code",

  async discover(root: string): Promise<string[]> {
    if (!fs.existsSync(root)) return [];
    const files = await walk(root, (p) => p.endsWith(".jsonl"));
    return files.filter((f) => !path.basename(f).startsWith("agent-"));
  },

  /**
   * The file's name is the session: Claude Code names each transcript by its
   * session id. A resumed conversation opens a new file and copies the earlier
   * session's records into it first, under the earlier id — ff78b3bb opens
   * with 383 records of 67dab054, whose own file still sits beside it. Read by
   * its first record, it claimed 67dab054's id, the two files shared one row,
   * and each scan re-read one of them: 66 rewrites of that note from
   * 2026-09-24 to 26. The copied records are the other session's, read from
   * its own file; here they are skipped. A name that is not an id (an older
   * layout) falls back to the first record's, as before.
   */
  async parse(file: string): Promise<RawSession | null> {
    const turns: Turn[] = [];
    let cwd: string | null = null;
    const stem = path.basename(file, ".jsonl");
    const own = UUID.test(stem) ? stem : null;
    let sessionId: string | null = own;
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let pendingTools: string[] = [];
    const files = new Set<string>();

    for await (const rec of readJsonl(file)) {
      const type = String(rec["type"] ?? "");
      if (rec["isSidechain"] === true) continue;
      if (own && typeof rec["sessionId"] === "string" && rec["sessionId"] !== own) continue;

      if (typeof rec["cwd"] === "string" && !cwd) cwd = rec["cwd"] as string;
      if (typeof rec["sessionId"] === "string" && !sessionId) {
        sessionId = rec["sessionId"] as string;
      }
      const ts = typeof rec["timestamp"] === "string" ? (rec["timestamp"] as string) : undefined;
      if (ts) {
        if (!startedAt) startedAt = ts;
        endedAt = ts;
      }

      if (type !== "user" && type !== "assistant") continue;

      const msg = rec["message"];
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const role: Role = type === "user" ? "user" : "assistant";
      const { text, tools, files: touched } = contentToText(m["content"]);
      pendingTools.push(...tools);
      for (const f of touched) files.add(f);

      if (!text) continue;
      // A "user" record whose content is only a tool_result carries no intent.
      if (role === "user" && /^\s*\[?tool[_ ]result/i.test(text)) continue;

      turns.push({ role, text, ts });
      if (role === "assistant" && pendingTools.length) {
        turns.push({ role: "tool", text: "", tool: [...new Set(pendingTools)].join(",") });
        pendingTools = [];
      }
    }

    if (!turns.length) return null;

    if (!cwd) {
      // Best-effort decode of the encoded directory name.
      const dir = path.basename(path.dirname(file));
      cwd = dir.replace(/^-/, "/").replace(/-/g, "/");
    }

    const stat = fs.statSync(file);
    const id = sessionId || stem;
    return {
      id: `claude-code:${id}`,
      agent: "claude-code",
      sourceFile: file,
      cwd,
      startedAt,
      endedAt: endedAt ?? stat.mtime.toISOString(),
      turns,
      contentHash: fingerprint(file),
      files: [...files],
    };
  },

  // `claude --help` (2.1.251): `-r, --resume [value]  Resume a conversation
  // by session ID`. Sessions are filed per working directory, so the command
  // has to start there.
  resumeCommand(session: RawSession): string | null {
    if (!session.cwd) return null;
    const id = session.id.replace(/^claude-code:/, "");
    return `cd "${session.cwd}" && claude --resume ${id}`;
  },

  /**
   * Silence is not an ending. A turn waiting on a tool writes nothing until
   * the result comes back, and the mtime rule took that quiet for a closed
   * session: the scheduled scan of 2026-09-27 06:06:23Z read b46e21ae — a
   * session of this project — mid-turn, its last record a Bash call sent at
   * 06:02:45 whose result came at 06:07:04, and filed a claim at 0.95 that the
   * same session went on to disprove.
   *
   * The last conversational record says what the clock cannot. A prompt, or a
   * tool's result the model has not answered yet: the turn is running. An
   * assistant message asking for a tool — its `stop_reason` says so on every
   * block of the message, and the result would come after it: running. An
   * assistant message that asks for none ends the turn; so does the user's
   * interruption, and a local command's output (/model, /compact), after
   * which no model turn comes. Of the 159 transcripts on this machine on
   * 2026-09-28, 133 read as finished, 14 have no stamped record, and 11 end
   * on a prompt, a result or a tool call with nothing after — sessions closed
   * mid-turn, the newest three days old, which the six-hour cap in the scan
   * lets through; the one left, the session writing this, read as running.
   *
   * A subagent's records, where an older version wrote them inline, are not
   * this session's turn: the parent is waiting on the call that started it.
   */
  async activity(file: string): Promise<Activity | null> {
    let at: number | null = null;
    for (const rec of readJsonlBackward(file)) {
      if (at === null) {
        const t = Date.parse(typeof rec["timestamp"] === "string" ? (rec["timestamp"] as string) : "");
        if (!Number.isNaN(t)) at = t;
      }
      const type = rec["type"];
      if ((type !== "user" && type !== "assistant") || rec["isSidechain"] === true) continue;
      const msg = rec["message"];
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const busy = type === "assistant" ? asksForTool(m) : !closesTurn(m);
      return at === null ? null : { at, busy };
    }
    return at === null ? null : { at, busy: false };
  },
};

function asksForTool(m: Record<string, unknown>): boolean {
  if (m["stop_reason"] === "tool_use") return true;
  const c = m["content"];
  return Array.isArray(c) && c.some((b) => !!b && typeof b === "object" && (b as Record<string, unknown>)["type"] === "tool_use");
}

/** A user record no model turn follows: `[Request interrupted by user…]`, or what a local command printed. */
function closesTurn(m: Record<string, unknown>): boolean {
  const c = m["content"];
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((b) => (b && typeof b === "object" && typeof (b as Record<string, unknown>)["text"] === "string" ? (b as Record<string, unknown>)["text"] : "")).join("")
        : "";
  return /^\s*(\[Request interrupted by user|<local-command-std(out|err)>)/.test(text as string);
}
