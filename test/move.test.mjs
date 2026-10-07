import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema } from "../test-build/config.js";
import { movePlan, restoreSlot } from "../test-build/pipeline/move.js";
import { scan } from "../test-build/pipeline/run.js";
import { rebaseAll, rebuildIndex } from "../test-build/pipeline/reindex.js";
import { Store } from "../test-build/store/db.js";
import { readAllNotes, renderSessionNote, sessionNotePath } from "../test-build/store/vault.js";
import { writeFileAtomic } from "../test-build/util/fsatomic.js";

/**
 * `sila move --plan`: the first full scan filed 61 live slots under subjects
 * the definition does not admit — a folder of the repo, a class, a concept,
 * another spelling of the project. A move is made in the notes, so a rebuild
 * from the notes lands where the move did; the old subject keeps its history;
 * and a plan with one bad move is refused whole.
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mem-move-"));
const vault = path.join(base, "vault");
const cfg = ConfigSchema.parse({ vault, sources: {}, git: false, briefSync: false });

const fact = (subject, key, claim, confidence = 0.85) => ({ subject, subjectKind: "project", key, claim, confidence });
const sessions = [
  ["claude-code:s1", "2026-09-01T00:00:00.000Z", [fact("engine_server", "arch.flow", "الخدمة تمرّ بمرحلتين"), fact("engine", "stack.db", "القاعدة SQLite")]],
  ["claude-code:s2", "2026-09-02T00:00:00.000Z", [fact("engine_server", "arch.flow", "الخدمة تمرّ بثلاث مراحل")]],
  ["claude-code:s3", "2026-09-03T00:00:00.000Z", [fact("client_a", "constraint.lint", "lint لا يعمل لغياب eslint.config.js")]],
  ["claude-code:s4", "2026-09-04T00:00:00.000Z", [fact("client_b", "constraint.lint", "npm run lint يفشل دائماً: لا eslint.config.js في جذر العميل")]],
];
const PROSE = "نص كتبه الاستخلاص ولا يمسّه النقل.";
{
  const s = new Store(vault);
  for (const [id, date, facts] of sessions) {
    const note = { title: id, project: "engine", summary: PROSE, did: [], decisions: [], rejected: [], open: [], links: [], facts };
    writeFileAtomic(
      sessionNotePath(vault, date, id),
      renderSessionNote({ note, sessionId: id, agent: "claude-code", sourceFile: `${id}.jsonl`, startedAt: date, usedModel: true, distilled: "0".repeat(64) }),
    );
    s.upsertSession({ id, agent: "claude-code", source_file: `${id}.jsonl`, content_hash: id, cwd: null, project: "engine", started_at: date, processed_at: date, status: "ok", note_path: null });
  }
  s.close();
}
rebaseAll(cfg);

const plan = {
  reason: "ليست كيانات",
  moves: [
    { subject: "engine_server", key: "arch.flow", to: "engine", toKey: "arch.server-flow", kind: "project" },
    { subject: "client_a", key: "constraint.lint", to: "engine", toKey: "constraint.client-lint", kind: "project" },
    { subject: "client_b", key: "constraint.lint", to: "engine", toKey: "constraint.client-lint", kind: "project" },
  ],
};

function digest(dir) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return walk(dir)
    .filter((f) => !f.includes(`${path.sep}.index${path.sep}`))
    .sort()
    .map((f) => `${path.relative(dir, f)} ${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}`);
}
function rows(dir) {
  const s = new Store(dir);
  try {
    const all = s.db.prepare("SELECT * FROM facts ORDER BY id").all();
    const byId = new Map(all.map((r) => [r.id, r]));
    return all
      .map((r) => `${r.subject}.${r.key} ${r.session_id} ${r.claim} ${r.retracted_at ? "سُحب" : r.superseded_by ? `→ ${byId.get(r.superseded_by)?.claim}` : "حي"}`)
      .sort();
  } finally {
    s.close();
  }
}
const live = (dir) => rows(dir).filter((r) => r.endsWith(" حي"));

// ---- refusals: nothing written ------------------------------------------------

check("a plan with one move into a slot the vault knows is refused whole, and nothing is written", () => {
  const before = digest(vault);
  const bad = { ...plan, moves: [...plan.moves, { subject: "engine_server", key: "arch.flow", to: "engine", toKey: "stack.db", kind: "project" }] };
  const r = movePlan(cfg, bad);
  assert.ok(r.refused.some((x) => x.includes("الهدف خانة يعرفها المخزن")), r.refused.join(" | "));
  assert.ok(r.refused.some((x) => x.includes("المصدر مكرّر")), "المصدر المكرّر لم يُرفض");
  assert.equal(r.notesWritten, 0);
  assert.deepEqual(digest(vault), before, "كُتب شيء رغم الرفض");
});

check("a move whose source no note claims is refused", () => {
  const r = movePlan(cfg, { reason: "س", moves: [{ subject: "nobody", key: "misc.x", to: "engine", toKey: "misc.y", kind: "project" }] });
  assert.ok(r.refused.some((x) => x.includes("لا ملاحظة تدّعي المصدر")));
});

check("--dry-run reports what would move and what the notes would give after, and writes nothing", () => {
  const before = digest(vault);
  const r = movePlan(cfg, plan, { dryRun: true });
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.moves.map((m) => m.notes), [2, 1, 1]);
  assert.equal(r.moves[0].live, "الخدمة تمرّ بثلاث مراحل");
  assert.deepEqual(r.before, { facts: 4, subjects: 4 });
  assert.deepEqual(r.after, { facts: 3, subjects: 1 }, "الدمج أو التفريغ لم يُحسب");
  assert.deepEqual(r.emptied.sort(), ["client_a", "client_b", "engine_server"]);
  assert.equal(r.commit, null);
  assert.deepEqual(digest(vault), before, "كتب --dry-run شيئاً");
});

// ---- the move ------------------------------------------------------------------

const rowsBefore = rows(vault);
const done = movePlan(cfg, plan);

check("each claim lives in its target, in session-date order; two sources the plan names as one fact share one slot", () => {
  assert.deepEqual(done.refused, []);
  assert.equal(done.notesWritten, 4);
  assert.deepEqual(live(vault), [
    "engine.arch.server-flow claude-code:s2 الخدمة تمرّ بثلاث مراحل حي",
    "engine.constraint.client-lint claude-code:s4 npm run lint يفشل دائماً: لا eslint.config.js في جذر العميل حي",
    "engine.stack.db claude-code:s1 القاعدة SQLite حي",
  ]);
  assert.ok(rows(vault).includes("engine.arch.server-flow claude-code:s1 الخدمة تمرّ بمرحلتين → الخدمة تمرّ بثلاث مراحل"), "التاريخ لم ينتقل مع الخانة");
});

check("no row is deleted: the old subject keeps its rows, withdrawn", () => {
  const after = rows(vault);
  assert.ok(after.length >= rowsBefore.length, "حُذف صف");
  for (const r of ["engine_server.arch.flow claude-code:s1 الخدمة تمرّ بمرحلتين سُحب", "engine_server.arch.flow claude-code:s2 الخدمة تمرّ بثلاث مراحل سُحب", "client_a.constraint.lint claude-code:s3 lint لا يعمل لغياب eslint.config.js سُحب"]) {
    assert.ok(after.includes(r), `لا صف: ${r}`);
  }
});

check("the note files the claim under the target and says where the old slot went; its prose is untouched", () => {
  const n = readAllNotes(vault).find((x) => x.sessionId === "claude-code:s1");
  assert.deepEqual(n.facts.map((f) => `${f.subject}.${f.key}`), ["engine.arch.server-flow", "engine.stack.db"]);
  assert.equal(n.facts[0].claim, "الخدمة تمرّ بمرحلتين");
  assert.equal(n.facts[0].confidence, 0.85);
  assert.equal(n.retracted.length, 1);
  assert.equal(`${n.retracted[0].subject}.${n.retracted[0].key}`, "engine_server.arch.flow");
  assert.ok(n.retracted[0].reason.startsWith("نُقل إلى engine.arch.server-flow"), n.retracted[0].reason);
  assert.equal(n.retracted[0].createdAt, "2026-09-01T00:00:00.000Z");
  assert.ok(n.md.includes(PROSE));
  assert.ok(n.md.includes("## سُحب") && n.md.includes("نُقل إلى engine.arch.server-flow"));
});

check("the old subject's file says where each claim went; the target's holds it", () => {
  const old = fs.readFileSync(path.join(vault, "subjects", "project", "engine_server.md"), "utf8");
  assert.ok(old.includes("_لا شيء بعد._"), "الموضوع القديم ما زال يعرض حقيقة حيّة");
  const target = fs.readFileSync(path.join(vault, "subjects", "project", "engine.md"), "utf8");
  assert.ok(target.includes("arch.server-flow"));
});

check("a rebuild from the notes gives the rows the move left", () => {
  const copy = path.join(base, "copy");
  fs.cpSync(vault, copy, { recursive: true });
  rebuildIndex(ConfigSchema.parse({ ...cfg, vault: copy }));
  assert.deepEqual(rows(copy), rows(vault));
});

check("the same plan again is refused: no note claims its sources any more", () => {
  const before = digest(vault);
  const r = movePlan(cfg, plan);
  assert.equal(r.refused.filter((x) => x.includes("لا ملاحظة تدّعي المصدر")).length, 3, r.refused.join(" | "));
  assert.deepEqual(digest(vault), before);
});

// ---- a slot the moving session itself withdrew ---------------------------------
// 4fb58e98's first reading filed the gotcha about an audit script under acme; its
// re-read filed it under tooling, withdrawing the acme slot. Moving it back
// was refused as "a slot the vault knows" — though all the slot ever held was
// that session's own earlier wording.

const vault2 = path.join(base, "vault2");
const cfg2 = ConfigSchema.parse({ vault: vault2, sources: {}, git: false, briefSync: false });
{
  const s = new Store(vault2);
  const tool = (key, claim) => ({ ...fact("tooling", key, claim), subjectKind: "tool" });
  for (const [id, date, facts, retracted] of [
    [
      "claude-code:t1",
      "2026-08-22T00:00:00.000Z",
      [tool("gotcha.extractor", "المستخرج أعمى على المتغيّرات")],
      [{ ...fact("engine", "gotcha.extractor", "المستخرج لا يرى المتغيّرات"), createdAt: "2026-08-22T00:00:00.000Z", retractedAt: "2026-09-23T00:00:00.000Z" }],
    ],
    ["claude-code:t2", "2026-08-23T00:00:00.000Z", [tool("gotcha.other", "أداة أخرى")], []],
  ]) {
    const note = { title: id, project: "engine", summary: PROSE, did: [], decisions: [], rejected: [], open: [], links: [], facts };
    writeFileAtomic(
      sessionNotePath(vault2, date, id),
      renderSessionNote({ note, sessionId: id, agent: "claude-code", sourceFile: `${id}.jsonl`, startedAt: date, usedModel: true, distilled: "0".repeat(64), retracted }),
    );
    s.upsertSession({ id, agent: "claude-code", source_file: `${id}.jsonl`, content_hash: id, cwd: null, project: "engine", started_at: date, processed_at: date, status: "ok", note_path: null });
  }
  s.close();
}
rebaseAll(cfg2);

check("a slot whose whole history is the moving session's own withdrawn wording takes its claim back, as replaced — another session's is still refused", () => {
  const before = digest(vault2);
  const other = movePlan(cfg2, { reason: "ر", moves: [{ subject: "tooling", key: "gotcha.other", to: "engine", toKey: "gotcha.extractor", kind: "project" }] });
  assert.ok(other.refused.some((x) => x.includes("الهدف خانة يعرفها المخزن")), "قُبلت خانة سحبتها جلسة أخرى");
  assert.deepEqual(digest(vault2), before);
  // An index that lacks the rows still has the note that withdrew the slot.
  const bare = path.join(base, "bare2");
  fs.cpSync(vault2, bare, { recursive: true });
  const b = new Store(bare);
  b.db.prepare("DELETE FROM facts WHERE session_id = 'claude-code:t1'").run();
  b.close();
  const fromNote = movePlan(ConfigSchema.parse({ ...cfg2, vault: bare }), { reason: "ر", moves: other.moves });
  assert.ok(fromNote.refused.some((x) => x.includes("الهدف خانة يعرفها المخزن")), "سحبُ ملاحظة جلسة أخرى لم يُحسب");

  const r = movePlan(cfg2, { reason: "سكربت كتبته الجلسة", moves: [{ subject: "tooling", key: "gotcha.extractor", to: "engine", toKey: "gotcha.extractor", kind: "project" }] });
  assert.deepEqual(r.refused, []);
  assert.deepEqual(live(vault2), ["engine.gotcha.extractor claude-code:t1 المستخرج أعمى على المتغيّرات حي", "tooling.gotcha.other claude-code:t2 أداة أخرى حي"]);
  const all = rows(vault2);
  assert.ok(all.includes("engine.gotcha.extractor claude-code:t1 المستخرج لا يرى المتغيّرات → المستخرج أعمى على المتغيّرات"), "الصياغة الأولى لم تُسجَّل مستبدَلة");
  assert.ok(all.includes("tooling.gotcha.extractor claude-code:t1 المستخرج أعمى على المتغيّرات سُحب"), "المصدر لم يُسحب");

  const copy = path.join(base, "copy2");
  fs.cpSync(vault2, copy, { recursive: true });
  rebuildIndex(ConfigSchema.parse({ ...cfg2, vault: copy }));
  assert.deepEqual(rows(copy), all, "إعادة البناء لا تطابق");
});

// ---- a move survives a re-read --------------------------------------------------
// A note is derived from its transcript. b26a6056's transcript grew after its
// six facts were moved to dojo; the full scan of 2026-09-24 read it again, the
// model filed them where it first had, and the move was undone. So every move
// is written into the note's ledger and applied to each later reading before
// the note is written — the scan here is the real one, the CLI a seam.

const vault3 = path.join(base, "vault3");
const src3 = path.join(base, "claude-projects");
const cwd3 = path.join(base, "video");
fs.mkdirSync(cwd3, { recursive: true });
const cfg3 = ConfigSchema.parse({ vault: vault3, sources: { claudeCode: src3 }, extractor: { provider: "cli", cliOrder: ["claude"] }, git: false, briefSync: false });
const UUID = "00000000-0000-4000-8000-00000000000a";
const SID = `claude-code:${UUID}`;
const transcript3 = path.join(src3, "C--video", `${UUID}.jsonl`);
let lines3 = 0;
/** The transcript, longer each time: a session that kept going after it was first read. */
function grow() {
  fs.mkdirSync(path.dirname(transcript3), { recursive: true });
  lines3++;
  const line = (type, content, at) =>
    JSON.stringify({ type, sessionId: UUID, cwd: cwd3, timestamp: `2026-09-05T${at}.000Z`, message: { role: type, content } });
  const say = (i) => `SESSIONMOVE ${"نركّب الخطوط ونصمّم اللوحات ونصدّر الفيديو ونفحص المزامنة. ".repeat(6)} جزء ${i}`;
  const body = [];
  for (let i = 1; i <= lines3; i++) body.push(line("user", say(i), `10:0${i}:00`), line("assistant", [{ type: "text", text: "تم." }], `10:0${i}:30`));
  fs.writeFileSync(transcript3, body.join("\n") + "\n");
  // Closed long ago: the scan skips a transcript still being written.
  const t = new Date(Date.UTC(2026, 8, 6));
  fs.utimesSync(transcript3, t, t);
}
let reply3 = { title: "فيديو", facts: [] };
const runner3 = async () => ({ text: JSON.stringify(reply3), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: "fake" } });
const opts3 = { limit: 100, concurrency: 1, dryRun: false, force: false, runner: runner3 };
const tool3 = (subject, key, claim) => ({ subject, subjectKind: "tool", key, claim, confidence: 0.85 });
const noteOf = () => readAllNotes(vault3).find((n) => n.sessionId === SID);
const slotsOf = (dir) => live(dir).map((r) => r.split(" ")[0]);

