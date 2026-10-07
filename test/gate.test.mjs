import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../test-build/config.js";
import { scan } from "../test-build/pipeline/run.js";
import { rebuildIndex } from "../test-build/pipeline/reindex.js";
import { Store } from "../test-build/store/db.js";
import { parseFactsTrailer, retractInNote } from "../test-build/store/vault.js";
import { fingerprint } from "../test-build/adapters/base.js";

/**
 * What lets a transcript through to the model.
 *
 * The file fingerprint is the cheap gate; the distilled text is the one that
 * decides. The case that made it: the Codex app appends a
 * `thread_settings_applied` record whenever an old thread is opened, and the
 * 25 September session grew by one such line on 2026-09-26 with its text
 * unchanged. The scans here are the real ones — adapter, distill, note —
 * with the CLI replaced by the runner seam, so no model is called.
 */

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    process.stdout.write(`\n✗ ${name}\n  ${err.message.split("\n")[0]}\n`);
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gate-"));
const cwd = path.join(base, "proj");
fs.mkdirSync(cwd, { recursive: true });

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: "fake" };
let asked = [];
const runner = async (name) => {
  asked.push(name);
  return {
    text: JSON.stringify({
      title: "جلسة",
      summary: "عمل على المشروع",
      facts: [{ subject: "proj", subjectKind: "project", key: "stack.db", claim: "القاعدة Postgres", confidence: 0.95 }],
    }),
    usage,
  };
};

const ID = "01a0d7ad-8d59-7881-a481-9446d863f97f";
const say = "نعمل على المشروع ونقرّر أين تعيش البيانات وكيف تُقرأ ولماذا. ".repeat(6);
const rec = (type, payload, at) => JSON.stringify({ timestamp: `2026-09-25T${at}.000Z`, type, payload });
const turn = (text, at) => [
  rec("event_msg", { type: "task_started" }, at),
  rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }, at),
  rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "تم." }] }, at),
  rec("event_msg", { type: "task_complete" }, at),
];

