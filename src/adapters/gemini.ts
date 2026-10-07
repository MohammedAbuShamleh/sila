import fs from "node:fs";
import path from "node:path";
import type { Activity, Adapter } from "./base.js";
import { contentToText, fingerprint, readJsonl, readJsonlBackward, walk } from "./base.js";
import type { RawSession, Role, Turn } from "../types.js";

/**
 * Layout:  <root>/<project-dir>/chats/session-<iso>-<short>.jsonl
 *          <root>/<project-dir>/.project_root   ← the real cwd, verbatim
 *
 * This is the least stable of the three formats and the only one that is not
 * an append-only transcript. It is a *mutation log*: a header line, then a
 * mix of bare message records (appended as they happen) and `$set` snapshots
 * that replace the entire message array.
 *
 * Which matters, because replaying it faithfully loses most of the session.
 * On a real 264-line log here, replay ended with 8 messages while 124 had been
 * appended along the way — Gemini rewrites its own history as it compacts. So
 * this adapter takes the *union* of every message it ever sees, ordered by
 * timestamp, then collapses repeated text at the turn level below.
 *
 * The tradeoff is deliberate and worth stating: the union can resurrect text
 * that a later compaction intentionally dropped, and can hold both sides of an
 * edit. For a memory engine that is the right side to err on — recall is the
 * scarce thing, and a stale claim is exactly what the confidence floor and the
 * reconciler exist to handle. Faithful replay would instead lose the user's
 * actual words, which nothing downstream can recover.
 *
 * `logs.json`, which sits beside `chats/`, is not read: it holds only user
 * prompts (a strict subset of what is here) and packs several sessions into
 * one file, which cannot satisfy the one-file-one-session contract above.
 */

interface GeminiMessage {
  id?: unknown;
  timestamp?: unknown;
  type?: unknown;
  content?: unknown;
}