grow();
reply3 = { title: "فيديو", facts: [tool3("video-tool", "gotcha.font", "الخط التجاري يسقط صامتاً على خط النظام"), fact("engine", "stack.db", "القاعدة SQLite")] };
await scan(cfg3, opts3);
const planned = movePlan(cfg3, { reason: "المهارة للدار", moves: [{ subject: "video-tool", key: "gotcha.font", to: "dojo", toKey: "gotcha.video-font", kind: "org" }] });

await check("the move is written into the note's ledger", () => {
  assert.deepEqual(planned.refused, []);
  const n = noteOf();
  assert.deepEqual(n.moves.map((m) => `${m.subject}.${m.key} → ${m.to}.${m.toKey}`), ["video-tool.gotcha.font → dojo.gotcha.video-font"]);
  assert.equal(n.moves[0].kind, "org");
  assert.equal(n.moves[0].reason, "المهارة للدار");
  assert.ok(n.md.includes('"moves":['), "الذيل بلا سجل النقل");
});

grow();
reply3 = { title: "فيديو", facts: [tool3("video-tool", "gotcha.font", "خط تجاري كآصال ليس في قوقل فونتس فيسقط صامتاً على خط النظام"), fact("engine", "stack.db", "القاعدة SQLite")] };
const reread = await scan(cfg3, opts3);

