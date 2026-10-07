import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../test-build/config.js";
import { auditPath, auditReport, nearWhy, runAudit } from "../test-build/pipeline/audit.js";
import { writeInbox } from "../test-build/pipeline/run.js";
import { rebaseAll } from "../test-build/pipeline/reindex.js";
import { Store } from "../test-build/store/db.js";
import { renderSessionNote, sessionNotePath } from "../test-build/store/vault.js";
import { writeFileAtomic } from "../test-build/util/fsatomic.js";

/**
 * `sila audit`: the five checks, each on a vault built to contain exactly one
 * instance of what it looks for — and one near miss it must stay silent about.
 * The last check is that it changed nothing: the whole command is a report.
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

const NOW = "2026-09-25T12:00:00.000Z";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mem-audit-"));
const vault = path.join(base, "vault");
const cfg = ConfigSchema.parse({ vault, sources: {}, git: false, briefSync: false });

const fact = (subject, key, claim, confidence = 0.85, subjectKind = "project") => ({ subject, subjectKind, key, claim, confidence });

// Four sessions of one live project, one of a project nobody has touched since
// January. The keys are the drift sightings of 2026-09-24, in miniature.
const sessions = [
  [
    "claude-code:s1",
    "2026-07-01T00:00:00.000Z",
    "engine",
    [
      fact("engine", "gotcha.git", "git diff بمسار من مجلد فرعي يعيد فراغاً كاذباً"),
      fact("engine", "stack.db", "القاعدة SQLite بملف واحد"),
      fact("engine", "gotcha.shell", "أمر tinker execute معطوب في PowerShell، والبديل كتابة ملف مؤقت"),
    ],
  ],
  ["claude-code:s2", "2026-07-02T00:00:00.000Z", "engine", [fact("engine", "gotcha.git-diff-pathspec", "المسار بعد -- يجعل git diff صامتاً")]],
  [
    "claude-code:s3",
    "2026-09-20T00:00:00.000Z",
    "engine",
    [
      fact("engine", "decision.tender-minimum", "حد العروض الثلاثة لا يربط ببنود الطلب، تُرك عمداً"),
      fact("engine", "arch.tender-minimum", "الحد يُحسب من عدد العروض المعتمدة وحدها"),
      fact("engine", "gotcha.tinker", "الملف المؤقت هو البديل الوحيد لتشغيل execute المعطوب داخل PowerShell"),
    ],
  ],
  ["claude-code:s4", "2026-01-05T00:00:00.000Z", "attic", [fact("attic", "stack.php", "الإصدار 8.1 ولا ترقية مخططة")]],
  [
    "claude-code:s5",
    "2026-09-21T00:00:00.000Z",
    "engine",
    [
      fact("BillingService", "arch.status", "الحالة تمرّ بثلاث مراحل"),
      fact("PoshTool", "gotcha.bom", "Set-Content يكتب BOM يفسد ملفات PHP", 0.85, "tool"),
    ],
  ],
];

const PROSE = "نص كتبه الاستخلاص، ولا يمسّه الفحص.";
{
  const s = new Store(vault);
  for (const [id, date, project, facts] of sessions) {
    const note = { title: id, project, summary: PROSE, did: [], decisions: [], rejected: [], open: [], links: [], facts };
    writeFileAtomic(
      sessionNotePath(vault, date, id),
      renderSessionNote({ note, sessionId: id, agent: "claude-code", sourceFile: `${id}.jsonl`, startedAt: date, usedModel: true, distilled: "0".repeat(64) }),
    );
    s.upsertSession({ id, agent: "claude-code", source_file: `${id}.jsonl`, content_hash: id, cwd: null, project, started_at: date, processed_at: date, status: "ok", note_path: null });
  }
  // A wait is a wait while its transcript is there to be read.
  const transcript = (name) => {
    const f = path.join(base, name);
    fs.writeFileSync(f, "{}\n");
    return f;
  };
  // Two sessions waiting for a CLI that is not installed: one since August,
  // one since yesterday. Only the first is a finding.
  s.upsertSession({ id: "codex:old", agent: "codex", source_file: transcript("old.jsonl"), content_hash: "h1", cwd: null, project: "engine", started_at: null, processed_at: "2026-08-01T00:00:00.000Z", status: "pending-extraction", note_path: null, detail: "codex غير مثبّت" });
  // Retried by today's scan, and waiting since May all the same: the wait is
  // the session's own age, not the age of the last attempt.
  s.upsertSession({ id: "codex:retried", agent: "codex", source_file: transcript("retried.jsonl"), content_hash: "h3", cwd: null, project: "engine", started_at: "2026-05-01T00:00:00.000Z", processed_at: "2026-09-25T08:00:00.000Z", status: "pending-extraction", note_path: null, detail: "codex غير مثبّت" });
  s.upsertSession({ id: "codex:fresh", agent: "codex", source_file: transcript("fresh.jsonl"), content_hash: "h2", cwd: null, project: "engine", started_at: null, processed_at: "2026-09-24T00:00:00.000Z", status: "pending-extraction", note_path: null, detail: "codex غير مثبّت" });
  // And two whose transcripts have gone since: lost, not waiting — the one of
  // June not among the week-old waits, the one of yesterday named all the same.
  s.upsertSession({ id: "codex:lost", agent: "codex", source_file: path.join(base, "lost.jsonl"), content_hash: "h4", cwd: null, project: "engine", started_at: "2026-09-24T00:00:00.000Z", processed_at: "2026-09-25T08:00:00.000Z", status: "pending-extraction", note_path: null, detail: "codex غير مثبّت" });
  s.upsertSession({ id: "codex:lost-june", agent: "codex", source_file: path.join(base, "lost-june.jsonl"), content_hash: "h5", cwd: null, project: "engine", started_at: "2026-06-01T00:00:00.000Z", processed_at: "2026-09-25T08:00:00.000Z", status: "pending-extraction", note_path: null, detail: "codex غير مثبّت" });
  s.close();
}
rebaseAll(cfg);

// Now the three divergences between the index and the notes, hand-made because
// nothing in the engine writes them on purpose: a row whose session has no note
// at all, a slot only the index claims (what `sila accept` leaves behind), and a
// slot the index and the note word differently. Dated this week, so the stale
// check has nothing to say about them.
{
  const s = new Store(vault);
  const row = (subject, key, claim, session_id, kind = "project", confidence = 0.85) =>
    s.insertFact({ subject, subject_kind: kind, key, claim, confidence, session_id, created_at: "2026-09-22T00:00:00.000Z" });
  row("engine", "misc.orphan", "جلستها ليست في المخزن", "claude-code:gone");
  // Old enough that only constant 5 keeps it out of the stale list.
  s.insertFact({ subject: "engine", subject_kind: "project", key: "convention.accepted", claim: "ثبّتها الإنسان في الفهرس وحده", confidence: 1, session_id: "claude-code:s1", created_at: "2026-07-01T00:00:00.000Z" });
  row("engine", "stack.db", "القاعدة Postgres على خادم بعيد", "claude-code:s1");
  s.close();
}

function digest(dir) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return walk(dir)
    .filter((f) => !f.includes(`${path.sep}.index${path.sep}`) && !f.endsWith(`${path.sep}audit.md`))
    .sort()
    .map((f) => `${path.relative(dir, f)} ${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}`);
}
function rows() {
  const s = new Store(vault);
  try {
    return s.db
      .prepare("SELECT subject, key, claim, confidence, session_id, superseded_by, retracted_at FROM facts ORDER BY id")
      .all()
      .map((r) => JSON.stringify(r));
  } finally {
    s.close();
  }
}

const filesBefore = digest(vault);
const rowsBefore = rows();
const r = runAudit(cfg, { now: NOW, days: 60, pendingDays: 7 });
const md = fs.readFileSync(auditPath(vault), "utf8");
const slot = (x) => `${x.subject}.${x.key}`;
const pair = (p) => `${p.subject}: ${p.a.key} ↔ ${p.b.key} [${p.why}]`;
check("a live row no note stands behind is reported, with which of the three ways it diverged", () => {
  const found = r.orphans.map((o) => `${slot(o)} ${o.why}`).sort();
  assert.deepEqual(found, [
    "engine.convention.accepted not-claimed",
    "engine.misc.orphan no-note",
    "engine.stack.db reworded",
  ]);
  const reworded = r.orphans.find((o) => o.why === "reworded");
  assert.equal(reworded.noteClaim, "القاعدة SQLite بملف واحد", "لم يُذكر ما تقوله الملاحظة في الخانة");
  // Every other live slot is claimed by its own session's note, so it is not here.
  assert.ok(!r.orphans.some((o) => o.key === "gotcha.git"), "خانة تدّعيها ملاحظتها عُدّت يتيمة");
});

check("two live keys of one subject that look like one slot are paired, by key words and by claim words alike", () => {
  const found = r.near.map(pair);
  assert.ok(found.includes("engine: gotcha.git ↔ gotcha.git-diff-pathspec [key-subset]"), found.join(" | "));
  assert.ok(found.includes("engine: arch.tender-minimum ↔ decision.tender-minimum [key-same-noun]"), found.join(" | "));
  const overlap = r.near.find((p) => p.why === "claim-overlap" && p.a.key === "gotcha.shell" && p.b.key === "gotcha.tinker");
  assert.ok(overlap, `الادعاءان المتشابهان بمفتاحين مختلفين لم يُقترنا: ${found.join(" | ")}`);
  assert.ok(overlap.shared.length >= 4, "لم تُسمَّ الكلمات المشتركة");
  // Two slots that only share a prefix are two slots — constant 14 holds here too.
  assert.ok(!found.some((f) => f.includes("stack.db ↔") || f.includes("↔ stack.db")), found.join(" | "));
});

check("a pair is judged by the four signals only — one shared word, or a shared prefix, is not a pair", () => {
  assert.equal(nearWhy({ key: "arch.tender-delete", claim: "حذف عرض يحرّر بنوده" }, { key: "arch.tender-items", claim: "بنود العرض تُنسخ من الطلب" }), null);
  assert.equal(nearWhy({ key: "gotcha.gate", claim: "أ" }, { key: "gotcha.gates", claim: "ب" }).why, "same-key");
  assert.equal(nearWhy({ key: "gotcha.tinker", claim: "أ" }, { key: "gotcha.tinker-dollar-sign", claim: "ب" }).why, "key-subset");
  // Three shared words is what any two short claims about one table share —
  // seven of the 25 pairs on the real vault were that, so four is the floor.
  assert.equal(
    nearWhy(
      { key: "convention.test-db", claim: "قاعدة الاختبارات تُمسح عند كل تشغيل للحزمة" },
      { key: "gotcha.migrate-fresh", claim: "قاعدة الإنتاج تُمسح فقط عند تشغيل الترحيل الكامل" },
    ),
    null,
  );
});

check("a live subject the guard rejects, and a live tool with no definition, are both named — neither is visible to any extractor", () => {
  assert.deepEqual(r.rejected.map((x) => `${x.subject} ${x.why} ${x.project} ${x.facts}`), ["BillingService class engine 1"]);
  assert.deepEqual(r.undefinedTools.map((x) => `${x.subject} ${x.facts}`), ["PoshTool 1"]);
  assert.ok(md.includes("مواضيع لا يراها أي مستخلص — 2"), "القسم لم يجمع الاثنين");
});

check("a claim no note has restated for 60 days is reported only while its project is still being worked on", () => {
  const found = r.stale.map(slot).sort();
  assert.deepEqual(found, ["engine.gotcha.git", "engine.gotcha.git-diff-pathspec", "engine.gotcha.shell", "engine.stack.db"]);
  const old = r.stale.find((s) => s.key === "gotcha.git");
  assert.equal(old.age, 86);
  assert.equal(old.projectAge, 4, "عمر المشروع يُقاس بآخر جلسة له");
  // s3's and s5's own claims are days old; attic's is older than anything here, but
  // nobody has opened attic since January, so there is nothing to conclude from
  // the silence; and a 1.0 claim is immune by constant 5.
  assert.ok(!found.includes("engine.arch.tender-minimum"));
  assert.ok(!found.includes("attic.stack.php"), "مشروع خامد عُدّ نشطاً");
  assert.ok(!found.includes("engine.convention.accepted"), "ما ثبّته الإنسان طُلب تأكيده");
});

check("a session waiting for its agent's CLI for more than a week is named — by its own age, not by when a scan last retried it", () => {
  assert.deepEqual(r.pending.map((p) => `${p.sessionId} ${p.age}`), ["codex:retried 147", "codex:old 55"]);
  assert.ok(md.includes("codex:old"), "الجلسة المعلّقة غائبة عن التقرير");
  // Its last attempt was this morning; the report says so without calling it fresh.
  assert.ok(md.includes("جلسة 2026-05-01، تنتظر 147 يوماً · آخر محاولة 2026-09-25"), "الانتظار قيس بآخر محاولة");
  assert.ok(!md.includes("codex:fresh"), "جلسة اليوم عُدّت معلّقة");
});

check("the report names every section, empty or not, and says what to run for each", () => {
  for (const heading of [
    "حقائق حيّة لا تذكرها ملاحظة — 3",
    "مفاتيح متقاربة تحت موضوع واحد",
    "مواضيع لا يراها أي مستخلص",
    "حقائق لم تُؤكَّد منذ 60 يوماً ومشروعها نشط — 4",
    "جلسات معلّقة منذ أكثر من 7 أيام — 2",
    "جلسات معلّقة نصّها مفقود — 2",
  ]) {
    assert.ok(md.includes(`## ${heading}`), `القسم غائب: ${heading}`);
  }
  assert.ok(md.includes("sila rebase") && md.includes("sila move --plan") && md.includes("sila retract"), "التقرير لا يقول ما يُشغَّل");
  assert.ok(md.includes("بلا إصلاح آلي"), "التقرير لا يقول إنه لم يُصلح شيئاً");
});

check("an empty section prints its heading rather than vanishing: silence must be readable", () => {
  const quiet = path.join(base, "quiet");
  fs.mkdirSync(quiet, { recursive: true });
  const s = new Store(quiet);
  s.close();
  const qcfg = ConfigSchema.parse({ vault: quiet, sources: {}, git: false, briefSync: false });
  const qs = new Store(quiet);
  const empty = auditReport(qcfg, qs, { now: NOW });
  qs.close();
  assert.equal(empty.orphans.length + empty.near.length + empty.stale.length + empty.pending.length + empty.gone.length + empty.rejected.length, 0);
  const out = runAudit(qcfg, { now: NOW });
  const qmd = fs.readFileSync(auditPath(quiet), "utf8");
  assert.equal((qmd.match(/^لا شيء ✓$/gm) ?? []).length, 6, "أقسام فارغة بلا سطر");
  assert.equal(out.scanned.facts, 0);
});

check("nothing is fixed: not a row, not a note, not a subject file", () => {
  assert.deepEqual(rows(), rowsBefore, "الفحص عدّل صفاً");
  assert.deepEqual(digest(vault), filesBefore, "الفحص عدّل ملفاً في المخزن");
  assert.equal(path.basename(r.file), "audit.md");
  assert.ok(r.file.includes(`${path.sep}_inbox${path.sep}`), "التقرير كُتب خارج _inbox");
});

check("a run on a quiet day is byte-identical, so the weekly commit carries a change or nothing", () => {
  const again = runAudit(cfg, { now: NOW, days: 60, pendingDays: 7 });
  assert.equal(fs.readFileSync(auditPath(vault), "utf8"), md);
  assert.deepEqual(again.orphans.map(slot), r.orphans.map(slot));
});

check("a wait whose transcript has gone is named lost, at any age — not counted among the waits", () => {
  assert.deepEqual(r.gone.map((g) => g.sessionId), ["codex:lost-june", "codex:lost"]);
  assert.ok(!r.pending.some((p) => p.sessionId.startsWith("codex:lost")), "عُدّت المفقودة بين المعلّقة");
  assert.ok(md.includes(`نصّها مفقود: ${path.join(base, "lost.jsonl")}`), "التقرير لا يسمّيها مفقودة");
  assert.ok(md.includes("ليست تنتظر"), "التقرير لا يقول إنها لن تُعاد");
});

check("sila stats counts it apart from the waits, by name, and the inbox does not promise it a retry", () => {
  const cli = fileURLToPath(new URL("../test-build/cli.js", import.meta.url));
  const out = execFileSync(process.execPath, [cli, "stats", "--vault", vault], { encoding: "utf8" });
  assert.match(out, /^pendingExtraction 3\n {2}codex 3 — codex غير مثبّت\n/m);
  assert.match(out, /^unreadTextGone 2$/m);
  for (const id of ["lost", "lost-june"]) assert.match(out, new RegExp(`^ {2}codex:${id} — نصّها مفقود · .*${id}\\.jsonl$`, "m"));
  const s = new Store(vault);
  writeInbox(s, vault);
  s.close();
  const inbox = fs.readFileSync(path.join(vault, "_inbox", "pending.md"), "utf8");
  const [waits, lost] = inbox.split("# جلسات معلّقة نصّها مفقود");
  assert.ok(lost?.includes("codex:lost"), "الصندوق لا يسمّيها مفقودة");
  assert.ok(!waits.includes("codex:lost"), "الصندوق يعدّها بين ما يُعاد في المسح التالي");
  assert.ok(waits.includes("codex:old"));
});

fs.rmSync(base, { recursive: true, force: true });

process.stdout.write(`\naudit: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