export const geminiAdapter: Adapter = {
  id: "gemini",

  async discover(root: string): Promise<string[]> {
    if (!fs.existsSync(root)) return [];
    return walk(root, (p) => {
      const base = path.basename(p);
      return (
        base.endsWith(".jsonl") &&
        base.startsWith("session-") &&
        path.basename(path.dirname(p)) === "chats"
      );
    });
  },

  async parse(file: string): Promise<RawSession | null> {
    let sessionId: string | null = null;
    let startedAt: string | null = null;
    let lastUpdated: string | null = null;

    // Keyed by id and timestamp, which removes only exact re-emissions of the
    // same record. It is deliberately not the real deduplication: measured on
    // the logs here, 109 distinct ids carried just 50 distinct texts, and no
    // id ever appeared under two timestamps. Identity in this format is not
    // stable enough to dedupe on, so the turn loop dedupes on text instead.
    const seen = new Map<string, GeminiMessage>();
    let synthetic = 0;

    const absorb = (raw: unknown): void => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const m = raw as GeminiMessage;
      if (typeof m.type !== "string" || m.content === undefined) return;
      const id = typeof m.id === "string" ? m.id : `#${synthetic++}`;
      const ts = typeof m.timestamp === "string" ? m.timestamp : "";
      seen.set(`${id}@${ts}`, m);
    };

    for await (const rec of readJsonl(file)) {
      if (typeof rec["sessionId"] === "string" && !sessionId) {
        sessionId = rec["sessionId"] as string;
      }
      if (typeof rec["startTime"] === "string" && !startedAt) {
        startedAt = rec["startTime"] as string;
      }
      if (typeof rec["lastUpdated"] === "string") {
        lastUpdated = rec["lastUpdated"] as string;
      }

      const set = rec["$set"];
      if (set && typeof set === "object") {
        const msgs = (set as Record<string, unknown>)["messages"];
        if (Array.isArray(msgs)) for (const m of msgs) absorb(m);
        continue;
      }
      absorb(rec);
    }

    const ordered = [...seen.values()].sort((a, b) => {
      const ta = typeof a.timestamp === "string" ? a.timestamp : "";
      const tb = typeof b.timestamp === "string" ? b.timestamp : "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

    const turns: Turn[] = [];
    let pendingTools: string[] = [];
    const emitted = new Set<string>();
    const files = new Set<string>();

    for (const m of ordered) {
      const kind = String(m.type);
      // Only "user" and "gemini" are turns. "error" and "info" are the CLI
      // reporting on itself — including its own retry notices.
      if (kind !== "user" && kind !== "gemini") continue;
      const role: Role = kind === "user" ? "user" : "assistant";
      const ts = typeof m.timestamp === "string" ? m.timestamp : undefined;

      const { text, tools, files: touched } = contentToText(m.content);
      pendingTools.push(...tools);
      for (const f of touched) files.add(f);
      if (!text) continue;

      // The CLI speaks in the user's voice for its own bookkeeping: a
      // preamble on the first turn, and `[System: ...]` nudges after a tool
      // returns nothing. Neither is the user, and dropping them also lets the
      // repeat-collapse below see the copies it needs to collapse — they were
      // separated only by these injections.
      if (role === "user" && /^(<(session_context|environment_context)|\[System:)/.test(text.trim())) {
        continue;
      }

      // Collapse repeats of text already seen, anywhere in the session.
      //
      // The union above is what makes this necessary. Snapshots overlap, so
      // one logical message reappears in several of them — and the CLI also
      // re-appends the pending user message on every failed retry under a
      // fresh id (one real session here stored the same prompt 41 times).
      // Deduplicating by id sees none of that, and restricting the collapse
      // to *consecutive* turns misses the copies that straddle a reply.
      //
      // The cost, stated plainly: a user who genuinely types "نعم" twice
      // keeps only the first. That is a real loss, and the right one to
      // accept — a bare repeated word carries almost no extractable intent,
      // while a prompt duplicated 41 times crowds out everything else in the
      // distilled text, which is the one thing the extractor actually reads.
      const seenKey = `${role} ${text}`;
      if (emitted.has(seenKey)) continue;
      emitted.add(seenKey);

      turns.push(ts ? { role, text, ts } : { role, text });
      if (role === "assistant" && pendingTools.length) {
        turns.push({ role: "tool", text: "", tool: [...new Set(pendingTools)].join(",") });
        pendingTools = [];
      }
    }

    if (!turns.length) return null;

    const stat = fs.statSync(file);
    // The name carries the id's first eight digits (session-<iso>-<short>),
    // and all 8 logs on this machine agree. A header naming another session
    // does not get that session's row — the name decides, as it does for the
    // other two agents.
    const short = /-([0-9a-f]{8})$/i.exec(path.basename(file, ".jsonl"))?.[1]?.toLowerCase();
    const id = (sessionId && (!short || sessionId.toLowerCase().startsWith(short)) ? sessionId : null) || path.basename(file, ".jsonl");
    const firstTs = turns.find((t) => t.ts)?.ts ?? null;

    return {
      id: `gemini:${id}`,
      agent: "gemini",
      sourceFile: file,
      cwd: projectRootFor(file),
      startedAt: startedAt ?? firstTs,
      endedAt: lastUpdated ?? stat.mtime.toISOString(),
      turns,
      contentHash: fingerprint(file),
      files: [...files],
    };
  },

  // `gemini --help` (0.59.0): `--resume` takes "latest" or an index number,
  // never a session id, so the id we know cannot be handed to it. The nearest
  // honest command lists the sessions of that project so the index can be
  // picked; the comment on it says what to do next.
  resumeCommand(session: RawSession): string | null {
    if (!session.cwd) return null;
    return `cd "${session.cwd}" && gemini --list-sessions   # ثم gemini --resume <رقم الجلسة>`;
  },

  /**
   * Silence is not an ending here either (constant 20). The last message the
   * log holds decides, whether appended bare or as the last of a `$set`
   * snapshot: a user message the model has not answered is a running turn —
   * the CLI appends the prompt again on every retry, so a retry in progress
   * reads the same way; so is a model message carrying tool calls, whose
   * results go back to the model. And so is a model message with no words:
   * the CLI appends a model message before its tools have run and appends it
   * again, same id, once they have — in 1dfc00bd (2026-09-14) first bare and
   * then with its tool calls and `tokens`, in 44a6467d (09-15) first with
   * `tokens` and then with its tool calls — so while a tool runs the last
   * record is that message, with no tool calls and, in every such case here,
   * no text. A model message with words and no tool calls ends the turn, as
   * every final answer here does; so does an error nothing followed. `info`
   * records are the CLI's notes about itself and decide nothing.
   *
   * Built on thin evidence, and said so: two real sessions on this machine
   * (2026-09-30), one with tools, and six of the extractor's own calls. A
   * response with words and a tool call together, a cancelled turn and any
   * tool status but `success` have not been seen; the first would read as
   * ended while its tool runs, and a turn that ends in a way not seen here
   * stays open until the six-hour cap in the scan.
   */
  async activity(file: string): Promise<Activity | null> {
    let at: number | null = null;
    for (const rec of readJsonlBackward(file)) {
      const set = rec["$set"] && typeof rec["$set"] === "object" ? (rec["$set"] as Record<string, unknown>) : null;
      if (at === null) {
        const stamp = rec["timestamp"] ?? set?.["lastUpdated"] ?? rec["lastUpdated"];
        const t = Date.parse(typeof stamp === "string" ? stamp : "");
        if (!Number.isNaN(t)) at = t;
      }
      const messages = Array.isArray(set?.["messages"]) ? (set["messages"] as unknown[]) : [rec];
      for (let i = messages.length - 1; i >= 0; i--) {
        const busy = turnState(messages[i]);
        if (busy !== null) return at === null ? null : { at, busy };
      }
    }
    return at === null ? null : { at, busy: false };
  },
};

/** Whether a message says a turn is running; null for one that decides nothing — info, or not a message. */
function turnState(raw: unknown): boolean | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as GeminiMessage & { toolCalls?: unknown };
  if (m.type === "user") return true;
  if (m.type === "gemini") return (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) || !contentToText(m.content).text;
  if (m.type === "error") return false;
  return null;
}

/**
 * Gemini records the project path in a sibling file, so unlike Claude Code
 * there is nothing to decode and nothing to guess. Absent file means absent
 * project, and the session lands in "unsorted" rather than somewhere wrong.
 */
function projectRootFor(file: string): string | null {
  const marker = path.join(path.dirname(path.dirname(file)), ".project_root");
  try {
    const raw = fs.readFileSync(marker, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}