await check("the session grows and is read again: the claim lands where the move put it, and the move holds", () => {
  assert.equal(reread.processed, 1);
  assert.equal(reread.movesApplied, 1);
  assert.deepEqual(live(vault3), [
    "dojo.gotcha.video-font claude-code:00000000-0000-4000-8000-00000000000a خط تجاري كآصال ليس في قوقل فونتس فيسقط صامتاً على خط النظام حي",
    "engine.stack.db claude-code:00000000-0000-4000-8000-00000000000a القاعدة SQLite حي",
  ]);
  assert.ok(rows(vault3).includes("dojo.gotcha.video-font claude-code:00000000-0000-4000-8000-00000000000a الخط التجاري يسقط صامتاً على خط النظام → خط تجاري كآصال ليس في قوقل فونتس فيسقط صامتاً على خط النظام"), "الصياغة الأولى لم تُسجَّل مستبدَلة في الهدف");
  const n = noteOf();
  assert.deepEqual(n.facts.map((f) => `${f.subject}.${f.key}`), ["dojo.gotcha.video-font", "engine.stack.db"]);
  assert.equal(n.facts[0].subjectKind, "org");
  assert.equal(n.moves.length, 1, "سجل النقل لم يُحمل إلى الملاحظة الجديدة");
});

grow();
// The model spells the source its own way: another case, a plural.
reply3 = { title: "فيديو", facts: [tool3("Video-Tool", "gotcha.fonts", "خط تجاري كآصال ليس في قوقل فونتس فيسقط صامتاً على خط النظام"), fact("engine", "stack.db", "القاعدة SQLite")] };
await scan(cfg3, opts3);