/** A Codex rollout of one finished turn, written long enough ago to be closed. */
function rollout(root, lines) {
  const file = path.join(root, "2026", "09", "25", `rollout-2026-09-25T11-27-50-${ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  aged(file);
  return file;
}
/** Past the two-minute rule, and a second later than the last write so the fingerprint moves. */
let tick = 0;
function aged(file) {
  const t = new Date(Date.UTC(2026, 8, 25, 12, 0, tick++));
  fs.utimesSync(file, t, t);
}
function append(file, line) {
  fs.appendFileSync(file, line + "\n");
  aged(file);
}

function setup(tag, extra = {}) {
  const dir = path.join(base, tag);
  const src = path.join(dir, "cx");
  const cfg = ConfigSchema.parse({
    vault: path.join(dir, "vault"),
    sources: { codex: src },
    extractor: { provider: "cli", cliOrder: ["codex"] },
    git: false,
    briefSync: false,
    ...extra,
  });
  const file = rollout(src, [rec("session_meta", { id: ID, cwd }, "08:30:05"), ...turn(say, "08:30:07")]);
  return { cfg, file };
}
const opts = { limit: 100, concurrency: 1, dryRun: false, force: false, runner };
const row = (cfg) => {
  const s = new Store(cfg.vault);
  try {
    return s.getSession(`codex:${ID}`);
  } finally {
    s.close();
  }
};
const trailer = (cfg) => parseFactsTrailer(fs.readFileSync(path.join(cfg.vault, row(cfg).note_path), "utf8"));

await check("the note's trailer carries the digest of the text it was read from", async () => {
  const { cfg } = setup("digest");
  asked = [];
  await scan(cfg, opts);
  assert.deepEqual(asked, ["codex"]);
  assert.match(trailer(cfg)?.distilled ?? "", /^[0-9a-f]{64}$/, "لا بصمة في ذيل الملاحظة");
});

await check("a line the app appends on opening a thread moves the file, not the text: no call", async () => {
  const { cfg, file } = setup("settings");
  await scan(cfg, opts);
  const before = trailer(cfg).distilled;
  append(file, rec("event_msg", { type: "thread_settings_applied", thread_id: ID }, "10:46:50"));
  asked = [];
  const r = await scan(cfg, opts);
  assert.deepEqual(asked, [], "أُرسل نص لم يتغيّر إلى النموذج");
  assert.equal(r.unchangedText, 1);
  assert.equal(r.processed, 0);
  assert.equal(row(cfg).content_hash, fingerprint(file), "البصمة الجديدة لم تُسجَّل");
  assert.equal(trailer(cfg).distilled, before, "الملاحظة أُعيدت كتابتها");
  // And the next scan passes it at the cheap gate, without a read.
  const again = await scan(cfg, opts);
  assert.equal(again.unchangedText, 0);
  assert.equal(again.skippedUnchanged, 1);
});

await check("a new turn changes the text: read again, and the digest moves", async () => {
  const { cfg, file } = setup("turn");
  await scan(cfg, opts);
  const before = trailer(cfg).distilled;
  for (const l of turn(`${say} والآن نضيف الطوابير.`, "09:34:14")) append(file, l);
  asked = [];
  const r = await scan(cfg, opts);
  assert.deepEqual(asked, ["codex"]);
  assert.equal(r.unchangedText, 0);
  assert.notEqual(trailer(cfg).distilled, before);
});

await check("--force reads the same text again", async () => {
  const { cfg } = setup("force");
  await scan(cfg, opts);
  asked = [];
  await scan(cfg, { ...opts, force: true });
  assert.deepEqual(asked, ["codex"]);
});

await check("after reindex the index knows no fingerprint, and the note's digest spares the call", async () => {
  const { cfg } = setup("reindex");
  await scan(cfg, opts);
  rebuildIndex(cfg);
  assert.equal(row(cfg).content_hash, "REINDEXED");
  asked = [];
  const r = await scan(cfg, opts);
  assert.deepEqual(asked, [], "إعادة البناء أرسلت الجلسة إلى النموذج ثانية");
  assert.equal(r.unchangedText, 1);
});

await check("a hand's rewrite of the note keeps its digest (sila retract)", async () => {
  const { cfg } = setup("retract");
  await scan(cfg, opts);
  const before = trailer(cfg).distilled;
  const notePath = path.join(cfg.vault, row(cfg).note_path);
  assert.ok(retractInNote(notePath, "proj", "stack.db", new Date().toISOString(), "اختبار"));
  assert.equal(trailer(cfg).facts.length, 0, "لم يُسحب شيء");
  assert.equal(trailer(cfg).distilled, before, "السحب أسقط البصمة");
});

await check("a local note is read by the model once it may be, whatever the digest", async () => {
  const walled = (localOnly) => ({ walls: [{ name: "proj", paths: [cwd], localOnly, sameProvider: true }] });
  const { cfg, file } = setup("local", walled(true));
  asked = [];
  await scan(cfg, opts);
  assert.deepEqual(asked, [], "جدار محلي أرسل إلى النموذج");
  append(file, rec("event_msg", { type: "thread_settings_applied", thread_id: ID }, "10:46:50"));
  const open = ConfigSchema.parse({ ...cfg, ...walled(false) });
  await scan(open, opts);
  assert.deepEqual(asked, ["codex"], "ملاحظة محلية بقيت محلية لأن نصها لم يتغيّر");
});

/**
 * When a Codex session is still going. Its rollout's mtime stays where the
 * first write put it, so the records are the clock: the last stamp, and
 * whether the last turn marker is a start or an end. Stamps here are relative
 * to now; the file's mtime is an hour old, as Codex leaves it, so the
 * two-minute rule on mtime sees nothing.
 */
const MIN = 60_000;
const recAgo = (type, payload, ago) => JSON.stringify({ timestamp: new Date(Date.now() - ago).toISOString(), type, payload });
const user = (text, ago) => recAgo("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }, ago);
const said = (ago) => recAgo("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "أعمل." }] }, ago);
const marker = (kind, ago) => recAgo("event_msg", { type: kind }, ago);

function live(tag, lines) {
  const dir = path.join(base, tag);
  const src = path.join(dir, "cx");
  const cfg = ConfigSchema.parse({
    vault: path.join(dir, "vault"),
    sources: { codex: src },
    extractor: { provider: "cli", cliOrder: ["codex"] },
    git: false,
    briefSync: false,
  });
  const file = path.join(src, "2026", "09", "26", `rollout-2026-09-26T13-48-58-${ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [recAgo("session_meta", { id: ID, cwd }, 60 * MIN), ...lines].join("\n") + "\n");
  const t = new Date(Date.now() - 60 * MIN);
  fs.utimesSync(file, t, t);
  return { cfg, file };
}
const started = (ago) => [marker("task_started", ago), user(say, ago), said(ago)];

await check("a turn still running is open, though its mtime is an hour old", async () => {
  const { cfg } = live("busy", [...started(50 * MIN), said(10 * MIN)]);
  asked = [];
  const r = await scan(cfg, opts);
  assert.deepEqual(asked, [], "قُرئت جلسة في منتصف دورها");
  assert.equal(r.skippedOpen, 1);
});

await check("a turn silent for six hours is over: the agent died, the session is read", async () => {
  const { cfg } = live("dead", [...started(7 * 60 * MIN), said(6 * 60 * MIN + MIN)]);
  asked = [];
  await scan(cfg, opts);
  assert.deepEqual(asked, ["codex"]);
});

await check("a finished turn a minute ago is still open; five minutes ago it is not", async () => {
  const fresh = live("fresh", [...started(20 * MIN), marker("task_complete", MIN)]);
  asked = [];
  const r = await scan(fresh.cfg, opts);
  assert.deepEqual(asked, [], "دور انتهى قبل دقيقة قُرئ");
  assert.equal(r.skippedOpen, 1);
  const quiet = live("quiet", [...started(20 * MIN), marker("task_complete", 5 * MIN)]);
  await scan(quiet.cfg, opts);
  assert.deepEqual(asked, ["codex"]);
});

await check("the turn's start is found however far back it is", async () => {
  // Well past one 64KB chunk of records since task_started, and a last line
  // cut off mid-write.
  const long = Array.from({ length: 300 }, (_, i) => said(40 * MIN - i * 1000).replace("أعمل.", `أعمل. ${"ـ".repeat(600)}`));
  const { cfg, file } = live("long", [...started(45 * MIN), ...long]);
  fs.appendFileSync(file, '{"timestamp":"2026-09-26T');
  const t = new Date(Date.now() - 60 * MIN);
  fs.utimesSync(file, t, t);
  assert.ok(fs.statSync(file).size > 3 * 64 * 1024);
  asked = [];
  const r = await scan(cfg, opts);
  assert.deepEqual(asked, [], "بداية الدور البعيدة لم تُرَ");
  assert.equal(r.skippedOpen, 1);
});

await check("--file reads a running turn, as the mtime rule lets it", async () => {
  const { cfg, file } = live("named", [...started(50 * MIN), said(10 * MIN)]);
  asked = [];
  await scan(cfg, { ...opts, onlyFile: file });
  assert.deepEqual(asked, ["codex"]);
});

await check("the summary counts each provider apart, and says when one names no price", async () => {
  const { usageLines } = await import("../test-build/pipeline/run.js");
  const { cfg } = setup("usage");
  const costly = async () => ({
    text: JSON.stringify({ title: "ج", summary: "س", facts: [] }),
    usage: { inputTokens: 10004, outputTokens: 9, cacheReadTokens: 8192, cacheWriteTokens: 0, model: "codex" },
  });
  const r = await scan(cfg, { ...opts, runner: costly });
  assert.deepEqual(Object.keys(r.usageBy), ["codex"], "النداء لم يُنسب إلى من أجاب");
  assert.equal(r.usageBy.codex.calls, 1);
  assert.equal(r.usageBy.codex.inputTokens, 10004);
  const lines = usageLines({ ...r.usageBy, claude: { ...r.usageBy.codex, model: "c", costUsd: 0.0523, calls: 2 } });
  assert.match(lines, /claude 2 · .* · \$0\.0523/);
  assert.match(lines, /codex 1 · رموز 10004↓ 9↑ · من الذاكرة المؤقتة 8192 · بلا سعر من المزوّد/);
});

await check("doctor's open line names what the scan would leave alone, and why", async () => {
  const { openSessions } = await import("../test-build/pipeline/run.js");
  const busy = live("doctor", [...started(50 * MIN), said(10 * MIN)]);
  // A second, finished long ago, beside it: not open.
  const done = path.join(path.dirname(busy.file), `rollout-2026-09-26T09-00-00-${"1".repeat(8)}-0000-7000-8000-000000000000.jsonl`);
  fs.writeFileSync(done, [recAgo("session_meta", { id: "x", cwd }, 90 * MIN), ...started(80 * MIN), marker("task_complete", 70 * MIN)].join("\n") + "\n");
  const old = new Date(Date.now() - 60 * MIN);
  fs.utimesSync(done, old, old);
  // And a Claude Code transcript written seconds ago: open by its mtime.
  const cc = path.join(base, "doctor", "cc", "C--proj", "s.jsonl");
  fs.mkdirSync(path.dirname(cc), { recursive: true });
  fs.writeFileSync(cc, "{}\n");
  const open = await openSessions(ConfigSchema.parse({ ...busy.cfg, sources: { codex: busy.cfg.sources.codex, claudeCode: path.join(base, "doctor", "cc") } }));
  const seen = open.map((o) => `${o.agent} ${o.why} ${path.basename(o.file)}`).sort();
  assert.deepEqual(seen, [`claude-code mtime s.jsonl`, `codex busy ${path.basename(busy.file)}`]);
});

await check("doctor counts readings of a session in the vault's week of scan commits — hands and old weeks aside", async () => {
  const { execFileSync } = await import("node:child_process");
  const { Git } = await import("../test-build/store/git.js");
  const { frequentRereads } = await import("../test-build/pipeline/run.js");
  const repo = path.join(base, "rereads");
  fs.mkdirSync(path.join(repo, "sessions", "2026", "09"), { recursive: true });
  const git = (args, when) =>
    execFileSync("git", ["-C", repo, ...args], {
      stdio: "ignore",
      env: { ...process.env, ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}) },
    });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  let n = 0;
  const rewrite = (note, subject, when) => {
    fs.writeFileSync(path.join(repo, "sessions", "2026", "09", note), `${n++}\n`);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", subject], when);
  };
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  for (let i = 0; i < 5; i++) rewrite("z.md", "scan: 1 جلسة", old); // last month's churn
  for (let i = 0; i < 4; i++) rewrite("x.md", i % 2 ? "scan --file: 1 جلسة" : "scan: 1 جلسة");
  for (let i = 0; i < 2; i++) rewrite("x.md", "move: نقل خانة"); // a hand, not a reading
  for (let i = 0; i < 3; i++) rewrite("y.md", "scan: 1 جلسة");
  assert.deepEqual(frequentRereads(new Git(repo, true)), [{ note: "sessions/2026/09/x.md", count: 4 }]);
  assert.equal(frequentRereads(new Git(repo, false)), null, "بلا git لا عدّ");
});

