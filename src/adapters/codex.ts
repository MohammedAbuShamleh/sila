import fs from "node:fs";
import path from "node:path";
import type { Activity, Adapter } from "./base.js";
import { UUID, contentToText, fingerprint, readJsonl, readJsonlBackward, walk } from "./base.js";
import type { RawSession, Role, Turn } from "../types.js";

/**
 * Layout:  <root>/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl, and archived
 *          threads flat in <root>/../archived_sessions/
 *
 * Unlike Claude Code, Codex does not bucket by project — it buckets by date.
 * The only link to a project is `cwd` inside the first `session_meta` record.
 * A session whose meta line is missing (crash, manual copy) falls back to the
 * filename stem for identity, which is what the CLI itself does on resume.
 *
 * `compacted` records replay earlier history and are skipped; including them
 * would duplicate half the conversation into the distilled text.
 */
export const codexAdapter: Adapter = {
  id: "codex",

  /**
   * An archived thread leaves the dated tree: the app moves its rollout,
   * whole and flat, to `archived_sessions` beside `sessions`. Six sessions of
   * April and May went there together on 2026-09-25, and their rows stayed
   * pending on a path that no longer existed — never to be tried again.
   * Same file, same id, so a session is one session wherever it sits.
   */
  async discover(root: string): Promise<string[]> {
    const keep = (p: string) => /rollout-.*\.jsonl$/.test(path.basename(p));
    const out = new Set<string>();
    for (const dir of [root, path.join(path.dirname(root), "archived_sessions")]) {
      if (fs.existsSync(dir)) for (const f of await walk(dir, keep)) out.add(f);
    }
    return [...out].sort();
  },

  async parse(file: string): Promise<RawSession | null> {
    const turns: Turn[] = [];
    let cwd: string | null = null;
    let sessionId: string | null = null;
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let pendingTools: string[] = [];
    const files = new Set<string>();

    for await (const rec of readJsonl(file)) {
      const type = String(rec["type"] ?? "");
      const ts = typeof rec["timestamp"] === "string" ? (rec["timestamp"] as string) : undefined;
      if (ts) {
        if (!startedAt) startedAt = ts;
        endedAt = ts;
      }

      if (type === "session_meta") {
        const payload = (rec["payload"] ?? {}) as Record<string, unknown>;
        if (typeof payload["cwd"] === "string") cwd = payload["cwd"] as string;
        if (typeof payload["id"] === "string") sessionId = payload["id"] as string;
        continue;
      }

      if (type === "compacted" || type === "turn_context" || type === "event_msg") continue;

      // Payload may sit under `payload` (response_item) or at the top level.
      const payload =
        rec["payload"] && typeof rec["payload"] === "object"
          ? (rec["payload"] as Record<string, unknown>)
          : rec;

      const ptype = String(payload["type"] ?? "");
      if (ptype === "function_call" || ptype === "local_shell_call" || ptype === "custom_tool_call") {
        // The same walker that reads message content reads a tool call: the
        // name is kept, the paths it names are kept, the arguments are not.
        const call = contentToText(payload);
        pendingTools.push(...(call.tools.length ? call.tools : ["tool"]));
        for (const f of call.files) files.add(f);
        continue;
      }
      if (ptype !== "message") continue;

      const rawRole = String(payload["role"] ?? "");
      if (rawRole !== "user" && rawRole !== "assistant") continue;
      const role: Role = rawRole;

      const { text, tools, files: touched } = contentToText(payload["content"]);
      pendingTools.push(...tools);
      for (const f of touched) files.add(f);
      if (!text) continue;

      // Codex speaks in the user's voice for its own bookkeeping: instruction
      // and environment preambles, and a `<turn_aborted>` notice after an
      // interruption. None of it is the user.
      if (role === "user" && /^<(user_instructions|environment_context|turn_aborted)/.test(text.trim())) continue;

      // The desktop app prefixes an approved plan with a fixed banner. The
      // plan is the user's intent; the banner is not, and it was the first
      // line of every such note.
      const cleaned = role === "user" ? text.replace(/^PLEASE IMPLEMENT THIS PLAN:\s*/, "") : text;
      if (!cleaned) continue;

      turns.push({ role, text: cleaned, ts });
      if (role === "assistant" && pendingTools.length) {
        turns.push({ role: "tool", text: "", tool: [...new Set(pendingTools)].join(",") });
        pendingTools = [];
      }
    }

    if (!turns.length) return null;

    const stat = fs.statSync(file);
    const stem = path.basename(file, ".jsonl");
    // The name's uuid is the thread's id — it agrees with session_meta in all
    // 22 rollouts on this machine — and it is read from the name, so that a
    // file carrying another thread's meta cannot claim that thread's row, as
    // a resumed Claude Code transcript did (see the claude-code adapter).
    const named = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(stem)?.[1];
    const id = (named && UUID.test(named) ? named : null) || sessionId || stem.replace(/^rollout-/, "");
    return {
      id: `codex:${id}`,
      agent: "codex",
      sourceFile: file,
      cwd,
      startedAt,
      endedAt: endedAt ?? stat.mtime.toISOString(),
      turns,
      contentHash: fingerprint(file),
      files: [...files],
    };
  },

  // UNVERIFIED: codex is not installed on the machine this was written on.
  // `codex resume <id>` is remembered, not read from `codex --help`; check it
  // before trusting the command a note prints.
  resumeCommand(session: RawSession): string | null {
    if (!session.cwd) return null;
    const id = session.id.replace(/^codex:/, "");
    return `cd "${session.cwd}" && codex resume ${id}`;
  },

  /**
   * The clock is in the records, not the file: Codex leaves a rollout's mtime
   * where its first write put it for as long as that writer appends. Measured
   * on 2026-09-26 — a Codex app thread grew from 1,147,388 to 1,771,099 bytes
   * over ten minutes with its mtime still at 10:48:59, and the scan's
   * two-minute rule read it mid-turn; three writes from node through one
   * handle moved the mtime each time, so it is not NTFS.
   *
   * A thread never closes — it is picked up whenever the user comes back —
   * but a turn does: `task_started` opens it and `task_complete` (or
   * `turn_aborted`) ends it. Whichever the file says last is the state; a
   * `thread_settings_applied` the app appends on opening a thread is neither.
   */
  async activity(file: string): Promise<Activity | null> {
    let at: number | null = null;
    for (const rec of readJsonlBackward(file)) {
      if (at === null) {
        const t = Date.parse(typeof rec["timestamp"] === "string" ? (rec["timestamp"] as string) : "");
        if (!Number.isNaN(t)) at = t;
      }
      if (rec["type"] !== "event_msg") continue;
      const kind = String(((rec["payload"] ?? {}) as Record<string, unknown>)["type"] ?? "");
      if (kind === "task_started") return at === null ? null : { at, busy: true };
      if (kind === "task_complete" || kind === "turn_aborted") return at === null ? null : { at, busy: false };
    }
    return at === null ? null : { at, busy: false };
  },
};