await check("a move is matched as a slot is — by spelling, not by more — and a rebuild lands where the scan did", () => {
  assert.deepEqual(slotsOf(vault3), ["dojo.gotcha.video-font", "engine.stack.db"]);
  const copy = path.join(base, "copy3");
  fs.cpSync(vault3, copy, { recursive: true });
  rebuildIndex(ConfigSchema.parse({ ...cfg3, vault: copy }));
  assert.deepEqual(live(copy), live(vault3));
});

// ---- restore: the mirror of retract ---------------------------------------------

grow();
reply3 = { title: "فيديو", facts: [fact("engine", "stack.db", "القاعدة SQLite")] };
await scan(cfg3, opts3);

await check("a re-read that drops the claim withdraws it; restore puts it back as it was, and a rebuild agrees", () => {
  assert.deepEqual(slotsOf(vault3), ["engine.stack.db"]);
  const r = restoreSlot(cfg3, "dojo", "gotcha.video-font");
  assert.equal(r.refused, null, r.refused);
  assert.equal(r.session, SID);
  assert.equal(r.fact.confidence, 0.85);
  assert.ok(r.rebase.restored >= 1, "الصف المسحوب لم يُحيَ");
  assert.equal(r.rebase.inserted, 0, "أُدرج صف بدل إحياء المسحوب");
  assert.deepEqual(live(vault3), [
    "dojo.gotcha.video-font claude-code:00000000-0000-4000-8000-00000000000a خط تجاري كآصال ليس في قوقل فونتس فيسقط صامتاً على خط النظام حي",
    "engine.stack.db claude-code:00000000-0000-4000-8000-00000000000a القاعدة SQLite حي",
  ]);
  const n = noteOf();
  assert.ok(n.facts.some((f) => f.subject === "dojo" && f.key === "gotcha.video-font"));
  assert.ok(!n.retracted.some((f) => f.subject === "dojo" && f.key === "gotcha.video-font" && f.claim === r.fact.claim), "السحب ما زال في الذيل");
  assert.equal(n.retracted.filter((f) => f.subject === "dojo" && f.key === "gotcha.video-font").length, 1, "الصياغة الأولى المستبدَلة ضاعت من الذيل");
  assert.equal(n.moves.length, 1, "سجل النقل ضاع مع الاستعادة");
  const copy = path.join(base, "copy3b");
  fs.cpSync(vault3, copy, { recursive: true });
  rebuildIndex(ConfigSchema.parse({ ...cfg3, vault: copy }));
  assert.deepEqual(live(copy), live(vault3));
});