/**
 * When a Claude Code session is still going. Its mtime is a clock, but one
 * that stops while a tool runs: the scheduled scan of 2026-09-27 06:06:23.647Z
 * read b46e21ae mid-turn. The fixture has the shape of that transcript's last
 * 13 records as they stood then — the same record kinds in the same order,
 * the same keys, timestamps and stop reasons — with every text, id and path
 * made up: it ends, as the real one did, on a Bash call sent at 06:02:45.695Z
 * whose result had not come, and its mtime is that record's write. The real
 * records were the user's session, and the test needs only their shape
 * (2026-10-05, the user's call: the test stays, the text goes).
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/claude-code-b46e21ae-0606.jsonl", import.meta.url));
const B46 = "b46e21ae-853a-4549-afaf-d1858aade7ef";
const SCANNED = Date.parse("2026-09-27T06:06:23.647Z");
const LAST_WRITE = Date.parse("2026-09-27T06:02:45.695Z");

function transcript(tag, body, mtimeMs) {
  const dir = path.join(base, tag);
  const src = path.join(dir, "cc");
  const cfg = ConfigSchema.parse({
    vault: path.join(dir, "vault"),
    sources: { claudeCode: src },
    extractor: { provider: "cli", cliOrder: ["claude"] },
    // The fixture holds the end of the turn, not the prompt that opened it.
    minUserChars: 0,
    git: false,
    briefSync: false,
  });
  const file = path.join(src, "C--Users--dev-project", `${B46}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return { cfg, file };
}

await check("b46e21ae at 06:06: the mtime rule let a live turn through, and the model was asked", async () => {
  const { claudeCodeAdapter } = await import("../test-build/adapters/claude-code.js");
  const { OPEN_SESSION_MS } = await import("../test-build/pipeline/run.js");
  const { cfg } = transcript("b46-mtime", fs.readFileSync(FIXTURE), LAST_WRITE);
  assert.ok(SCANNED - LAST_WRITE >= OPEN_SESSION_MS, "القاعدة الزمنية كانت سترى الجلسة مفتوحة");
  // The records saying nothing: the mtime rule alone, as the scan had it then.
  const clock = claudeCodeAdapter.activity;
  claudeCodeAdapter.activity = async () => null;
  try {
    asked = [];
    const r = await scan(cfg, { ...opts, now: SCANNED });
    assert.deepEqual(asked, ["claude"]);
    assert.equal(r.skippedOpen, 0);
  } finally {
    claudeCodeAdapter.activity = clock;
  }
});

await check("b46e21ae at 06:06: a Bash call with no result keeps the turn open", async () => {
  const { claudeCodeAdapter } = await import("../test-build/adapters/claude-code.js");
  const { cfg, file } = transcript("b46-clock", fs.readFileSync(FIXTURE), LAST_WRITE);
  assert.deepEqual(await claudeCodeAdapter.activity(file), { at: LAST_WRITE, busy: true });
  asked = [];
  const r = await scan(cfg, { ...opts, now: SCANNED });
  assert.deepEqual(asked, [], "قُرئت جلسة في منتصف دورها");
  assert.equal(r.skippedOpen, 1);
  assert.equal(r.processed, 0);
  // Six hours on with no result, the agent is dead: read as it stands.
  const r2 = await scan(cfg, { ...opts, now: LAST_WRITE + 6 * 60 * MIN + MIN });
  assert.deepEqual(asked, ["claude"]);
  assert.equal(r2.processed, 1);
});

await check("b46e21ae at 06:06: --file reads it, as the hook's scan does", async () => {
  const { cfg, file } = transcript("b46-file", fs.readFileSync(FIXTURE), LAST_WRITE);
  asked = [];
  await scan(cfg, { ...opts, now: SCANNED, onlyFile: file });
  assert.deepEqual(asked, ["claude"]);
});

/** Claude Code records, relative to now: what the last conversational one says of the turn. */
const ccRec = (type, content, ago, extra = {}) =>
  JSON.stringify({
    type,
    sessionId: B46,
    isSidechain: false,
    timestamp: new Date(Date.now() - ago).toISOString(),
    message: { role: type, content, ...(type === "assistant" ? { stop_reason: extra.stop ?? "end_turn" } : {}) },
    ...extra.rec,
  });
