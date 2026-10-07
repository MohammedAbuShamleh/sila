import assert from "node:assert/strict";
import { contentToText } from "../test-build/adapters/base.js";
import { claudeCodeAdapter } from "../test-build/adapters/claude-code.js";
import { codexAdapter } from "../test-build/adapters/codex.js";
import { geminiAdapter } from "../test-build/adapters/gemini.js";

/**
 * The resume block is only as good as what the adapters hand it: the paths a
 * session touched, and a command that reopens it. Both come from vendor
 * shapes that nothing else in the pipeline knows, so they are pinned here.
 */

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    process.stdout.write(`\n✗ ${name}\n  ${err.message.split("\n")[0]}\n`);
  }
}

// ---- paths out of tool calls, nothing else out of them ---------------------

check("claude code: Edit/Read/Write inputs yield their paths, not their contents", () => {
  const r = contentToText([
    { type: "text", text: "أعدّل الملف" },
    { type: "tool_use", name: "Edit", input: { file_path: "C:/app/src/a.ts", old_string: "x", new_string: "SECRET-CONTENT" } },
    { type: "tool_use", name: "Read", input: { file_path: "C:/app/src/b.ts" } },
    { type: "tool_use", name: "NotebookEdit", input: { notebook_path: "C:/app/n.ipynb", new_source: "print(1)" } },
    { type: "tool_result", content: "file contents that must not survive" },
  ]);
  assert.deepEqual(r.files, ["C:/app/src/a.ts", "C:/app/src/b.ts", "C:/app/n.ipynb"]);
  assert.deepEqual(r.tools, ["Edit", "Read", "NotebookEdit"]);
  assert.ok(!r.text.includes("SECRET-CONTENT"), "محتوى التعديل تسرّب");
  assert.ok(!r.text.includes("must not survive"), "مخرج الأداة تسرّب");
  assert.equal(r.text, "أعدّل الملف");
});

check("codex: a JSON `arguments` string and an apply_patch body both yield paths", () => {
  const call = contentToText({ type: "function_call", name: "shell", arguments: JSON.stringify({ path: "src/x.ts" }) });
  assert.deepEqual(call.files, ["src/x.ts"]);
  const patch = contentToText({
    type: "custom_tool_call",
    name: "apply_patch",
    input: "*** Begin Patch\n*** Update File: src/y.ts\n@@\n-old\n+new\n*** Add File: docs/z.md\n*** End Patch",
  });
  assert.deepEqual(patch.files, ["src/y.ts", "docs/z.md"]);
  assert.deepEqual(patch.tools, ["apply_patch"]);
});

check("gemini: functionCall args yield their path and the call's name", () => {
  const r = contentToText([{ functionCall: { name: "write_file", args: { file_path: "notes.md", content: "..." } }, thoughtSignature: "x" }]);
  assert.deepEqual(r.files, ["notes.md"]);
  assert.deepEqual(r.tools, ["write_file"]);
  assert.equal(r.text, "");
});

check("a path seen twice is listed once, in first-seen order", () => {
  const r = contentToText([
    { type: "tool_use", name: "Read", input: { file_path: "b.ts" } },
    { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
    { type: "tool_use", name: "Read", input: { file_path: "b.ts" } },
  ]);
  assert.deepEqual(r.files, ["b.ts", "a.ts"]);
});

// ---- the command that reopens a session ------------------------------------

const session = (agent, id, cwd) => ({ id, agent, sourceFile: "x", cwd, startedAt: null, endedAt: "", turns: [], contentHash: "1", files: [] });

check("claude code resumes by id from the project directory", () => {
  const cmd = claudeCodeAdapter.resumeCommand(session("claude-code", "claude-code:0123abcd-uuid", "D:/proj"));
  assert.equal(cmd, 'cd "D:/proj" && claude --resume 0123abcd-uuid');
});

check("gemini cannot resume by id, so it lists sessions instead", () => {
  const cmd = geminiAdapter.resumeCommand(session("gemini", "gemini:abc", "D:/proj"));
  assert.match(cmd, /^cd "D:\/proj" && gemini --list-sessions/);
  assert.ok(!cmd.includes("abc"), "أعطى معرّفاً لا يقبله gemini");
});

check("codex resume command carries its id (unverified against the CLI)", () => {
  const cmd = codexAdapter.resumeCommand(session("codex", "codex:019d-xyz", "D:/proj"));
  assert.equal(cmd, 'cd "D:/proj" && codex resume 019d-xyz');
});

check("no cwd, no command", () => {
  assert.equal(claudeCodeAdapter.resumeCommand(session("claude-code", "claude-code:1", null)), null);
  assert.equal(geminiAdapter.resumeCommand(session("gemini", "gemini:1", null)), null);
  assert.equal(codexAdapter.resumeCommand(session("codex", "codex:1", null)), null);
});

// ---- the file's name is the session ----------------------------------------

/**
 * A resumed Claude Code conversation opens a new file and copies the earlier
 * session's records into it first, under the earlier id: ff78b3bb opened with
 * 383 records of 67dab054. Read by its first record it took 67dab054's row,
 * and the two files were re-read by turns — 66 rewrites of one note.
 */
async function acheck(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    process.stdout.write(`\n✗ ${name}\n  ${err.message.split("\n")[0]}\n`);
  }
}
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-adapters-"));
const A = "67dab054-5297-49a8-8898-6e50defe1364";
const B = "ff78b3bb-f775-4286-ade0-73fe438bd1cf";
const cc = (sid, role, text, at) =>
  JSON.stringify({ type: role, sessionId: sid, cwd: "D:/p", timestamp: `2026-09-09T${at}.000Z`, message: { role, content: text } });