await check("restore refuses a live slot, a slot no note withdrew, and the source of a move — naming its target", () => {
  const before = digest(vault3);
  assert.match(restoreSlot(cfg3, "dojo", "gotcha.video-font").refused, /حيّة/);
  assert.match(restoreSlot(cfg3, "dojo", "misc.nothing").refused, /لا ملاحظة/);
  const moved = restoreSlot(cfg3, "video-tool", "gotcha.font");
  assert.match(moved.refused, /نُقلت إلى dojo\.gotcha\.video-font/);
  assert.deepEqual(digest(vault3), before, "كُتب شيء رغم الرفض");
});

// ---- moves chain --------------------------------------------------------------

const chained = movePlan(cfg3, { reason: "مفتاح أدق", moves: [{ subject: "dojo", key: "gotcha.video-font", to: "dojo", toKey: "gotcha.font-fallback", kind: "org" }] });
grow();
reply3 = { title: "فيديو", facts: [tool3("video-tool", "gotcha.font", "خط تجاري كآصال ليس في قوقل فونتس فيسقط صامتاً على خط النظام"), fact("engine", "stack.db", "القاعدة SQLite")] };
await scan(cfg3, opts3);

await check("a slot moved twice follows both moves on a re-read", () => {
  assert.deepEqual(chained.refused, []);
  assert.deepEqual(noteOf().moves.map((m) => `${m.subject}.${m.key} → ${m.to}.${m.toKey}`), [
    "video-tool.gotcha.font → dojo.gotcha.video-font",
    "dojo.gotcha.video-font → dojo.gotcha.font-fallback",
  ]);
  assert.deepEqual(slotsOf(vault3), ["dojo.gotcha.font-fallback", "engine.stack.db"]);
});