const prompt = (ago) => ccRec("user", say, ago);
const calls = (ago) => ccRec("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 300" } }], ago, { stop: "tool_use" });
const result = (ago) => ccRec("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], ago);
const answers = (ago) => ccRec("assistant", [{ type: "text", text: "تم." }], ago);

await check("the last conversational record says whether a Claude Code turn is running", async () => {
  const { claudeCodeAdapter } = await import("../test-build/adapters/claude-code.js");
  const cases = [
    ["a prompt not yet answered", [prompt(10 * MIN)], true],
    ["a tool's result the model has not answered", [prompt(20 * MIN), calls(15 * MIN), result(10 * MIN)], true],
    ["text on its way to a tool call: stop_reason says so", [prompt(20 * MIN), ccRec("assistant", [{ type: "text", text: "أشغّل الاختبارات." }], 10 * MIN, { stop: "tool_use" })], true],
    ["a subagent's closing words, the parent still waiting on it", [prompt(20 * MIN), calls(15 * MIN), ccRec("assistant", [{ type: "text", text: "انتهيت." }], 10 * MIN, { rec: { isSidechain: true } })], true],
    ["an answer that asks for no tool", [prompt(20 * MIN), calls(15 * MIN), result(12 * MIN), answers(10 * MIN)], false],
    ["the user's interruption", [prompt(20 * MIN), calls(15 * MIN), ccRec("user", [{ type: "text", text: "[Request interrupted by user for tool use]" }], 10 * MIN)], false],
    ["a local command's output", [prompt(20 * MIN), answers(15 * MIN), ccRec("user", "<command-name>/model</command-name>", 10 * MIN), ccRec("user", "<local-command-stdout>Set model to opus</local-command-stdout>", 10 * MIN)], false],
  ];
  for (const [i, [name, lines, busy]] of cases.entries()) {
    const { file } = transcript(`cc-case-${i}`, lines.join("\n") + "\n", Date.now() - 60 * MIN);
    assert.equal((await claudeCodeAdapter.activity(file))?.busy, busy, name);
  }
});

await check("a Claude Code turn finished a minute ago is still open; five minutes ago it is not", async () => {
  const fresh = transcript("cc-fresh", [prompt(20 * MIN), answers(MIN)].join("\n") + "\n", Date.now() - 60 * MIN);
  asked = [];
  const r = await scan(fresh.cfg, opts);
  assert.deepEqual(asked, [], "دور انتهى قبل دقيقة قُرئ");
  assert.equal(r.skippedOpen, 1);
  const quiet = transcript("cc-quiet", [prompt(20 * MIN), answers(5 * MIN)].join("\n") + "\n", Date.now() - 60 * MIN);
  await scan(quiet.cfg, opts);
  assert.deepEqual(asked, ["claude"]);
});

/**
 * An archived Codex thread moves, whole, from the dated tree to
 * `archived_sessions` beside it. The six of April and May sat pending on a
 * path that no longer existed.
 */
function archive(cfg, file) {
  const to = path.join(path.dirname(cfg.sources.codex), "archived_sessions", path.basename(file));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(file, to);
  return to;
}

await check("discover walks archived_sessions beside the dated tree", async () => {
  const { cfg, file } = setup("discover");
  const kept = path.join(path.dirname(file), `rollout-2026-09-25T12-00-00-${"0".repeat(8)}-0000-7000-8000-000000000000.jsonl`);
  fs.copyFileSync(file, kept);
  const moved = archive(cfg, file);
  const { codexAdapter } = await import("../test-build/adapters/codex.js");
  assert.deepEqual(await codexAdapter.discover(cfg.sources.codex), [moved, kept].sort());
});

await check("a pending session archived before its CLI answered is read from where it went", async () => {
  const { cfg, file } = setup("pending-archived");
  const failing = async () => {
    throw new Error("codex غير مثبّت");
  };
  await scan(cfg, { ...opts, runner: failing });
  assert.equal(row(cfg).status, "pending-extraction");
  const moved = archive(cfg, file);
  asked = [];
  await scan(cfg, opts);
  assert.deepEqual(asked, ["codex"], "جلسة معلّقة أُرشفت لم تُقرأ");
  assert.equal(row(cfg).status, "ok");
  assert.equal(row(cfg).source_file, moved);
});

await check("a session read before it was archived costs nothing when it moves", async () => {
  const { cfg, file } = setup("read-archived");
  await scan(cfg, opts);
  append(file, rec("event_msg", { type: "thread_settings_applied", thread_id: ID }, "07:48:52"));
  const moved = archive(cfg, file);
  asked = [];
  const r = await scan(cfg, opts);
  assert.deepEqual(asked, []);
  assert.equal(r.unchangedText, 1);
  assert.equal(row(cfg).source_file, moved, "المسار الجديد لم يُسجَّل");
  // And the next scan passes it at the cheap gate, under its new path.
  const again = await scan(cfg, opts);
  assert.equal(again.skippedUnchanged, 1, "الملف المنقول يُحلَّل في كل مسح");
});

/**
 * A provider that will not answer. Codex's limit on 2026-09-26 left seven
 * sessions waiting, and what the scan kept of its notice stopped at 160
 * characters — before "try again at 8:43 PM", the one part worth reading;
 * `sila stats` said "6" and nothing else.
 */
const LIMIT = "error: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:43 PM.";
const refusing = (message) => async (name) => {
  asked.push(name);
  throw new Error(message);
};

await check("the provider's words are kept whole, on one line, and redacted on their way into the vault", async () => {
  const { cfg } = setup("limit");
  // Prefix and body joined at run time, so a secret scanner never sees a whole token (see redaction.test.mjs)
  const wrapped = LIMIT.replace(" Upgrade", "\n  Upgrade") + " ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const r = await scan(cfg, { ...opts, runner: refusing(wrapped) });
  assert.equal(r.pendingExtraction, 1);
  const detail = row(cfg).detail;
  assert.ok(detail.includes("try again at 8:43 PM."), `قُصّت الرسالة: ${detail}`);
  assert.ok(!/\n/.test(detail), "الرسالة على أكثر من سطر");
  assert.ok(!detail.includes("ghp_" + "ABCDEFGHIJ") && detail.includes("[REDACTED-GITHUB-TOKEN]"), "دخلت المخزن بلا حجب");
  const inbox = fs.readFileSync(path.join(cfg.vault, "_inbox", "pending.md"), "utf8");
  assert.ok(inbox.includes("try again at 8:43 PM."), "الصندوق لا يحمل آخر الرسالة");
});

await check("waiting sessions are counted by provider and by the provider's own words", async () => {
  const { waitingLines } = await import("../test-build/pipeline/run.js");
  const lines = waitingLines([
    { agent: "codex", detail: `codex: ${LIMIT}` },
    { agent: "claude-code", detail: "claude: خرج بالرمز 129: " },
    { agent: "codex", detail: `codex: ${LIMIT}` },
    { agent: "gemini", detail: null },
    { agent: "codex", detail: "codex: غير مثبّت" },
  ]);
  assert.equal(lines, `\n  codex 2 — ${LIMIT}\n  claude 1 — خرج بالرمز 129:\n  codex 1 — غير مثبّت\n  gemini 1 — بلا سبب مسجَّل`);
});

await check("the scan and sila stats both say who the sessions wait on, and why", async () => {
  const { waitingLines } = await import("../test-build/pipeline/run.js");
  const { execFileSync } = await import("node:child_process");
  const { cfg, file } = setup("limit-two");
  const other = path.join(path.dirname(file), `rollout-2026-09-25T12-00-00-${"2".repeat(8)}-0000-7000-8000-000000000000.jsonl`);
  fs.writeFileSync(other, [rec("session_meta", { id: "x", cwd }, "08:30:05"), ...turn(`${say} وجلسة ثانية.`, "08:31:07")].join("\n") + "\n");
  aged(other);
  const r = await scan(cfg, { ...opts, runner: refusing(LIMIT) });
  assert.equal(r.pendingExtraction, 2);
  assert.equal(waitingLines(r.waiting), `\n  codex 2 — error: ${LIMIT.slice("error: ".length)}`);
  const cli = fileURLToPath(new URL("../test-build/cli.js", import.meta.url));
  const stats = execFileSync(process.execPath, [cli, "stats", "--vault", cfg.vault], { encoding: "utf8" });
  assert.match(stats, /pendingExtraction 2\n {2}codex 2 — error: You’ve hit your usage limit\..* try again at 8:43 PM\.\n/);
});

await check("a session read before whose provider does not answer is said not to be read — not to have fallen back", async () => {
  const { cfg, file } = setup("unanswered");
  await scan(cfg, opts);
  for (const l of turn(`${say} ثم دور جديد.`, "09:34:14")) append(file, l);
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => (said.push(String(s)), true);
  try {
    await scan(cfg, { ...opts, runner: refusing(LIMIT) });
  } finally {
    process.stderr.write = write;
  }
  const out = said.join("");
  assert.match(out, /لم يُجب مزوّدها في 1 جلسة لها ملاحظة — لم تُقرأ ثانية، وبقيت ملاحظتها السابقة/);
  assert.ok(out.includes("try again at 8:43 PM."), "السبب مقصوص");
  assert.ok(!out.includes("تراجَع إلى الاستخلاص المحلي"), `ما زالت تُسمّى تراجعاً: ${out}`);
  assert.equal(row(cfg).status, "ok", "نُزّلت جلسة لها ملاحظة إلى الانتظار");
});

/**
 * When a Gemini session is still going. The log is a mutation log: messages
 * appended bare and `$set` snapshots. A model message is appended before its
 * tools have run and again, same id, once they have — first bare in one real
 * log, first with `tokens` in another — so while a tool runs the last record
 * is a model message with no tool calls and no words.
 */
const GEM = "44a6467d-71f6-4ced-bce0-5d944709a80a";
const gAgo = (ago) => new Date(Date.now() - ago).toISOString();
const gUser = (text, ago) => JSON.stringify({ id: `u${ago}`, timestamp: gAgo(ago), type: "user", content: [{ text }] });
const gModel = (ago, extra = {}) => JSON.stringify({ id: `m${ago}`, timestamp: gAgo(ago), type: "gemini", content: "", ...extra });
const gTools = { toolCalls: [{ id: "t", name: "run_shell_command", status: "success" }] };
const gSet = (ago, messages) => JSON.stringify({ $set: { ...(messages ? { messages: messages.map((m) => JSON.parse(m)) } : {}), lastUpdated: gAgo(ago) } });

function geminiLog(tag, lines, mtimeAgo) {
  const dir = path.join(base, tag);
  const src = path.join(dir, "gm");
  const cfg = ConfigSchema.parse({
    vault: path.join(dir, "vault"),
    sources: { gemini: src },
    extractor: { provider: "cli", cliOrder: ["gemini"] },
    git: false,
    briefSync: false,
  });
  const file = path.join(src, "proj", "chats", `session-2026-09-30T10-00-${GEM.slice(0, 8)}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(src, "proj", ".project_root"), cwd);
  const header = JSON.stringify({ sessionId: GEM, projectHash: "h", startTime: gAgo(90 * MIN), lastUpdated: gAgo(90 * MIN), kind: "main" });
  fs.writeFileSync(file, [header, ...lines].join("\n") + "\n");
  const t = new Date(Date.now() - mtimeAgo);
  fs.utimesSync(file, t, t);
  return { cfg, file };
}

await check("the last Gemini message says whether a turn is running — the two orders a tool's message was seen written in", async () => {
  const { geminiAdapter } = await import("../test-build/adapters/gemini.js");
  const cases = [
    ["a prompt not yet answered", [gUser(say, 10 * MIN)], true],
    ["a model message appended bare, its tool running (1dfc00bd)", [gUser(say, 20 * MIN), gModel(10 * MIN), gSet(10 * MIN)], true],
    ["a model message appended with tokens, its tool running (44a6467d)", [gUser(say, 20 * MIN), gModel(10 * MIN, { tokens: { total: 9 } }), gSet(10 * MIN)], true],
    ["a model message whose tools have run, words and all: the results go back to the model", [gUser(say, 20 * MIN), gModel(10 * MIN, { ...gTools, content: "أبحث.", tokens: { total: 9 } })], true],
    ["an answer in words, no tools", [gUser(say, 20 * MIN), gModel(10 * MIN, { content: "تم.", tokens: { total: 9 } }), gSet(10 * MIN)], false],
    ["an error nothing followed", [gUser(say, 20 * MIN), JSON.stringify({ id: "e", timestamp: gAgo(10 * MIN), type: "error", content: "API Error" })], false],
    ["an info note decides nothing", [gUser(say, 20 * MIN), JSON.stringify({ id: "i", timestamp: gAgo(10 * MIN), type: "info", content: "…" })], true],
    ["a snapshot's last message decides", [gSet(10 * MIN, [gUser(say, 20 * MIN), gModel(15 * MIN, { content: "تم." })])], false],
    ["a snapshot ending on a prompt", [gSet(10 * MIN, [gModel(25 * MIN, { content: "تم." }), gUser(say, 20 * MIN)])], true],
  ];
  for (const [i, [name, lines, busy]] of cases.entries()) {
    const { file } = geminiLog(`gm-case-${i}`, lines, 10 * MIN);
    assert.equal((await geminiAdapter.activity(file))?.busy, busy, name);
  }
  // The clock is the last stamp, a snapshot's lastUpdated included.
  const updated = gAgo(10 * MIN);
  const { file } = geminiLog("gm-at", [gUser(say, 20 * MIN), gModel(12 * MIN), JSON.stringify({ $set: { lastUpdated: updated } })], 10 * MIN);
  assert.equal((await geminiAdapter.activity(file))?.at, Date.parse(updated), "الساعة لا تُقرأ من lastUpdated");
});

await check("a Gemini tool running ten minutes keeps the session open; six hours on, it is read", async () => {
  const running = geminiLog("gm-running", [gUser(say, 20 * MIN), gModel(10 * MIN), gSet(10 * MIN)], 10 * MIN);
  asked = [];
  const r = await scan(running.cfg, opts);
  assert.deepEqual(asked, [], "قُرئت جلسة Gemini وأداتها تعمل");
  assert.equal(r.skippedOpen, 1);
  const dead = geminiLog("gm-dead", [gUser(say, 7 * 60 * MIN), gModel(6 * 60 * MIN + MIN), gSet(6 * 60 * MIN + MIN)], 6 * 60 * MIN);
  await scan(dead.cfg, opts);
  assert.deepEqual(asked, ["gemini"]);
});

/**
 * An inferred digest — «بصمة مُستنتَجة» — for a note read before the trailer
 * carried one. Batches of old transcripts have their mtime set back to seven
 * days ago from outside the engine, and each such note cost a model call to
 * read an unchanged session again. The legacy note here is today's with its
 * digest taken out, committed as the reading it stands for.
 */
const { inferDigests } = await import("../test-build/pipeline/digests.js");
const { Git } = await import("../test-build/store/git.js");
const legacyNote = (notePath) => {
  const md = fs.readFileSync(notePath, "utf8");
  const stripped = md.replace(/,"distilled":"[0-9a-f]{64}"/, "");
  assert.notEqual(stripped, md, "لا بصمة تُنزع");
  fs.writeFileSync(notePath, stripped);
  return stripped;
};
async function legacy(tag, extra = {}) {
  const { cfg, file } = setup(tag, { git: true, ...extra });
  fs.mkdirSync(cfg.vault, { recursive: true });
  new Git(cfg.vault, true).init();
  await scan(cfg, opts);
  const notePath = path.join(cfg.vault, row(cfg).note_path);
  const before = legacyNote(notePath);
  new Git(cfg.vault, true).commit("scan: قراءة قبل البصمة");
  return { cfg, file, notePath, before };
}
const upTo = (md) => md.slice(0, md.indexOf("<!-- engine:facts"));

await check("a note read before the digest gets an inferred one, apart from distilled, and a moved mtime then costs no call", async () => {
  const { cfg, file, notePath, before } = await legacy("infer");
  const r = await inferDigests(cfg);
  assert.equal(r.candidates, 1);
  assert.equal(r.inferred.length, 1);
  assert.match(r.commit ?? "", /^[0-9a-f]+$/, "لا commit");
  const t = trailer(cfg);
  assert.equal(t.distilled, undefined, "صارت بصمةً حقيقية");
  assert.match(t.distilledInferred?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(t.distilledInferred.size, fs.statSync(file).size);
  assert.equal(t.distilledInferred.readAt, row(cfg).processed_at);
  assert.equal(upTo(fs.readFileSync(notePath, "utf8")), upTo(before), "تغيّر من الملاحظة غير ذيلها");
  assert.equal((await inferDigests(cfg)).candidates, 0, "استُنتجت مرتين");
  aged(file); // set back, size untouched — as the batches do
  asked = [];
  const s = await scan(cfg, opts);
  assert.deepEqual(asked, [], "نص لم يتغيّر أُرسل إلى النموذج");
  assert.equal(s.unchangedText, 1);
});

await check("--dry-run infers nothing on disk", async () => {
  const { cfg, notePath, before } = await legacy("infer-dry");
  const r = await inferDigests(cfg, { dryRun: true });
  assert.equal(r.inferred.length, 1);
  assert.equal(r.commit, null);
  assert.equal(fs.readFileSync(notePath, "utf8"), before);
});

await check("a transcript that grew since its reading gets none, and is read", async () => {
  const { cfg, file } = await legacy("infer-grown");
  for (const l of turn(`${say} ثم دور جديد.`, "09:34:14")) append(file, l);
  const r = await inferDigests(cfg);
  assert.equal(r.inferred.length, 0);
  assert.match(r.skipped[0]?.why ?? "", /طول النص تغيّر/);
  asked = [];
  await scan(cfg, opts);
  assert.deepEqual(asked, ["codex"]);
});

await check("a row written after the note's last reading gets none — a local reading may have left the note behind", async () => {
  const { cfg } = await legacy("infer-row");
  const s = new Store(cfg.vault);
  s.upsertSession({ ...s.getSession(`codex:${ID}`), processed_at: new Date(Date.now() + 3_600_000).toISOString() });
  s.close();
  const r = await inferDigests(cfg);
  assert.equal(r.inferred.length, 0);
  assert.match(r.skipped[0]?.why ?? "", /ليس من آخر قراءة/);
});

await check("a note reverted after its reading gets none", async () => {
  const { cfg, notePath } = await legacy("infer-revert");
  fs.appendFileSync(notePath, "\n");
  new Git(cfg.vault, true).commit('Revert "scan: قراءة قبل البصمة"');
  const r = await inferDigests(cfg);
  assert.equal(r.inferred.length, 0);
  assert.match(r.skipped[0]?.why ?? "", /أُرجعت/);
});

await check("a row whose file reads as another session gets none", async () => {
  const { cfg, file } = await legacy("infer-other");
  const other = path.join(path.dirname(file), `rollout-2026-09-25T12-00-00-${"3".repeat(8)}-0000-7000-8000-000000000000.jsonl`);
  fs.copyFileSync(file, other);
  const s = new Store(cfg.vault);
  s.upsertSession({ ...s.getSession(`codex:${ID}`), source_file: other });
  s.close();
  const r = await inferDigests(cfg);
  assert.equal(r.inferred.length, 0);
  assert.match(r.skipped[0]?.why ?? "", /لم يعد يُقرأ/);
});

await check("a local note is no candidate, and without git nothing is inferred", async () => {
  const walled = { walls: [{ name: "proj", paths: [cwd], localOnly: true, sameProvider: true }] };
  const local = await legacy("infer-local", walled);
  assert.equal((await inferDigests(local.cfg)).candidates, 0, "ملاحظة محلية عُدّت");
  const { cfg } = setup("infer-nogit");
  await scan(cfg, opts);
  await assert.rejects(inferDigests(cfg), /بلا git/);
});

await check("a hand's rewrite keeps the inferred digest; a reading replaces it with a real one", async () => {
  const { cfg, file, notePath } = await legacy("infer-then");
  await inferDigests(cfg);
  assert.ok(retractInNote(notePath, "proj", "stack.db", new Date().toISOString(), "اختبار"));
  assert.ok(trailer(cfg).distilledInferred, "السحب باليد أسقط البصمة المُستنتَجة");
  for (const l of turn(`${say} ثم دور جديد.`, "09:34:14")) append(file, l);
  asked = [];
  await scan(cfg, opts);
  assert.deepEqual(asked, ["codex"]);
  assert.match(trailer(cfg).distilled ?? "", /^[0-9a-f]{64}$/);
  assert.equal(trailer(cfg).distilledInferred, undefined, "بقيت المُستنتَجة بجوار الحقيقية");
});

/**
 * No path writes a note without the digest of its text. The 67 notes of
 * before daadd4d had none, and each cost a model call the first time
 * something outside the engine moved its transcript's mtime; a note written
 * today without one would fall into the same trap ten days from now.
 */
function digestsIn(vault) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push([e.name, parseFactsTrailer(fs.readFileSync(p, "utf8"))?.distilled]);
    }
  };
  walk(path.join(vault, "sessions"));
  return out;
}
const everyNoteHasADigest = (vault) => {
  const all = digestsIn(vault);
  assert.ok(all.length > 0, "لا ملاحظات");
  for (const [note, d] of all) assert.match(d ?? "", /^[0-9a-f]{64}$/, `${note} بلا بصمة`);
};

await check("every path that writes a note leaves the digest of its text in it", async () => {
  const { movePlan } = await import("../test-build/pipeline/move.js");
  const { restoreInNote } = await import("../test-build/store/vault.js");
  // A reading by the model, then --force.
  const model = setup("every-model");
  await scan(model.cfg, opts);
  await scan(model.cfg, { ...opts, force: true });
  everyNoteHasADigest(model.cfg.vault);
  // Hands: retract, restore, move.
  const notePath = path.join(model.cfg.vault, row(model.cfg).note_path);
  assert.ok(retractInNote(notePath, "proj", "stack.db", new Date().toISOString(), "اختبار"));
  everyNoteHasADigest(model.cfg.vault);
  assert.ok(restoreInNote(notePath, "proj", "stack.db"));
  everyNoteHasADigest(model.cfg.vault);
  const moved = movePlan(model.cfg, { reason: "اختبار", moves: [{ subject: "proj", key: "stack.db", to: "proj", toKey: "stack.database", kind: "project" }] });
  assert.equal(moved.refused.length, 0, moved.refused.join(" | "));
  everyNoteHasADigest(model.cfg.vault);
  // A local reading: a folder walled off.
  const local = setup("every-local", { walls: [{ name: "proj", paths: [cwd], localOnly: true, sameProvider: true }] });
  await scan(local.cfg, opts);
  everyNoteHasADigest(local.cfg.vault);
  // A fallback: the model allowed, its CLI failing, no same-provider wall.
  const fallback = setup("every-fallback", { walls: [{ name: "proj", paths: [cwd], localOnly: false, sameProvider: false }] });
  const r = await scan(fallback.cfg, { ...opts, runner: refusing("خرج بالرمز 1") });
  assert.equal(r.processed, 1, "لم تُكتب ملاحظة التراجع");
  everyNoteHasADigest(fallback.cfg.vault);
});

await check("a note without the digest of its text is refused, not written", async () => {
  const { renderSessionNote } = await import("../test-build/store/vault.js");
  const note = { title: "ت", project: "p", summary: "", did: [], decisions: [], rejected: [], open: [], facts: [], links: [] };
  const args = { note, sessionId: "codex:x", agent: "codex", sourceFile: "x.jsonl", startedAt: null, usedModel: true };
  assert.throws(() => renderSessionNote(args), /بلا بصمة/);
  assert.throws(() => renderSessionNote({ ...args, distilled: "abc" }), /بلا بصمة/);
});

/**
 * The summary's counts add up to what the scan discovered. Past `--limit`
 * the scan used to stop looking and say nothing, and two outcomes had no
 * counter at all: a provider that did not answer a session read before, and
 * a local reading that met a model note.
 */
const addsUp = (r) =>
  r.processed + r.skippedUnchanged + r.skippedTiny + r.skippedSelf + r.unchangedText + r.skippedOpen +
  r.pendingExtraction + r.failed + r.quarantined + r.skippedOtherProject + r.keptPrevious + r.leftAtLimit;

await check("a scan that reaches --limit says it stopped and how many wait, and the vault's commit says so", async () => {
  const { cfg, file } = setup("limit-hit", { git: true });
  fs.mkdirSync(cfg.vault, { recursive: true });
  new Git(cfg.vault, true).init();
  for (const n of ["4", "5"]) {
    const more = path.join(path.dirname(file), `rollout-2026-09-25T12-00-00-${n.repeat(8)}-0000-7000-8000-000000000000.jsonl`);
    fs.writeFileSync(more, [rec("session_meta", { id: "x", cwd }, "08:30:05"), ...turn(`${say} ${n}`, "08:31:07")].join("\n") + "\n");
    aged(more);
  }
  const first = await scan(cfg, { ...opts, limit: 1 });
  assert.equal(first.processed, 1);
  assert.equal(first.leftAtLimit, 2);
  assert.equal(addsUp(first), first.discovered, "الملخّص لا يجمع ما اكتُشف");
  const { execFileSync } = await import("node:child_process");
  const subject = execFileSync("git", ["-C", cfg.vault, "log", "-1", "--format=%s"], { encoding: "utf8" });
  assert.match(subject, /توقّف عند الحدّ 1، بقي 2/);
  const second = await scan(cfg, { ...opts, limit: 1 });
  assert.deepEqual([second.processed, second.skippedUnchanged, second.leftAtLimit], [1, 1, 1]);
  assert.equal(addsUp(second), second.discovered);
  const third = await scan(cfg, { ...opts, limit: 1 });
  assert.equal(third.leftAtLimit, 0);
});

await check("a reading that did not replace a note is counted: no answer, or a local reading meeting a model note", async () => {
  const unanswered = setup("kept-unanswered");
  await scan(unanswered.cfg, opts);
  for (const l of turn(`${say} ثم دور جديد.`, "09:34:14")) append(unanswered.file, l);
  const write = process.stderr.write;
  process.stderr.write = () => true;
  let r;
  try {
    r = await scan(unanswered.cfg, { ...opts, runner: refusing(LIMIT) });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(r.keptPrevious, 1);
  assert.equal(addsUp(r), r.discovered);
  const walledOff = setup("kept-local");
  await scan(walledOff.cfg, opts);
  for (const l of turn(`${say} ثم دور جديد.`, "09:34:14")) append(walledOff.file, l);
  const local = ConfigSchema.parse({ ...walledOff.cfg, walls: [{ name: "proj", paths: [cwd], localOnly: true, sameProvider: true }] });
  process.stderr.write = () => true;
  try {
    r = await scan(local, opts);
  } finally {
    process.stderr.write = write;
  }
  assert.equal(r.keptPrevious, 1);
  assert.equal(r.processed, 0);
  assert.equal(addsUp(r), r.discovered);
});

/**
 * Short transcripts and the extractor's own. With no row, neither passed the
 * cheap gate: each was parsed on every scan and took a --limit seat doing it,
 * 35 of every 100 on 2026-09-30. Now each is recorded, and read again when its
 * file changes — or, for a short one, when the threshold it fell under does.
 */
const { codexAdapter } = await import("../test-build/adapters/codex.js");
/** The files a scan parses, by name. */
async function parsed(fn) {
  const parse = codexAdapter.parse;
  const read = [];
  codexAdapter.parse = (f) => (read.push(path.basename(f)), parse.call(codexAdapter, f));
  try {
    await fn();
  } finally {
    codexAdapter.parse = parse;
  }
  return read;
}
function shortSetup(tag, lines = [rec("session_meta", { id: ID, cwd }, "08:30:05"), ...turn("تحية قصيرة", "08:30:07")]) {
  const { cfg, file } = setup(tag);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  aged(file);
  return { cfg, file };
}

await check("a short transcript is recorded, and takes no --limit seat on the scans after it", async () => {
  const { cfg, file } = setup("short-seat");
  const SHORT = "aaaaaaaa-0000-7000-8000-000000000001";
  const short = path.join(path.dirname(file), `rollout-2026-09-25T08-20-00-${SHORT}.jsonl`);
  fs.writeFileSync(short, [rec("session_meta", { id: SHORT, cwd }, "08:20:00"), ...turn("تحية قصيرة", "08:20:01")].join("\n") + "\n");
  aged(short);
  aged(file); // the long one written last, so the short one is met first
  asked = [];
  const first = await scan(cfg, { ...opts, limit: 1 });
  assert.deepEqual([first.skippedTiny, first.leftAtLimit, first.processed], [1, 1, 0]);
  const s = new Store(cfg.vault);
  const r = s.getSession(`codex:${SHORT}`);
  s.close();
  assert.equal(r?.status, "empty", "القصيرة بلا صف");
  assert.equal(r.min_user_chars, cfg.minUserChars, "الحدّ الذي استُبعدت به لم يُحفظ");
  assert.equal(r.note_path, null);
  let second;
  const read = await parsed(async () => (second = await scan(cfg, { ...opts, limit: 1 })));
  assert.deepEqual(read, [path.basename(file)], "القصيرة قُرئت ثانية");
  assert.deepEqual([second.skippedTiny, second.leftAtLimit, second.processed], [1, 0, 1], "القصيرة أخذت المقعد");
  assert.deepEqual(asked, ["codex"]);
  assert.equal(addsUp(second), second.discovered, "الملخّص لا يجمع ما اكتُشف");
});

await check("the extractor's own session is recorded as such, and not read again", async () => {
  const { neutralCwd } = await import("../test-build/pipeline/extract.js");
  const { cfg } = shortSetup("self", [rec("session_meta", { id: ID, cwd: neutralCwd() }, "08:30:05"), ...turn(say, "08:30:07")]);
  const first = await scan(cfg, opts);
  assert.equal(first.skippedSelf, 1);
  assert.equal(row(cfg)?.status, "skipped");
  let again;
  const read = await parsed(async () => (again = await scan(cfg, opts)));
  assert.deepEqual(read, [], "جلسة المستخلِص قُرئت ثانية");
  assert.equal(again.skippedSelf, 1, "لم تُعدّ ذاتية من صفّها");
});

await check("a short transcript is judged again when the threshold it fell under changes — and read once under it", async () => {
  const { cfg } = shortSetup("short-threshold");
  await scan(cfg, opts);
  assert.equal(row(cfg).status, "empty");
  const raised = ConfigSchema.parse({ ...cfg, minUserChars: 300 });
  assert.equal((await parsed(() => scan(raised, opts))).length, 1, "تغيّر الحدّ ولم يُعَد تقييمها");
  assert.equal(row(cfg).min_user_chars, 300, "الحدّ الجديد لم يُسجَّل");
  assert.equal((await parsed(() => scan(raised, opts))).length, 0, "قُرئت مرتين تحت الحدّ نفسه");
  // Lowered under what the user typed: no longer short, and read by the model.
  asked = [];
  const r = await scan(ConfigSchema.parse({ ...cfg, minUserChars: 5 }), opts);
  assert.deepEqual(asked, ["codex"]);
  assert.equal(r.processed, 1);
  assert.equal(row(cfg).status, "ok");
  assert.equal(row(cfg).min_user_chars, null);
});

await check("a file with no turn in it is short under any threshold: recorded by its path, never judged again for one", async () => {
  const { cfg, file } = shortSetup("no-turn", [rec("session_meta", { id: ID, cwd }, "08:30:05")]);
  const first = await scan(cfg, opts);
  assert.equal(first.skippedTiny, 1);
  const s = new Store(cfg.vault);
  const rows = s.db.prepare("SELECT id, status, min_user_chars FROM sessions").all();
  s.close();
  assert.deepEqual(rows, [{ id: `codex:${file}`, status: "empty", min_user_chars: null }]);
  assert.deepEqual(await parsed(() => scan(ConfigSchema.parse({ ...cfg, minUserChars: 5 }), opts)), []);
});

await check("a short transcript that grows is read, and its row becomes the session's", async () => {
  const { cfg, file } = shortSetup("short-grows");
  await scan(cfg, opts);
  for (const l of turn(say, "09:34:14")) append(file, l);
  asked = [];
  await scan(cfg, opts);
  assert.deepEqual(asked, ["codex"]);
  assert.equal(row(cfg).status, "ok");
  assert.ok(row(cfg).note_path, "لا ملاحظة");
});

await check("a session read before keeps its note and its row though its text now falls under a raised threshold", async () => {
  const { cfg, file } = setup("read-then-raised");
  await scan(cfg, opts);
  for (const l of turn("وأخيراً.", "09:34:14")) append(file, l);
  const r = await scan(ConfigSchema.parse({ ...cfg, minUserChars: 5000 }), opts);
  assert.equal(r.skippedTiny, 1);
  assert.equal(row(cfg).status, "ok", "صف جلسة لها ملاحظة صار قصيراً");
  assert.ok(fs.existsSync(path.join(cfg.vault, row(cfg).note_path)), "الملاحظة ذهبت");
});

/**
 * A transcript that leaves the disk. A scan sees only what is there, so it
 * never meets the session again and says nothing: one project's transcript
 * folder went whole one night, and f860a427 was deleted in the desktop app
 * on 2026-10-01 a minute after its note was written.
 */
const { writeConfig } = await import("../test-build/config.js");
function goneVault(tag) {
  const { cfg, file } = setup(tag);
  const SHORT = "bbbbbbbb-0000-7000-8000-000000000002";
  const short = path.join(path.dirname(file), `rollout-2026-09-25T08-20-00-${SHORT}.jsonl`);
  fs.writeFileSync(short, [rec("session_meta", { id: SHORT, cwd }, "08:20:00"), ...turn("تحية قصيرة", "08:20:01")].join("\n") + "\n");
  aged(short);
  return { cfg, file, short };
}

await check("doctor names every session whose transcript has gone — a note, a wait — and not a short one's row", async () => {
  const { execFileSync } = await import("node:child_process");
  const { cfg, file, short } = goneVault("gone-doctor");
  writeConfig(cfg);
  await scan(cfg, opts);
  const s = new Store(cfg.vault);
  s.upsertSession({ id: "codex:waiting", agent: "codex", source_file: path.join(base, "gone-doctor", "nowhere.jsonl"), content_hash: "h", cwd: null, project: "proj", started_at: "2026-09-26T00:00:00.000Z", processed_at: "2026-09-30T00:00:00.000Z", status: "pending-extraction", note_path: null, detail: "codex غير مثبّت" });
  s.close();
  const notePath = path.join(cfg.vault, row(cfg).note_path);
  const note = fs.readFileSync(notePath, "utf8");
  fs.rmSync(file);
  fs.rmSync(short);
  const g = new Store(cfg.vault);
  const gone = g.withoutTranscript().map((r) => `${r.id} ${r.status}`);
  g.close();
  assert.deepEqual(gone, [`codex:${ID} ok`, "codex:waiting pending-extraction"]);
  const cli = fileURLToPath(new URL("../test-build/cli.js", import.meta.url));
  const out = execFileSync(process.execPath, [cli, "doctor", "--vault", cfg.vault], { encoding: "utf8" });
  assert.match(out, /⚠ جلسات ذهب نصّها من القرص: 2\n/);
  assert.match(out, new RegExp(`2026-09-25 · proj · codex:${ID} · ملاحظتها وحقائقها باقية\\n {6}.*${ID}\\.jsonl`));
  assert.match(out, /2026-09-26 · proj · codex:waiting · كانت تنتظر الاستخلاص — لن تُقرأ/);
  assert.ok(!out.includes("bbbbbbbb"), "صفّ القصيرة سُمّي جلسة ذهب نصّها");
  assert.equal(fs.readFileSync(notePath, "utf8"), note, "مُسّت الملاحظة");
});

/** A session read, its brief written and injected into its own folder, and then its transcript gone. */
async function deadResume(tag) {
  const dir = path.join(base, `${tag}-proj`);
  fs.mkdirSync(dir, { recursive: true });
  const made = shortSetup(tag, [rec("session_meta", { id: ID, cwd: dir }, "08:30:05"), ...turn(say, "08:30:07")]);
  const cfg = ConfigSchema.parse({ ...made.cfg, briefSync: true, git: true });
  fs.mkdirSync(cfg.vault, { recursive: true });
  new Git(cfg.vault, true).init();
  await scan(cfg, opts);
  const briefFile = path.join(cfg.vault, "projects", `${tag}-proj`, "BRIEF.md");
  const command = `codex resume ${ID}`;
  const agentFiles = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"].map((n) => path.join(dir, n));
  assert.ok(fs.readFileSync(briefFile, "utf8").includes(command), "الإعداد: الموجز بلا أمر");
  for (const f of agentFiles) assert.ok(fs.readFileSync(f, "utf8").includes(command), `الإعداد: ${path.basename(f)} بلا أمر`);
  return { cfg, file: made.file, briefFile, command, agentFiles };
}

await check("agent files the brief went into stop offering it though BRIEF.md already does not — the shape it took on this machine", async () => {
  const { writeBrief } = await import("../test-build/serve/brief.js");
  const { cfg, file, briefFile, command, agentFiles } = await deadResume("brief-files");
  fs.rmSync(file);
  // A hand's command rewrote BRIEF.md and injected nothing, as sila retract does.
  const s = new Store(cfg.vault);
  writeBrief(s, cfg.vault, "brief-files-proj");
  s.close();
  const brief = fs.readFileSync(briefFile, "utf8");
  assert.ok(!brief.includes(command));
  const r = await scan(cfg, opts);
  assert.deepEqual(r.briefsRewritten, ["brief-files-proj"]);
  for (const f of agentFiles) assert.ok(!fs.readFileSync(f, "utf8").includes(command), `${path.basename(f)} ما زال يعرض أمراً لا يعمل`);
  assert.equal(fs.readFileSync(briefFile, "utf8"), brief, "أُعيدت كتابة موجز لا يعرضه");
});

await check("a written brief, and the files it was injected into, stop offering a command whose transcript has gone — the note keeps it", async () => {
  const { execFileSync } = await import("node:child_process");
  const { cfg, file, briefFile, command, agentFiles } = await deadResume("brief-dead");
  const notePath = path.join(cfg.vault, row(cfg).note_path);
  const note = fs.readFileSync(notePath, "utf8");
  const facts = () => {
    const s = new Store(cfg.vault);
    try {
      return s.db.prepare("SELECT * FROM facts ORDER BY id").all();
    } finally {
      s.close();
    }
  };
  const factsBefore = facts();
  fs.rmSync(file);
  const r = await scan(cfg, opts);
  assert.deepEqual(r.briefsRewritten, ["brief-dead-proj"]);
  assert.ok(!fs.readFileSync(briefFile, "utf8").includes(command), "BRIEF.md ما زال يعرض أمراً لا يعمل");
  for (const f of agentFiles) assert.ok(!fs.readFileSync(f, "utf8").includes(command), `${path.basename(f)} ما زال يعرض أمراً لا يعمل`);
  assert.equal(fs.readFileSync(notePath, "utf8"), note, "مُسّت الملاحظة");
  assert.ok(note.includes(command), "الملاحظة لم تكن تحمل الأمر");
  assert.deepEqual(facts(), factsBefore, "مُسّت الحقائق");
  const subject = execFileSync("git", ["-C", cfg.vault, "log", "-1", "--format=%s"], { encoding: "utf8" });
  assert.match(subject, /أُعيد موجز كان يعرض ما لا يعمل: brief-dead-proj/, "لا commit يقول ما تغيّر");
  // Rewritten once: the next scan finds nothing that offers it, and writes nothing.
  const brief = fs.readFileSync(briefFile, "utf8");
  const again = await scan(cfg, opts);
  assert.deepEqual(again.briefsRewritten, []);
  assert.equal(fs.readFileSync(briefFile, "utf8"), brief, "أُعيدت كتابة الموجز في مسح هادئ");
});

await check("a written brief whose stamp says `mem scan` is rewritten with one that runs, in BRIEF.md and the files it went into", async () => {
  const { execFileSync } = await import("node:child_process");
  const { cfg, briefFile, agentFiles } = await deadResume("brief-stamp");
  writeConfig(cfg);
  // As every brief written before 2026-10-01 has it.
  const legacy = (f) => fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/(_محدَّث [^`]*)`[^`]+`/, "$1`mem scan`"));
  for (const f of [briefFile, ...agentFiles]) legacy(f);
  assert.ok(fs.readFileSync(briefFile, "utf8").includes("`mem scan`"), "الإعداد: الختم القديم لم يُكتب");
  const r = await scan(cfg, opts);
  assert.deepEqual(r.briefsRewritten, ["brief-stamp-proj"]);
  for (const f of [briefFile, ...agentFiles]) assert.ok(!fs.readFileSync(f, "utf8").includes("`mem scan`"), `${path.basename(f)} ما زال يطلب mem`);
  // The command the stamp now names runs.
  const command = /_محدَّث [^`]*`([^`]+)`/.exec(fs.readFileSync(briefFile, "utf8"))?.[1] ?? "";
  const [bin, ...args] = [...command.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  const out = execFileSync(bin, [...args, "--dry-run"], { encoding: "utf8" });
  assert.match(out, /لا شيء كُتب/, "أمر الختم لم يعمل");
  const again = await scan(cfg, opts);
  assert.deepEqual(again.briefsRewritten, [], "أُعيد موجز ختمه يعمل");
  // A stamp naming a CLI that is no longer where it says — a dist moved — does not run either.
  const gone = `"${process.execPath}" "${path.join(base, "moved", "dist", "cli.js")}" scan --vault "${cfg.vault}"`;
  fs.writeFileSync(briefFile, fs.readFileSync(briefFile, "utf8").replace(/(_محدَّث [^`]*)`[^`]+`/, `$1\`${gone}\``));
  const moved = await scan(cfg, opts);
  assert.deepEqual(moved.briefsRewritten, ["brief-stamp-proj"], "ختم يسمّي CLI غائباً لم يُعَد");
  assert.ok(!fs.readFileSync(briefFile, "utf8").includes(gone));
});