const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
};

await acheck("claude code: a resumed transcript is its own session, without the one it copied", async () => {
  const earlier = [cc(A, "user", "الطلب الأول", "15:37:29"), cc(A, "assistant", "تم الأول", "16:17:55")];
  const a = await claudeCodeAdapter.parse(write(path.join(tmp, "C--p", `${A}.jsonl`), earlier));
  const b = await claudeCodeAdapter.parse(
    write(path.join(tmp, "C--p", `${B}.jsonl`), [...earlier, cc(B, "user", "نكمل من حيث توقفنا", "16:38:21"), cc(B, "assistant", "تم الثاني", "17:00:00")]),
  );
  assert.equal(a.id, `claude-code:${A}`);
  assert.equal(b.id, `claude-code:${B}`, "الاستئناف أخذ معرّف الجلسة التي نسخها");
  assert.deepEqual(b.turns.map((t) => t.text), ["نكمل من حيث توقفنا", "تم الثاني"], "السجلات المنسوخة قُرئت مرتين");
  assert.equal(b.startedAt, "2026-09-09T16:38:21.000Z", "تاريخ الاستئناف تاريخ ما نسخه");
});

await acheck("claude code: a name that is no id falls back to the first record's", async () => {
  const s = await claudeCodeAdapter.parse(write(path.join(tmp, "C--q", "journal.jsonl"), [cc(A, "user", "نص", "10:00:00"), cc(A, "assistant", "رد", "10:01:00")]));
  assert.equal(s.id, `claude-code:${A}`);
});

await acheck("codex: the rollout's name decides, not a session_meta it carries", async () => {
  const meta = (id) => JSON.stringify({ timestamp: "2026-09-25T08:30:05.000Z", type: "session_meta", payload: { id, cwd: "D:/p" } });
  const msg = (role, text) => JSON.stringify({ timestamp: "2026-09-25T08:30:06.000Z", type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  const s = await codexAdapter.parse(write(path.join(tmp, "cx", `rollout-2026-09-25T11-27-50-${B}.jsonl`), [meta(A), msg("user", "نص"), msg("assistant", "رد")]));
  assert.equal(s.id, `codex:${B}`);
});

await acheck("gemini: a header naming another session does not take its row", async () => {
  const log = (sid) => [
    JSON.stringify({ sessionId: sid, startTime: "2026-09-15T18:49:00.000Z" }),
    JSON.stringify({ id: "m1", type: "user", timestamp: "2026-09-15T18:49:01.000Z", content: "نص" }),
    JSON.stringify({ id: "m2", type: "gemini", timestamp: "2026-09-15T18:49:02.000Z", content: "رد" }),
  ];
  const own = await geminiAdapter.parse(write(path.join(tmp, "gm", "p", "chats", "session-2026-09-15T18-49-a8dab1ed.jsonl"), log("a8dab1ed-0000-4000-8000-000000000000")));
  assert.equal(own.id, "gemini:a8dab1ed-0000-4000-8000-000000000000");
  const other = await geminiAdapter.parse(write(path.join(tmp, "gm", "p", "chats", "session-2026-09-15T19-02-44a6467d.jsonl"), log("a8dab1ed-0000-4000-8000-000000000000")));
  assert.equal(other.id, "gemini:session-2026-09-15T19-02-44a6467d");
});

fs.rmSync(tmp, { recursive: true, force: true });

process.stdout.write(`\nadapters: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