// ---- a session still open is not read ------------------------------------------
// The full scan of 2026-09-24 read the session that was running it, halfway
// through. A transcript written to in the last two minutes is left for the
// hook, which names it with --file when the session ends (the user's rule).

grow();
const now = new Date();
fs.utimesSync(transcript3, now, now);
const openScan = await scan(cfg3, opts3);
const forced = await scan(cfg3, { ...opts3, force: true });
const byHook = await scan(cfg3, { ...opts3, onlyFile: transcript3 });
grow();
const later = await scan(cfg3, opts3);

check("a transcript written in the last two minutes is skipped, --force included; the hook's --file reads it; a session quiet for minutes is read", () => {
  assert.equal(openScan.processed, 0, "قُرئت جلسة مفتوحة");
  assert.equal(openScan.skippedOpen, 1);
  assert.equal(openScan.discovered, 1);
  assert.equal(forced.processed, 0, "--force قرأ جلسة مفتوحة");
  assert.equal(forced.skippedOpen, 1);
  assert.equal(byHook.processed, 1, "--file لم يقرأ الجلسة المنتهية");
  assert.equal(byHook.skippedOpen, 0);
  assert.equal(later.processed, 1, "جلسة أُغلقت منذ دقائق لم تُقرأ");
  assert.equal(later.skippedOpen, 0);
});

// ---- restore --confirm: the human's word, and it holds ------------------------------
// A plain restore is not immunity: the next reading that drops the claim
// withdraws it again. --confirm puts it back at 1.0 (constant 5), and the
// scan carries a 1.0 claim into the rewritten note, so a rebuild keeps it too.

