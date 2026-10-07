import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema } from "../test-build/config.js";
import { offeredFacts, rejectedLiveSubjects, scan, undefinedLiveTools } from "../test-build/pipeline/run.js";
import { rebaseAll, rebuildIndex } from "../test-build/pipeline/reindex.js";
import { liveFactsAsOf, rebaseSubjects, reconcile, replayNote } from "../test-build/pipeline/reconcile.js";
import { Store } from "../test-build/store/db.js";
import { renderSessionNote, sessionNotePath } from "../test-build/store/vault.js";
import { writeFileAtomic } from "../test-build/util/fsatomic.js";

/**
 * The session date decides, not the processing order.
 *
 * Four sessions, 1–4 September, reach the scan as 3, 1, 4, 2 — the order a
 * pending session retried late or a hook firing out of turn produces. They
 * supersede one slot three times, restate it once, file one claim under two
 * keys, and withdraw another by name; then the 2 September session is read
 * again with --force and drops a claim. After each pass the rebuild from the
 * notes alone must give exactly the slots the scan left: that is what makes
 * `sila reindex` lossless.
 *
 * The scan here is the real one — adapter, distill, redaction, note, rebase —
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mem-order-"));
const vault = path.join(base, "vault");
const src = path.join(base, "claude-projects");
const cwd = path.join(base, "engine");
fs.mkdirSync(cwd, { recursive: true });

const cfg = ConfigSchema.parse({
  vault,
  sources: { claudeCode: src },
  extractor: { provider: "cli", cliOrder: ["claude"] },
  git: false,
  briefSync: false,
});

const DAYS = { A: "2026-09-01", B: "2026-09-02", C: "2026-09-03", D: "2026-09-04", E: "2026-09-05", F: "2026-09-06", G: "2026-09-07", H: "2026-09-08", I: "2026-09-09", J: "2026-09-10", K: "2026-09-11", L: "2026-09-12", M: "2026-09-13", N: "2026-09-14" };
const uuid = (m) => `${String("ABCDEFGHIJKLMN".indexOf(m) + 1).padStart(8, "0")}-0000-4000-8000-000000000000`;
const sid = (m) => `claude-code:${uuid(m)}`;

/** A Claude Code transcript that started on its day; the marker is how the runner knows it. */
function transcript(m, dir = cwd) {
  const file = path.join(src, "C--engine", `${uuid(m)}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const say = `SESSIONMARKER${m} ${"نعمل على محرّك الذاكرة ونقرّر أين تعيش البيانات وكيف تُقرأ. ".repeat(6)}`;
  const line = (type, content, at) =>
    JSON.stringify({ type, sessionId: uuid(m), cwd: dir, timestamp: `${DAYS[m]}T${at}.000Z`, message: { role: type, content } });
  fs.writeFileSync(file, [line("user", say, "10:00:00"), line("assistant", [{ type: "text", text: "تم." }], "10:05:00")].join("\n") + "\n");
  // Written on its day, not now: a transcript written in the last two
  // minutes is a session still open, and the scan leaves it alone.
  const t = new Date(`${DAYS[m]}T12:00:00.000Z`);
  fs.utimesSync(file, t, t);
  return file;
}

const fact = (key, claim, confidence) => ({ subject: "engine", subjectKind: "project", key, claim, confidence });
let replies = {
  A: { title: "أ", facts: [fact("stack.db", "القاعدة Postgres 15", 0.95), fact("arch.cache", "التخزين المؤقت في Redis", 0.85)] },
  B: { title: "ب", facts: [fact("stack.db", "القاعدة Postgres 16", 0.95), fact("arch.queue", "الطوابير عبر RabbitMQ", 0.85)] },
  C: { title: "ج", facts: [fact("stack.db", "القاعدة Postgres 17", 0.85)] },
  D: {
    title: "د",
    // The same claim again, and the queue under a second key: neither leaves a row.
    facts: [fact("stack.db", "القاعدة Postgres 17", 0.95), fact("misc.queue", "الطوابير عبر RabbitMQ", 0.85)],
    retract: [{ subject: "engine", key: "arch.cache", reason: "أُزيل Redis" }],
  },
};
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: "fake" };
const asked = [];
/** What each session was shown, by marker, one entry per reading. */
const shown = {};
/** Everything each reading was sent, by marker. */
const sent = {};
const runner = async (_name, input) => {
  const m = /SESSIONMARKER([A-N])/.exec(input)?.[1];
  asked.push(m);
  (shown[m] ??= []).push(input.slice(0, input.indexOf("## نص الجلسة") + 1 || 0));
  (sent[m] ??= []).push(input);
  return { text: typeof replies[m] === "string" ? replies[m] : JSON.stringify(replies[m]), usage };
};

const files = Object.fromEntries(["A", "B", "C", "D"].map((m) => [m, transcript(m)]));
// Processing follows file time: 3, 1, 4, 2 September.
["C", "A", "D", "B"].forEach((m, i) => {
  const t = new Date(Date.UTC(2026, 8, 10, 12, i));
  fs.utimesSync(files[m], t, t);
});

const LIVE = "SELECT subject, key, claim, session_id FROM facts WHERE superseded_by IS NULL AND retracted_at IS NULL ORDER BY subject, key";
function slots(dir) {
  const s = new Store(dir);
  try {
    return s.db.prepare(LIVE).all();
  } finally {
    s.close();
  }
}
function rebuiltSlots(tag) {
  const copy = path.join(base, `copy-${tag}`);
  fs.cpSync(vault, copy, { recursive: true });
  rebuildIndex(ConfigSchema.parse({ ...cfg, vault: copy }));
  return slots(copy);
}
const slot = (rows, key) => rows.find((r) => r.key === key);
const opts = { limit: 100, concurrency: 1, dryRun: false, force: false, runner };

// ---- the scan, out of date order -------------------------------------------

const rowCount = () => {
  const s = new Store(vault);
  try {
    return s.db.prepare("SELECT COUNT(*) c FROM facts").get().c;
  } finally {
    s.close();
  }
};

const first = await scan(cfg, opts);
const afterFirst = slots(vault);
const rowsAfterFirst = rowCount();

await check("the scan met the sessions out of date order", () => {
  assert.deepEqual(asked, ["C", "A", "D", "B"], `ترتيب المعالجة: ${asked}`);
  assert.equal(first.processed, 4);
});

await check("an older session read late does not displace a newer one", () => {
  const db = slot(afterFirst, "stack.db");
  assert.equal(db?.claim, "القاعدة Postgres 17", `الخانة تحمل ${db?.claim}`);
  assert.equal(db?.session_id, sid("C"), "الحالي ليس من جلسة ٣ سبتمبر");
});

await check("a claim filed under a second key by a later session is the earlier slot, not a new one", () => {
  assert.equal(slot(afterFirst, "arch.queue")?.session_id, sid("B"));
  assert.equal(slot(afterFirst, "misc.queue"), undefined, "فُتحت خانة ثانية لادعاء واحد");
});

await check("a slot withdrawn by name by a newer session stays empty", () => {
  assert.equal(slot(afterFirst, "arch.cache"), undefined);
});

await check("rebuilding from the notes gives exactly the slots the scan left", () => {
  assert.deepEqual(rebuiltSlots("first"), afterFirst);
});

// The extractor is told not to repeat what memory holds. Shown what later
// sessions learned, a session read late gave its own facts up.
await check("a session read late is shown the memory of its own day, not what newer sessions learned", () => {
  assert.ok(!(shown.A?.[0] ?? "").includes("Postgres"), "١ سبتمبر رأى ذاكرة ٣ سبتمبر");
  assert.ok((shown.A?.[0] ?? "").includes("المشروع: engine"), "ذاكرة فارغة بلا اسم المشروع");
  assert.ok(shown.B?.[0]?.includes("Postgres 15"), "٢ سبتمبر لم يرَ ما قبله");
  assert.ok(!shown.B?.[0]?.includes("Postgres 17"), "٢ سبتمبر رأى ما قيل في ٣ سبتمبر");
  assert.ok(!shown.B?.[0]?.includes("misc.queue"), "٢ سبتمبر رأى ما قيل في ٤ سبتمبر");
  assert.ok(shown.D?.[0]?.includes("Postgres 17"), "٤ سبتمبر لم يرَ ما قيل في ٣ سبتمبر");
});

// ---- a --force re-read of an old session ------------------------------------

replies = { ...replies, B: { title: "ب٢", facts: [fact("stack.db", "القاعدة Postgres 16", 0.95)] } };
const second = await scan(cfg, { ...opts, force: true, onlyFile: files.B });
const afterSecond = slots(vault);

await check("re-reading an old session does not take the slot back from a newer one", () => {
  assert.equal(second.processed, 1);
  assert.equal(slot(afterSecond, "stack.db")?.session_id, sid("C"));
});

await check("a --force re-read is shown what was known before the session, not its own earlier reading nor anything later", () => {
  const reread = shown.B?.[1] ?? "";
  assert.ok(reread.includes("Postgres 15"), "لم يرَ ما قبله");
  assert.ok(!reread.includes("Postgres 16"), "رأى قراءته السابقة لنفسه");
  assert.ok(!reread.includes("Postgres 17") && !reread.includes("misc.queue"), "رأى ما قيل بعده");
});

await check("what the re-read withdrew hands its claim to the later session that also made it", () => {
  assert.equal(slot(afterSecond, "arch.queue"), undefined, "بقي ما سحبته إعادة القراءة");
  assert.equal(slot(afterSecond, "misc.queue")?.session_id, sid("D"), "لم تعد الخانة لجلسة ٤ سبتمبر");
  assert.ok(second.factsRestored >= 1, "لم يُبلَّغ عن خانة أعادها ترتيب التاريخ");
});

await check("after the re-read, the rebuild still gives exactly the scan's slots", () => {
  assert.deepEqual(rebuiltSlots("second"), afterSecond);
});

await check("no row was deleted along the way, and the one set aside came back rather than being copied", () => {
  // Six claims ever held a slot: 15, 16, 17, Redis, the queue under each key.
  assert.equal(rowsAfterFirst, 6);
  assert.equal(rowCount(), 6, "صف حُذف أو صف تكرّر");
  const s = new Store(vault);
  const queue = s.db.prepare("SELECT session_id FROM facts WHERE key = 'misc.queue'").all();
  s.close();
  assert.deepEqual(queue, [{ session_id: sid("D") }], "صف misc.queue تكرّر بدل أن يُعاد");
});

// ---- a new subject named like a part of the project -------------------------
// Re-reading 35 real sessions with no subject rule gave a subject to each
// class and audit item: BillingService, X9-42.

const onPart = (subject, key, claim) => ({ subject, subjectKind: "term", key, claim, confidence: 0.85 });
replies = {
  ...replies,
  E: { title: "هـ", facts: [onPart("EngineService", "arch.flow", "الخدمة تمرّ بثلاث مراحل"), onPart("T9-01", "misc.fix", "أُغلق البند بإصلاح المسار")] },
};
files.E = transcript("E");
const third = await scan(cfg, { ...opts, onlyFile: files.E });

await check("a new subject named like a class or a ticket lands on the project, under a key naming the part", () => {
  assert.equal(third.processed, 1);
  assert.equal(third.subjectsAnchored, 2, "لم يُبلَّغ عن الموضوعين");
  const live = slots(vault).filter((r) => r.session_id === sid("E"));
  assert.deepEqual(live.map((r) => `${r.subject}.${r.key}`).sort(), ["engine.arch.service-flow", "engine.misc.t9-01-fix"]);
  assert.ok(shown.E?.[0]?.includes("المواضيع الحيّة: engine"), "المواضيع الحيّة لم تُعرض");
  assert.deepEqual(rebuiltSlots("third"), slots(vault), "إعادة البناء لا تطابق");
});

// ---- a re-read that words a claim anew under the same key -------------------
// 97c97962's re-read said arch.checkteam in other words, and the old wording
// was filed under «سُحب» beside the new one in the facts — as if the first
// reading had been wrong about the slot, when it had only put it differently.

/** Each row of a slot as its history reads: live, withdrawn, or replaced by what. */
function labels(dir, keys) {
  const s = new Store(dir);
  try {
    const rows = s.db.prepare("SELECT * FROM facts WHERE subject = 'engine' ORDER BY id").all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows
      .filter((r) => keys.includes(r.key))
      .map((r) => `${r.key} ${r.claim} ${r.retracted_at ? "سُحب" : r.superseded_by ? `→ ${byId.get(r.superseded_by)?.claim}` : "حي"}`)
      .sort();
  } finally {
    s.close();
  }
}

replies = {
  ...replies,
  F: { title: "و", facts: [fact("arch.lock", "قفل ملف على المسح، واحد لكل مخزن", 0.85), fact("misc.backup", "النسخ الاحتياطي يومياً إلى قرص خارجي", 0.85)] },
};
files.F = transcript("F");
await scan(cfg, { ...opts, onlyFile: files.F });
replies = { ...replies, F: { title: "و٢", facts: [fact("arch.lock", "المسح يأخذ قفلاً لا يُنتزع من صاحب حيّ", 0.85)] } };
const fourth = await scan(cfg, { ...opts, force: true, onlyFile: files.F });

await check("a re-read that words a claim anew under the same key files the old wording as replaced, not withdrawn", () => {
  assert.equal(fourth.processed, 1);
  assert.deepEqual(labels(vault, ["arch.lock", "misc.backup"]), [
    "arch.lock المسح يأخذ قفلاً لا يُنتزع من صاحب حيّ حي",
    "arch.lock قفل ملف على المسح، واحد لكل مخزن → المسح يأخذ قفلاً لا يُنتزع من صاحب حيّ",
    "misc.backup النسخ الاحتياطي يومياً إلى قرص خارجي سُحب",
  ]);
  assert.equal(fourth.factsSuperseded, 1, "لم يُعدّ استبدالاً");
  assert.equal(fourth.factsRetracted, 1, "عُدّت الصياغة الجديدة سحباً");
  assert.equal(fourth.factsRestored, 0, "سُحبت ثم أُعيدت");
});

await check("the note and the subject file put the old wording under «استُبدل», and only the silent slot under «سُحب»", () => {
  const md = fs.readFileSync(sessionNotePath(vault, `${DAYS.F}T10:00:00.000Z`, sid("F")), "utf8");
  /** A heading's lines, up to the next heading or the trailer. */
  const section = (text, heading) => {
    const at = text.indexOf(`\n${heading}\n`);
    if (at < 0) return "";
    const body = text.slice(at + heading.length + 2);
    const end = body.search(/\n## |\n<!--/);
    return end < 0 ? body : body.slice(0, end);
  };
  assert.ok(section(md, "## استُبدل").includes("قفل ملف على المسح"), "لا قسم استُبدل في الملاحظة");
  assert.ok(section(md, "## استُبدل").includes("→ المسح يأخذ قفلاً"), "الملاحظة لا تسمّي الصياغة الجديدة");
  assert.ok(!section(md, "## سُحب").includes("arch.lock"), "الخانة المستبدَلة في «سُحب» الملاحظة");
  assert.ok(section(md, "## سُحب").includes("misc.backup"));
  const subject = fs.readFileSync(path.join(vault, "subjects", "project", "engine.md"), "utf8");
  assert.ok(section(subject, "## استُبدل").includes("قفل ملف على المسح"), "ملف الموضوع لا يضعها في «استُبدل»");
  assert.ok(!section(subject, "## سُحب").includes("قفل ملف على المسح"), "ملف الموضوع يضعها في «سُحب»");
});

await check("the rebuild files the reworded slot the same way the scan did", () => {
  const copy = path.join(base, "copy-fourth");
  fs.cpSync(vault, copy, { recursive: true });
  rebuildIndex(ConfigSchema.parse({ ...cfg, vault: copy }));
  assert.deepEqual(labels(copy, ["arch.lock", "misc.backup"]), labels(vault, ["arch.lock", "misc.backup"]));
  assert.deepEqual(slots(copy), slots(vault));
});

// ---- a folder of the project is not a subject, live or new --------------------
// The first full scan filed 23 facts under acme_server, a folder of the
// repo. The list of live subjects offered it back, and a re-read on
// 2026-09-23 filed its facts there again.

replies = { ...replies, G: { title: "ز", facts: [{ ...fact("arch.sync", "المزامنة كل ساعة", 0.85), subject: "engine_mob" }] } };
files.G = transcript("G");
await scan(cfg, { ...opts, onlyFile: files.G });
fs.mkdirSync(path.join(cwd, "engine_mob"));
fs.mkdirSync(path.join(cwd, "engine_server"));
fs.mkdirSync(path.join(cwd, "docker"));
replies = {
  ...replies,
  H: {
    title: "ح",
    facts: [
      { ...fact("arch.api", "الواجهة REST بلا إصدارات", 0.85), subject: "engine_server" },
      { ...fact("gotcha.volumes", "المجلد يُربط بمسار مطلق", 0.85), subject: "Docker", subjectKind: "tool" },
    ],
  },
};
files.H = transcript("H");
const fifth = await scan(cfg, { ...opts, onlyFile: files.H });

await check("a live subject named like a folder of the project is not shown to the model — not offered, and not its facts", () => {
  assert.ok(slots(vault).some((r) => r.subject === "engine_mob"), "الإعداد لم يُنتج موضوعاً قديماً حيّاً");
  const seen = shown.H?.[0] ?? "";
  assert.ok(seen.includes("المواضيع الحيّة: engine"), "المواضيع الحيّة لم تُعرض");
  assert.ok(!seen.includes("engine_mob"), "عُرض على النموذج موضوع يرفضه الحارس");
});

await check("a new subject named like a folder of the project lands on the project; a tool named like one stays a tool", () => {
  assert.equal(fifth.subjectsAnchored, 1);
  const live = slots(vault).filter((r) => r.session_id === sid("H"));
  assert.deepEqual(live.map((r) => `${r.subject}.${r.key}`).sort(), ["Docker.gotcha.volumes", "engine.arch.server-api"]);
  assert.deepEqual(rebuiltSlots("fifth"), slots(vault), "إعادة البناء لا تطابق");
});

await check("doctor's check names each live subject the guard now rejects, with its facts and its project — and nothing else", () => {
  const s = new Store(vault);
  try {
    assert.deepEqual(rejectedLiveSubjects(cfg, s), [{ subject: "engine_mob", kind: "project", project: "engine", facts: 1, why: "folder" }]);
  } finally {
    s.close();
  }
});

// ---- a reply that breaks twice, and a smaller reading ----------------------------
// 461b6fab came back garbled twice on 2026-09-23, at two different places, and
// nothing of either reply survived to say why.

// The token is prefix and body joined at run time, so a secret scanner never sees it whole (see redaction.test.mjs)
replies = { ...replies, I: '{"title": "ط", "facts": [{"subject": "engine", "claim": "نص فيه "علامة" لم تُهرَّب ومفتاح ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}]}' };
files.I = transcript("I");
const said = [];
const stderrWrite = process.stderr.write;
process.stderr.write = (s) => (said.push(String(s)), true);
const sixth = await scan(cfg, { ...opts, onlyFile: files.I }).finally(() => (process.stderr.write = stderrWrite));

await check("two unreadable replies are kept in .index/garbled, redacted, and the session waits", () => {
  assert.equal(sixth.processed, 0);
  assert.equal(sixth.pendingExtraction, 1);
  const dir = path.join(vault, ".index", "garbled");
  const kept = fs.readdirSync(dir).filter((f) => f.includes(uuid("I").slice(0, 8)));
  assert.equal(kept.length, 2, `محفوظ: ${kept}`);
  for (const f of kept) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(text.includes('نص فيه "علامة" لم تُهرَّب'), "الرد المحفوظ ليس الرد");
    assert.ok(!text.includes("ghp_" + "ABCDEFGHIJ") && text.includes("[REDACTED-GITHUB-TOKEN]"), "دخل المخزن بلا حجب");
  }
  assert.ok(said.some((l) => l.includes("حُفظ الرد 2")), said.join(""));
});

replies = { ...replies, J: { title: "ي", facts: [] } };
files.J = transcript("J");
{
  // Several turns, as a real session has: the cap drops whole turns from the middle.
  const line = (type, text, at) =>
    JSON.stringify({ type, sessionId: uuid("J"), cwd, timestamp: `${DAYS.J}T${at}.000Z`, message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
  const long = "نقرّر أين تعيش البيانات وكيف تُقرأ ومن يكتبها ومتى. ".repeat(8);
  fs.writeFileSync(
    files.J,
    [
      line("user", `SESSIONMARKERJ ${long}`, "10:00:00"),
      line("assistant", long, "10:01:00"),
      line("user", long, "10:02:00"),
      line("assistant", long, "10:03:00"),
      line("user", long, "10:04:00"),
    ].join("\n") + "\n",
  );
}
await scan(cfg, { ...opts, onlyFile: files.J });
await scan(cfg, { ...opts, force: true, onlyFile: files.J, maxChars: 1200 });

await check("--max-chars reads the session through a smaller window, this run only", () => {
  const [full, small] = (sent.J ?? []).map((t) => t.slice(t.indexOf("SESSIONMARKER")));
  assert.ok(full && small, "لم تُقرأ الجلسة مرتين");
  assert.ok(small.length < full.length, `${small.length} ليس أصغر من ${full.length}`);
  assert.ok(small.length <= 1200, `${small.length} أكبر من السقف`);
});

// ---- a tool is shown with what it admits, or not at all ------------------------
// Docker has been a live tool since H, and nothing says where it ends.

await check("a live tool with no definition is shown to no reading, and doctor names it; defined, it comes with its line", async () => {
  const [plain] = shown.J ?? [];
  assert.ok(plain?.includes("المواضيع الحيّة: engine"), "المواضيع الحيّة لم تُعرض");
  assert.ok(!plain.includes("Docker"), "عُرضت أداة بلا تعريف");
  const s = new Store(vault);
  const defined = ConfigSchema.parse({ ...cfg, definitions: { Docker: "الحاويات وأوامرها، لا ملفات المشروع" } });
  try {
    assert.deepEqual(undefinedLiveTools(cfg, s), [{ subject: "Docker", facts: 1, projects: ["engine"] }]);
    assert.deepEqual(undefinedLiveTools(defined, s), []);
  } finally {
    s.close();
  }
  await scan(defined, { ...opts, force: true, onlyFile: files.J });
  const seen = shown.J.at(-1) ?? "";
  assert.ok(seen.includes("- Docker: الحاويات وأوامرها، لا ملفات المشروع"), "الأداة المعرّفة بلا سطرها");
  assert.ok(seen.includes("- Docker.gotcha.volumes: المجلد يُربط بمسار مطلق"), "حقيقة الأداة المعرّفة غابت");
});

// ---- a tool's facts cross projects; a project's do not ------------------------
// A acme reading never saw tooling's facts from beta.

await check("a defined tool's facts cross projects for the same agent only; another project's own facts do not", () => {
  const live = [
    { subject: "engine", session_id: "claude-code:1" },
    { subject: "other", session_id: "claude-code:2" },
    { subject: "tooling", session_id: "claude-code:2" },
    { subject: "tooling", session_id: "codex:3" },
    { subject: "Docker", session_id: "claude-code:2" },
  ];
  const ours = new Set(["claude-code:1"]);
  const at = (rows) => rows.map((f) => `${f.subject}@${f.session_id}`);
  assert.deepEqual(at(offeredFacts(live, ours, "claude-code", new Set(["tooling"]))), ["engine@claude-code:1", "tooling@claude-code:2"]);
  // A wall that may try several CLIs: no agent to match, the project's own only.
  assert.deepEqual(at(offeredFacts(live, ours, null, new Set(["tooling"]))), ["engine@claude-code:1"]);
});

const elsewhere = path.join(base, "other");
fs.mkdirSync(elsewhere, { recursive: true });
replies = {
  ...replies,
  K: {
    title: "ك",
    facts: [
      { subject: "tooling", subjectKind: "tool", key: "gotcha.git-diff-pathspec", claim: "git diff بمسار يعيد فراغاً كاذباً", confidence: 0.85 },
      { subject: "other", subjectKind: "project", key: "arch.secret", claim: "تفصيل لا يخص engine", confidence: 0.85 },
    ],
  },
  L: { title: "ل", facts: [] },
};
files.K = transcript("K", elsewhere);
await scan(cfg, { ...opts, onlyFile: files.K });
files.L = transcript("L");
await scan(cfg, { ...opts, onlyFile: files.L });

await check("a reading of engine is shown tooling's fact from another project, and not that project's own", () => {
  const seen = shown.L?.[0] ?? "";
  assert.ok(seen.includes("tooling.gotcha.git-diff-pathspec"), "مفتاح tooling من مشروع آخر لم يُعرض");
  assert.ok(!seen.includes("arch.secret") && !seen.includes("تفصيل لا يخص engine"), "عُرضت حقيقة مشروع آخر");
});

// Past forty slots, the claim goes to those nearest the session's own text:
// the one that matches it is shown whole though its key sorts last.
replies = {
  ...replies,
  M: {
    title: "م",
    facts: [
      ...Array.from({ length: 41 }, (_, i) => fact(`misc.k${String(i).padStart(2, "0")}`, `ادعاء رقم ${i} قائم`, 0.85)),
      fact("misc.zz-where", "تعيش البيانات في ملف واحد لكل مخزن", 0.85),
    ],
  },
  N: { title: "ن", facts: [] },
};
files.M = transcript("M");
await scan(cfg, { ...opts, onlyFile: files.M });
files.N = transcript("N");
await scan(cfg, { ...opts, onlyFile: files.N });

await check("past forty slots, the scan shows the claim of the one nearest the session's text, and every other key", () => {
  const seen = (shown.N?.[0] ?? "").split("\n");
  assert.ok(seen.includes("- engine.misc.zz-where: تعيش البيانات في ملف واحد لكل مخزن"), "الأقرب لنص الجلسة بلا ادعائه");
  assert.ok(seen.filter((l) => /^- engine\.misc\.k\d\d$/.test(l)).length > 0, "لا مفاتيح بلا ادعاءات — السقف لم يُبلغ");
  for (let i = 0; i < 41; i++) {
    const k = `- engine.misc.k${String(i).padStart(2, "0")}`;
    assert.ok(seen.some((l) => l === k || l.startsWith(`${k}: `)), `غاب ${k}`);
  }
});

// ---- rebase guards ------------------------------------------------------------

const note = (sessionId, date, facts, retracted = []) => ({ sessionId, date, facts, retracted, links: [] });
const FLOOR = 0.75;

await check("a rebase keeps a fact a human accepted, though no note records the accept", () => {
  const s = new Store(null);
  const n1 = note("s1", "2026-09-01T00:00:00.000Z", [fact("stack.db", "MySQL", 0.6)]);
  replayNote(s, n1, FLOOR);
  // What `sila accept` does: a 1.0 claim, in the database only.
  reconcile(s, { title: "", project: "", summary: "", did: [], decisions: [], rejected: [], open: [], links: [], facts: [fact("stack.db", "MySQL", 1)] }, "s1", 0, "2026-09-05T00:00:00.000Z");
  s.db.prepare("UPDATE pending SET status = 'accepted'").run();
  const out = rebaseSubjects(s, ["engine"], [n1], FLOOR, "2026-09-06T00:00:00.000Z");
  const live = s.currentFact("engine", "stack.db");
  const queue = s.db.prepare("SELECT status FROM pending").all().map((p) => p.status);
  s.close();
  assert.equal(live?.confidence, 1, "سُحب ما أكّده الإنسان");
  assert.equal(out.retracted, 0);
  assert.deepEqual(queue, ["accepted"], "عاد البند المقرَّر إلى الانتظار");
});

await check("replaying a withdrawn claim never knocks a stronger one off its slot", () => {
  const s = new Store(null);
  replayNote(s, note("s1", "2026-09-01T00:00:00.000Z", [fact("deploy.host", "الاستضافة على Hetzner", 0.95)]), FLOOR);
  const withdrawn = { ...fact("deploy.host", "الاستضافة على خادم منزلي", 0.6), createdAt: "2026-09-02T00:00:00.000Z", retractedAt: "2026-09-03T00:00:00.000Z" };
  replayNote(s, note("s2", "2026-09-02T00:00:00.000Z", [], [withdrawn]), FLOOR);
  const live = s.currentFact("engine", "deploy.host")?.claim;
  s.close();
  assert.equal(live, "الاستضافة على Hetzner");
});

await check("a re-read that says the same claim at more length leaves the note's wording live and supersedes the old", () => {
  // `equivalent` counts containment as sameness, so without this the index
  // kept the short wording while the note and every rebuild had the long one.
  const s = new Store(null);
  replayNote(s, note("s1", "2026-09-01T00:00:00.000Z", [fact("convention.cache", "رقم إصدار في روابط CSS لإجبار تحديث الكاش", 0.85)]), FLOOR);
  const reread = note("s1", "2026-09-01T00:00:00.000Z", [fact("convention.cache", "رقم إصدار في روابط CSS لإجبار تحديث الكاش؛ يُرفع يدوياً عند كل تحديث", 0.85)]);
  const out = rebaseSubjects(s, ["engine"], [reread], FLOOR, "2026-09-06T00:00:00.000Z");
  const rows = s.db.prepare("SELECT claim, superseded_by, retracted_at FROM facts ORDER BY id").all();
  s.close();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].superseded_by, "الصياغة القديمة لم تُستبدل");
  assert.equal(rows[0].retracted_at, null, "الصياغة القديمة سُحبت كأنها خطأ");
  assert.equal(rows[1].claim, reread.facts[0].claim, "الحيّ ليس نص الملاحظة");
  assert.equal(out.retracted, 0);
});

const withdrawnAs = (key, claim, confidence, retractedAt = "2026-09-20T00:00:00.000Z") => ({
  ...fact(key, claim, confidence),
  createdAt: "2026-09-01T00:00:00.000Z",
  retractedAt,
});

await check("a withdrawn wording whose slot the same note fills is superseded by the new wording, not withdrawn", () => {
  const s = new Store(null);
  const n = note("s1", "2026-09-01T00:00:00.000Z", [fact("arch.checkteam", "التحقق في middleware واحد", 0.85)], [
    withdrawnAs("arch.checkteam", "CheckTeam يمرّر الدور إلى كل مسار", 0.85),
  ]);
  replayNote(s, n, FLOOR);
  const [old, now] = s.db.prepare("SELECT id, claim, superseded_by, superseded_at, retracted_at FROM facts ORDER BY id").all();
  s.close();
  assert.equal(old.retracted_at, null, "الصياغة القديمة سُجّلت «سُحب»");
  assert.equal(old.superseded_by, now.id, "الصياغة القديمة لا تشير إلى الجديدة");
  assert.equal(old.superseded_at, "2026-09-01T00:00:00.000Z");
  assert.equal(now.superseded_by, null);
  assert.equal(now.retracted_at, null);
});

await check("each reading's wording of one slot chains to the next, oldest first", () => {
  const s = new Store(null);
  const n = note("s1", "2026-09-01T00:00:00.000Z", [fact("arch.lock", "الصياغة الثالثة للقفل", 0.85)], [
    withdrawnAs("arch.lock", "الصياغة الأولى للقفل", 0.85, "2026-09-10T00:00:00.000Z"),
    withdrawnAs("arch.lock", "الصياغة الثانية للقفل", 0.85, "2026-09-20T00:00:00.000Z"),
  ]);
  replayNote(s, n, FLOOR);
  const rows = s.db.prepare("SELECT id, superseded_by, retracted_at FROM facts ORDER BY id").all();
  s.close();
  assert.deepEqual(rows.map((r) => r.superseded_by), [rows[1].id, rows[2].id, null]);
  assert.deepEqual(rows.map((r) => r.retracted_at), [null, null, null]);
});

await check("a wording whose new claim does not take the slot — below the floor — stays withdrawn", () => {
  const s = new Store(null);
  const n = note("s1", "2026-09-01T00:00:00.000Z", [fact("arch.checkteam", "ربما التحقق في middleware", 0.6)], [
    withdrawnAs("arch.checkteam", "CheckTeam يمرّر الدور إلى كل مسار", 0.85),
  ]);
  replayNote(s, n, FLOOR);
  const rows = s.db.prepare("SELECT superseded_by, retracted_at FROM facts").all();
  const queued = s.pendingCount();
  s.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].retracted_at, "2026-09-20T00:00:00.000Z", "لم يُسحب ما لم يحلّ محله شيء");
  assert.equal(rows[0].superseded_by, null);
  assert.equal(queued, 1);
});

await check("a queued claim the notes no longer raise leaves the queue; one they raise is kept", () => {
  const s = new Store(null);
  const n1 = note("s1", "2026-09-01T00:00:00.000Z", [fact("misc.tz", "المنطقة Asia/Hebron", 0.6)]);
  replayNote(s, n1, FLOOR);
  s.addPending({ subject: "engine", subject_kind: "project", key: "misc.old", claim: "ادعاء لم يعد في أي ملاحظة", confidence: 0.6, reason: "below-confidence-floor", session_id: "s0", created_at: "2026-08-01T00:00:00.000Z" });
  rebaseSubjects(s, ["engine"], [n1], FLOOR, "2026-09-06T00:00:00.000Z");
  const rows = s.db.prepare("SELECT key, status FROM pending ORDER BY id").all();
  s.close();
  assert.deepEqual(rows, [
    { key: "misc.tz", status: "waiting" },
    { key: "misc.old", status: "obsolete" },
  ]);
});

await check("an item set aside as obsolete waits again when its note raises it again — a reverted re-read", () => {
  const s = new Store(null);
  const original = note("s1", "2026-09-01T00:00:00.000Z", [fact("misc.tz", "المنطقة Asia/Hebron", 0.6)]);
  const reread = note("s1", "2026-09-01T00:00:00.000Z", []);
  const status = () => s.db.prepare("SELECT status FROM pending").all().map((p) => p.status);
  rebaseSubjects(s, ["engine"], [original], FLOOR, "2026-09-06T00:00:00.000Z");
  assert.deepEqual(status(), ["waiting"]);
  rebaseSubjects(s, ["engine"], [reread], FLOOR, "2026-09-06T00:00:00.000Z");
  assert.deepEqual(status(), ["obsolete"]);
  const back = rebaseSubjects(s, ["engine"], [original], FLOOR, "2026-09-06T00:00:00.000Z");
  assert.deepEqual(status(), ["waiting"], "بقي خارج الطابور بعد عودة ملاحظته");
  assert.deepEqual(back.changed, ["engine"]);
  s.db.prepare("UPDATE pending SET status = 'rejected'").run();
  rebaseSubjects(s, ["engine"], [original], FLOOR, "2026-09-06T00:00:00.000Z");
  assert.deepEqual(status(), ["rejected"], "أُعيد إلى الانتظار ما رفضه المستخدم");
  s.close();
});

await check("liveFactsAsOf: strictly earlier notes and accepts, one project's sessions only", () => {
  const s = new Store(null);
  const n = [
    note("s1", "2026-09-01T00:00:00.000Z", [fact("stack.db", "القاعدة v1", 0.95)]),
    note("s2", "2026-09-02T00:00:00.000Z", [fact("deploy.host", "خادم الجار", 0.95)]),
    note("s3", "2026-09-03T00:00:00.000Z", [fact("stack.db", "القاعدة v2", 0.95)]),
  ];
  // An accept on 2 September, recorded only in the index.
  s.insertFact({ subject: "engine", subject_kind: "project", key: "misc.owner", claim: "المالك محمد", confidence: 1, session_id: "s1", created_at: "2026-09-02T12:00:00.000Z" });
  const ours = (id) => id !== "s2";
  const claims = (date) => liveFactsAsOf(s, n, date, FLOOR, ours).map((f) => `${f.key}=${f.claim}`);
  assert.deepEqual(claims("2026-09-01T00:00:00.000Z"), [], "ما في يوم الجلسة نفسه عُدّ قبلها");
  assert.deepEqual(claims("2026-09-02T00:00:00.000Z"), ["stack.db=القاعدة v1"]);
  assert.deepEqual(claims("2026-09-03T00:00:00.000Z"), ["misc.owner=المالك محمد", "stack.db=القاعدة v1"], "القبول غاب");
  assert.deepEqual(claims("2026-09-04T00:00:00.000Z"), ["misc.owner=المالك محمد", "stack.db=القاعدة v2"]);
  s.close();
});

// ---- sila rebase: an index built the old way, brought into line in place ------

await check("sila rebase aligns an index applied in processing order with its notes — no row deleted, no fingerprint reset", () => {
  const v = path.join(base, "rebase-vault");
  const c = ConfigSchema.parse({ vault: v, sources: {}, git: false, briefSync: false });
  const sessions = [
    ["claude-code:older", "2026-09-01T00:00:00.000Z", "القاعدة Postgres 15"],
    ["claude-code:newer", "2026-09-02T00:00:00.000Z", "القاعدة Postgres 16"],
  ];
  const notes = {};
  const s = new Store(v);
  for (const [id, date, claim] of sessions) {
    notes[id] = { title: id, project: "p", summary: "", did: [], decisions: [], rejected: [], open: [], links: [], facts: [fact("stack.db", claim, 0.95)] };
    writeFileAtomic(
      sessionNotePath(v, date, id),
      renderSessionNote({ note: notes[id], sessionId: id, agent: "claude-code", sourceFile: `${id}.jsonl`, startedAt: date, usedModel: true, distilled: "0".repeat(64) }),
    );
    s.upsertSession({ id, agent: "claude-code", source_file: `${id}.jsonl`, content_hash: `hash-${id}`, cwd: null, project: "p", started_at: date, processed_at: date, status: "ok", note_path: null });
  }
  // What the old scan did: applied as read — the newer first, the older over it.
  reconcile(s, notes["claude-code:newer"], "claude-code:newer", FLOOR);
  reconcile(s, notes["claude-code:older"], "claude-code:older", FLOOR);
  assert.equal(s.currentFact("engine", "stack.db").claim, "القاعدة Postgres 15", "الإعداد لم يُنتج العيب");
  const rowsBefore = s.db.prepare("SELECT COUNT(*) c FROM facts").get().c;
  s.close();

  const r = rebaseAll(c);
  assert.deepEqual(r.changed, ["engine"]);
  assert.equal(r.restored, 1, "لم يُعَد الادعاء الأحدث");
  const after = new Store(v);
  const live = after.currentFact("engine", "stack.db");
  const rowsAfter = after.db.prepare("SELECT COUNT(*) c FROM facts").get().c;
  const hashes = after.db.prepare("SELECT content_hash FROM sessions ORDER BY id").all().map((x) => x.content_hash);
  after.close();
  assert.equal(live.session_id, "claude-code:newer", `الحالي ${live.claim}`);
  assert.equal(rowsAfter, rowsBefore, "صف حُذف أو أُضيف بلا داعٍ");
  assert.deepEqual(hashes, ["hash-claude-code:newer", "hash-claude-code:older"], "صُفّرت البصمات");
  assert.ok(fs.readFileSync(path.join(v, "subjects", "project", "engine.md"), "utf8").includes("Postgres 16"), "ملف الموضوع لم يُكتب");

  const copy = path.join(base, "rebase-vault-copy");
  fs.cpSync(v, copy, { recursive: true });
  rebuildIndex(ConfigSchema.parse({ ...c, vault: copy }));
  assert.deepEqual(slots(copy), slots(v), "إعادة البناء لا تطابق ما طابقه rebase");
  assert.deepEqual(rebaseAll(c).changed, [], "تشغيل ثانٍ غيّر شيئاً");

  // A reverted re-read: the note is back, the index still quotes the reading undone.
  const stale = new Store(v);
  stale.setResume("claude-code:newer", JSON.stringify({ where: "قراءة أُرجعت", next: "", files: [], resumeCommand: null }));
  stale.indexNote("claude-code:newer", "p", "عنوان مُرجَع", "نص قراءة أُرجعت");
  const foundBefore = stale.search("أُرجعت").length;
  stale.close();
  const again = rebaseAll(c);
  const fresh = new Store(v);
  const row = fresh.getSession("claude-code:newer");
  const found = fresh.search("أُرجعت").length;
  fresh.close();
  assert.equal(foundBefore, 1, "الإعداد لم يُنتج النص القديم");
  assert.equal(again.resumes, 1, "الاستئناف لم يُعَد من الملاحظة");
  assert.equal(row.resume_json, null, "بقي استئناف القراءة المُرجَعة");
  assert.equal(found, 0, "البحث ما زال يجد نص القراءة المُرجَعة");

  // A claim below the floor never gets a fact row, and a link is only ever
  // added: both must still follow the note that is back.
  const q = new Store(v);
  q.addPending({ subject: "ACME.orphan", subject_kind: "term", key: "misc.x", claim: "ادعاء من قراءة أُرجعت", confidence: 0.6, reason: "below-confidence-floor", session_id: "claude-code:newer", created_at: "2026-09-02T00:00:00.000Z" });
  q.addLink("engine", "stray", "related", "claude-code:newer");
  q.close();
  rebaseAll(c);
  const w = new Store(v);
  const orphan = w.db.prepare("SELECT status FROM pending WHERE subject = 'ACME.orphan'").get();
  const stray = w.db.prepare("SELECT COUNT(*) c FROM links WHERE b = 'stray'").get().c;
  w.close();
  assert.equal(orphan.status, "obsolete", "بقي في الطابور ما لا تثيره ملاحظة");
  assert.equal(stray, 0, "بقي رابط لا تسمّيه ملاحظة");
});

fs.rmSync(base, { recursive: true, force: true });

process.stdout.write(`\norder: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