await check("a written brief stops offering a command whose folder has gone, its transcript still there", async () => {
  const { cfg, briefFile, command } = await deadResume("brief-folder");
  fs.rmSync(path.join(base, "brief-folder-proj"), { recursive: true });
  const r = await scan(cfg, opts);
  assert.deepEqual(r.briefsRewritten, ["brief-folder-proj"]);
  assert.ok(!fs.readFileSync(briefFile, "utf8").includes(command), "BRIEF.md ما زال يعرض أمراً يدخل مجلداً ذهب");
  assert.deepEqual((await scan(cfg, opts)).briefsRewritten, []);
});

/**
 * A fresh config, as init writes it: provider "anthropic", model
 * claude-sonnet-5, no walls, no key. On one, doctor said the key was missing
 * so extraction would be local and named the API model, the dry run named
 * that model, the reread count said "no git" under "git ✓", and the
 * extractor's own sessions counted as sent — while every session went to its
 * own agent's CLI. Found on this machine's fresh config, 2026-10-04.
 */
await check("on a fresh config, doctor and the dry run name each agent's CLI, and the extractor's own sessions are not counted as sent", async () => {
  const { execFileSync } = await import("node:child_process");
  const { neutralCwd } = await import("../test-build/pipeline/extract.js");
  const dir = path.join(base, "fresh-config");
  const src = path.join(dir, "cx");
  const cfg = ConfigSchema.parse({ vault: path.join(dir, "vault"), sources: { codex: src } });
  fs.mkdirSync(cfg.vault, { recursive: true });
  writeConfig(cfg);
  new Git(cfg.vault, true).init();
  const write = (id, folder) => {
    const file = path.join(src, "2026", "09", "25", `rollout-2026-09-25T11-27-50-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [rec("session_meta", { id, cwd: folder }, "08:30:05"), ...turn(say, "08:30:07")].join("\n") + "\n");
    aged(file);
  };
  write("01a0d7ad-0000-7000-8000-000000000001", cwd);
  write("01a0d7ad-0000-7000-8000-000000000002", neutralCwd());
  const cli = fileURLToPath(new URL("../test-build/cli.js", import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args, "--vault", cfg.vault], { encoding: "utf8" });

  const doctor = run("doctor");
  assert.ok(!doctor.includes("الاستخلاص المحلي") && !/extractor\s+anthropic/.test(doctor), doctor);
  assert.ok(!doctor.includes("claude-sonnet-5"), "doctor سمّى نموذج الـAPI ولا جلسة claude");
  assert.match(doctor, /ما يغادر الجهاز يذهب إلى CLI وكيله: codex /);
  assert.match(doctor, /أُعيد استخلاصها أكثر من 3 مرات في 7 أيام: لا شيء ✓/, "مخزن بلا commit قيل بلا git");
  assert.match(doctor, /كل جلسة يُعرف مجلدها ستُرسل إلى CLI وكيلها/);

  const dry = run("scan", "--dry-run");
  assert.ok(!dry.includes("النموذج:") && !dry.includes("claude-sonnet-5"), dry);
  assert.match(dry, /^اكتُشف 2 ملف · جديد أو متغيّر 1 · دون تغيير 0 · ذاتية 1\n/);
  assert.match(dry, /سيُلخَّص محلياً 0 · سيُرسل حتى 1\n {2}إلى codex 1 — /);
  assert.ok(!dry.includes(neutralCwd()), "مجلد المستخلِص عُدّ مجلد جلسات");
});

fs.rmSync(base, { recursive: true, force: true });
process.stdout.write(`\ngate: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