grow();
reply3 = { title: "فيديو", facts: [fact("engine", "stack.db", "القاعدة SQLite")] };
await scan(cfg3, opts3);
const plain = restoreSlot(cfg3, "dojo", "gotcha.font-fallback");
grow();
await scan(cfg3, opts3);
const droppedAgain = slotsOf(vault3);
const confirmed = restoreSlot(cfg3, "dojo", "gotcha.font-fallback", { confirm: true });
const rowsAfterConfirm = rows(vault3);
grow();
const dropScan = await scan(cfg3, opts3);
const afterDrop = live(vault3);
const noteAfterDrop = noteOf();
grow();
// The reading now says something else for the slot, at model confidence.
reply3 = { title: "فيديو", facts: [tool3("video-tool", "gotcha.font", "خط النظام يحلّ محل الخط التجاري بلا تحذير"), fact("engine", "stack.db", "القاعدة SQLite")] };
const weakerScan = await scan(cfg3, opts3);
const afterWeaker = live(vault3);
const queueAfterWeaker = (() => {
  const st = new Store(vault3);
  try {
    return st.db.prepare("SELECT subject, key, claim, status FROM pending ORDER BY id").all();
  } finally {
    st.close();
  }
})();

check("a plain restore is withdrawn again by the next reading that drops the claim; --confirm restores at 1.0 as a new row, and the row withdrawn stays withdrawn", () => {
  assert.equal(plain.refused, null, plain.refused);
  assert.equal(plain.fact.confidence, 0.85);
  assert.deepEqual(droppedAgain, ["engine.stack.db"], "الاستعادة العادية صمدت أمام قراءة أسقطتها");
  assert.equal(confirmed.refused, null, confirmed.refused);
  assert.equal(confirmed.fact.confidence, 1);
  assert.equal(confirmed.rebase.inserted, 1, "لم يُدرج صف جديد بثقة 1.0");
  assert.ok(rowsAfterConfirm.includes("dojo.gotcha.font-fallback claude-code:00000000-0000-4000-8000-00000000000a خط تجاري كآصال ليس في قوقل فونتس فيسقط صامتاً على خط النظام حي"));
  assert.equal(rowsAfterConfirm.filter((r) => r.startsWith("dojo.gotcha.font-fallback") && r.endsWith("سُحب")).length, 1, "الصف المسحوب أُحيي بدل أن يبقى");
});

check("the confirmed claim survives a reading that drops it: kept in the note, not withdrawn, and a rebuild agrees", () => {
  assert.equal(dropScan.confirmedCarried, 1);
  assert.deepEqual(afterDrop.map((r) => r.split(" | ")[0] ?? r.split(" ")[0]).map((r) => r.split(" ")[0]), ["dojo.gotcha.font-fallback", "engine.stack.db"]);
  const kept = noteAfterDrop.facts.find((f) => f.subject === "dojo" && f.key === "gotcha.font-fallback");
  assert.ok(kept, "الملاحظة الجديدة لا تحمل المثبَّت");
  assert.equal(kept.confidence, 1);
  assert.ok(!noteAfterDrop.retracted.some((f) => f.subject === "dojo" && f.key === "gotcha.font-fallback" && f.confidence === 1), "المثبَّت سُجّل مسحوباً");
  const copy = path.join(base, "copy3c");
  fs.cpSync(vault3, copy, { recursive: true });
  rebuildIndex(ConfigSchema.parse({ ...cfg3, vault: copy }));
  assert.deepEqual(live(copy), live(vault3));
});

check("a weaker claim the reading makes for the confirmed slot is queued; the 1.0 claim stands", () => {
  assert.equal(weakerScan.confirmedCarried, 1);
  assert.deepEqual(afterWeaker.map((r) => r.split(" ")[0]), ["dojo.gotcha.font-fallback", "engine.stack.db"]);
  assert.ok(afterWeaker[0].includes("خط تجاري كآصال"), "الادعاء الأضعف أخذ الخانة");
  const q = queueAfterWeaker.find((x) => x.subject === "dojo" && x.key === "gotcha.font-fallback" && x.status === "waiting");
  assert.ok(q, "الادعاء الأضعف لم يُطرح على المستخدم");
  assert.equal(q.claim, "خط النظام يحلّ محل الخط التجاري بلا تحذير");
});

fs.rmSync(base, { recursive: true, force: true });

process.stdout.write(`\nmove: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
