import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../test-build/store/db.js";
import { anchorSubjects, applyRetractions, canonicalKey, canonicalizeFacts, reconcile, retractUnconfirmed } from "../test-build/pipeline/reconcile.js";

/**
 * One case per branch of the reconciler: a new slot, a contradiction that
 * should win, a contradiction that should not, and a rephrasing that is not a
 * contradiction at all — then the retraction path, which is the reconciler's
 * only way of saying "we were wrong" rather than "things changed".
 *
 * The third case is the one that matters. If a low-confidence inference can
 * overwrite something the user stated outright, the vault degrades every time
 * it is used, and nothing else in the system can detect that.
 */

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mem-reconcile-"));
const store = new Store(vault);
const FLOOR = 0.75;
const AT = "2026-09-14T00:00:00.000Z";

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

const note = (facts) => ({
  title: "t",
  project: "p",
  summary: "",
  did: [],
  decisions: [],
  rejected: [],
  open: [],
  links: [],
  facts,
});

const fact = (subject, key, claim, confidence) => ({
  subject,
  subjectKind: "project",
  key,
  claim,
  confidence,
});

const rows = () => store.db.prepare("SELECT COUNT(*) c FROM facts").get().c;
const rowById = (id) => store.db.prepare("SELECT * FROM facts WHERE id = ?").get(id);

// 1. Empty slot, confident claim → inserted.
check("insert into an empty slot", () => {
  const r = reconcile(store, note([fact("acme", "backend", "Laravel 10", 0.9)]), "s1", FLOOR);
  assert.equal(r.added, 1, "لم يُدرج");
  assert.equal(r.superseded, 0);
  assert.equal(r.insertedIds.length, 1, "لم يُبلَّغ عن المعرّف المُدرج");
  assert.equal(store.currentFact("acme", "backend").claim, "Laravel 10");
});

// 2. Equal-or-higher confidence contradiction → supersedes, nothing deleted.
check("a confident contradiction supersedes and keeps history", () => {
  const r = reconcile(store, note([fact("acme", "backend", "Laravel 11", 0.9)]), "s2", FLOOR);
  assert.equal(r.superseded, 1, "لم يستبدل");
  assert.equal(store.currentFact("acme", "backend").claim, "Laravel 11");

  const history = store.history("acme", "backend");
  assert.equal(history.length, 2, "التاريخ لا يحمل الادعاءين");
  const old = history.find((h) => h.claim === "Laravel 10");
  assert.ok(old.superseded_by, "القديم بلا superseded_by");
  assert.ok(old.superseded_at, "القديم بلا تاريخ استبدال");
});

// 3. The guard: a weaker claim may not overwrite a stronger one.
check("a weak contradiction is queued, not applied", () => {
  const before = store.currentFact("acme", "backend").claim;
  const r = reconcile(store, note([fact("acme", "backend", "Symfony", 0.5)]), "s3", FLOOR);
  assert.equal(r.queued, 1, "لم يُوضع في الانتظار");
  assert.equal(r.superseded, 0, "استبدل ادعاءً أقوى منه");
  assert.equal(store.currentFact("acme", "backend").claim, before, "تغيّر الحالي");

  const waiting = store.db
    .prepare("SELECT * FROM pending WHERE status='waiting' AND subject='acme' AND key='backend'")
    .all();
  assert.equal(waiting.length, 1, "لا بند واحد في الانتظار");
  assert.ok(waiting[0].reason.startsWith("conflicts-with:"), "سبب الانتظار غير صحيح");
});

// 4. Same claim, different wording → no change, no churn in git history.
check("a rephrasing is not a change", () => {
  const r = reconcile(
    store,
    // Normalization must see through diacritics, alef shapes and ta marbuta.
    note([fact("acme", "استضافة", "الاستضافة على Hetzner", 0.9)]),
    "s4",
    FLOOR,
  );
  assert.equal(r.added, 1, "لم يُدرج الأول");

  const again = reconcile(
    store,
    note([fact("acme", "استضافة", "الإستضافه على Hetzner", 0.9)]),
    "s5",
    FLOOR,
  );
  assert.equal(again.unchanged, 1, "لم يُعتبر إعادة صياغة");
  assert.equal(again.added, 0, "أدرج صفاً مكرراً");
  assert.equal(again.superseded, 0, "استبدل نفسه بنفسه");
});

// Below the floor on an empty slot waits for a human rather than entering.
check("a claim below the floor never enters an empty slot", () => {
  const r = reconcile(store, note([fact("newproj", "db", "MongoDB", 0.4)]), "s6", FLOOR);
  assert.equal(r.queued, 1, "لم يُوضع في الانتظار");
  assert.equal(r.added, 0, "دخل المخزن بثقة تحت الحد");
  assert.equal(store.currentFact("newproj", "db"), undefined, "احتلّ الخانة");
});

// Nothing in the reconciler may ever remove a row.
check("no row is ever deleted", () => {
  const total = rows();
  reconcile(store, note([fact("acme", "backend", "Laravel 12", 0.95)]), "s7", FLOOR);
  assert.equal(rows(), total + 1, "عدد الصفوف لم يزد بواحد فقط");
  assert.equal(store.history("acme", "backend").length, 3, "فُقد صف من التاريخ");
});

// ---- dates: a rebuild must record when a claim was learned, not when ------
// ---- the index was rebuilt.                                          ------

check("reconcile stamps rows with the given date, not the clock", () => {
  const first = reconcile(
    store,
    note([fact("hist", "os", "Ubuntu 22.04 LTS على الخادم الرئيسي", 0.9)]),
    "h1",
    FLOOR,
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(rowById(first.insertedIds[0]).created_at, "2026-01-01T00:00:00.000Z", "created_at من الساعة لا من الملاحظة");

  reconcile(
    store,
    note([fact("hist", "os", "Ubuntu 24.04 LTS على الخادم الرئيسي", 0.9)]),
    "h2",
    FLOOR,
    "2026-06-01T00:00:00.000Z",
  );
  assert.equal(rowById(first.insertedIds[0]).superseded_at, "2026-06-01T00:00:00.000Z", "superseded_at ليس تاريخ الجلسة الأحدث");
  assert.equal(store.currentFact("hist", "os").created_at, "2026-06-01T00:00:00.000Z");
});

check("without a date, reconcile uses the clock", () => {
  const before = Date.now() - 1000;
  const r = reconcile(store, note([fact("hist", "shell", "zsh مع oh-my-zsh", 0.9)]), "h3", FLOOR);
  assert.ok(new Date(rowById(r.insertedIds[0]).created_at).getTime() >= before, "created_at ليس الآن");
});

// ---- retraction: a re-reading of the same session withdraws what it no ----
// ---- longer claims, and only that.                                     ----

check("unconfirmed facts of a re-extracted session are retracted, not deleted", () => {
  // First reading of sX claimed two things.
  reconcile(
    store,
    note([
      fact("dar", "database", "قاعدة البيانات MySQL 8 على خادم منفصل", 0.9),
      fact("dar", "cache", "التخزين المؤقت عبر Redis 7 في الحاوية نفسها", 0.8),
    ]),
    "sX",
    FLOOR,
  );
  const before = rows();

  // Second reading confirms the database — reworded — and is silent on the cache.
  const out = retractUnconfirmed(
    store,
    "sX",
    note([fact("dar", "database", "قاعده البيانات MySQL 8 على خادم منفصل", 0.9)]),
    AT,
  );

  assert.equal(out.length, 1, "سُحب عدد خاطئ");
  assert.equal(out[0].key, "cache", "سُحبت الخانة الخطأ");
  assert.equal(out[0].retractedAt, AT);
  assert.equal(store.currentFact("dar", "cache"), undefined, "المسحوب ما زال حياً");
  assert.equal(
    store.currentFact("dar", "database").claim,
    "قاعدة البيانات MySQL 8 على خادم منفصل",
    "المؤكَّد بإعادة صياغة سُحب",
  );
  assert.equal(rows(), before, "حُذف صف");
  const row = store.db.prepare("SELECT retracted_at FROM facts WHERE subject='dar' AND key='cache'").get();
  assert.equal(row.retracted_at, AT, "لا retracted_at على الصف");
  assert.ok(!store.liveFacts("dar").some((f) => f.key === "cache"), "المسحوب في liveFacts");
  assert.ok(!store.subjects().some((s) => s.subject === "dar" && s.n !== 1), "عدّ المسحوب ضمن الحيّ");
});

check("retracting a superseding fact does not resurrect what it superseded", () => {
  reconcile(store, note([fact("dar", "host", "الاستضافة على Hetzner في فرانكفورت", 0.9)]), "s1", FLOOR);
  const r = reconcile(store, note([fact("dar", "host", "الاستضافة على DigitalOcean في أمستردام", 0.9)]), "sY", FLOOR);
  assert.equal(r.superseded, 1, "لم يستبدل");

  const out = retractUnconfirmed(store, "sY", note([]), AT);
  assert.equal(out.length, 1, "لم يُسحب البديل");
  assert.equal(store.currentFact("dar", "host"), undefined, "عاد المستبدَل تلقائياً");

  const hist = store.history("dar", "host");
  assert.equal(hist.length, 2, "فُقد صف");
  const hetzner = hist.find((h) => h.claim.includes("Hetzner"));
  assert.ok(hetzner.superseded_by, "القديم فقد superseded_by");
  assert.equal(hetzner.retracted_at, null, "سُحب ما لم يكن حياً");
});

check("a human-confirmed fact survives re-extraction", () => {
  reconcile(store, note([fact("dar", "owner", "المالك هو محمد", 1)]), "sZ", 0);
  const out = retractUnconfirmed(store, "sZ", note([]), AT);
  assert.equal(out.length, 0, "سُحب ما أكّده الإنسان");
  assert.equal(store.currentFact("dar", "owner").claim, "المالك هو محمد");
});

check("retracting twice is idempotent and touches only this session", () => {
  reconcile(store, note([fact("dar", "queue", "الطوابير عبر RabbitMQ", 0.8)]), "sW", FLOOR);
  const first = retractUnconfirmed(store, "sW", note([]), AT);
  const second = retractUnconfirmed(store, "sW", note([]), "2026-09-15T00:00:00.000Z");
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, "سُحب مرتين");
  const row = store.db.prepare("SELECT retracted_at FROM facts WHERE subject='dar' AND key='queue'").get();
  assert.equal(row.retracted_at, AT, "تاريخ السحب الأول أُعيدت كتابته");
  assert.ok(store.currentFact("dar", "database"), "سُحبت حقيقة من جلسة أخرى");
});

// ---- keys drift, claims do not: the same claim under a new key is the ----
// ---- same slot.                                                        ----

check("a claim re-filed under a new key stays in its old slot", () => {
  reconcile(store, note([fact("engine", "stack.db", "القاعدة SQLite في ملف memory.db", 0.9)]), "k1", FLOOR);
  const r = reconcile(store, note([fact("engine", "misc.storage", "القاعدة SQLite في ملف memory.db", 0.85)]), "k2", FLOOR);
  assert.equal(r.unchanged, 1, "لم يُعتبر الادعاء نفسه");
  assert.equal(r.added, 0, "فُتحت خانة ثانية للحقيقة نفسها");
  assert.equal(r.queued, 0, "وُضع في الانتظار ما هو معروف");
  assert.equal(store.currentFact("engine", "misc.storage"), undefined, "المفتاح الجديد احتلّ خانة");
  assert.equal(store.currentFact("engine", "stack.db").claim, "القاعدة SQLite في ملف memory.db", "المفتاح القديم لم يبقَ");
  assert.equal(store.liveFacts("engine").length, 1, "حقيقتان حيّتان لادعاء واحد");
});

check("a re-keyed claim below the floor is still not queued", () => {
  const before = store.pendingCount();
  const r = reconcile(store, note([fact("engine", "arch.storage", "القاعدة SQLite في ملف memory.db", 0.6)]), "k3", FLOOR);
  assert.equal(r.unchanged, 1);
  assert.equal(store.pendingCount(), before, "المعروف دخل قائمة الانتظار");
});

check("the same claim about another subject is a new fact", () => {
  const r = reconcile(store, note([fact("other", "stack.db", "القاعدة SQLite في ملف memory.db", 0.9)]), "k4", FLOOR);
  assert.equal(r.added, 1, "طُوبق ادعاء عبر موضوعين");
});

check("a re-reading that confirms a claim under a different key does not retract it", () => {
  reconcile(store, note([fact("engine", "deploy.host", "الاستضافة على Hetzner في هلسنكي", 0.85)]), "k5", FLOOR);
  const out = retractUnconfirmed(
    store,
    "k5",
    note([fact("engine", "misc.hosting", "الاستضافة على Hetzner في هلسنكي", 0.85)]),
    AT,
  );
  assert.equal(out.length, 0, "سُحب ما أُكّد تحت مفتاح آخر");
  assert.equal(store.currentFact("engine", "deploy.host").claim, "الاستضافة على Hetzner في هلسنكي");
});

// A re-read of 97c97962 said arch.checkteam again in other words; the old
// wording went into «سُحب» beside the new one in the facts.
check("a re-reading that words a claim anew under the same key returns it but leaves it live, for the rebase to file as replaced", () => {
  reconcile(
    store,
    note([
      fact("svc", "arch.checkteam", "CheckTeam يمرّر الدور من الجلسة إلى كل مسار", 0.85),
      fact("svc", "misc.cron", "مهمة ليلية تنظّف الجداول المؤقتة", 0.85),
    ]),
    "rw",
    FLOOR,
  );
  const out = retractUnconfirmed(store, "rw", note([fact("svc", "arch.checkteam", "التحقق من الصلاحية يتم في middleware واحد قبل المتحكّمات", 0.85)]), AT);
  assert.deepEqual(out.map((r) => r.key).sort(), ["arch.checkteam", "misc.cron"], "لم يُسجَّل للملاحظة كل ما لم يتكرّر");
  assert.ok(store.currentFact("svc", "arch.checkteam"), "سُحبت صياغة خانة تملؤها القراءة الجديدة");
  assert.equal(store.currentFact("svc", "misc.cron"), undefined, "بقي حياً ما سكتت عنه القراءة");
});

check("a slot named for withdrawal that the same note fills again is recorded but left live", () => {
  reconcile(store, note([fact("svc", "deploy.host", "الاستضافة على خادم منزلي", 0.85)]), "rn1", FLOOR);
  const facts = [fact("svc", "deploy.host", "الاستضافة على Hetzner", 0.85)];
  const out = applyRetractions(store, [{ subject: "svc", key: "deploy.host", reason: "نُقل" }], "rn2", AT, undefined, facts);
  assert.equal(out.length, 1, "لم يُسجَّل للملاحظة");
  assert.ok(store.currentFact("svc", "deploy.host"), "سُحبت خانة ستملؤها الجلسة نفسها");
});

// ---- a session that says outright "this is no longer true" ----------------

check("applyRetractions withdraws the named slot, with its reason, and only it", () => {
  reconcile(store, note([fact("app", "arch.lock", "لا يوجد قفل على المسح", 0.85)]), "r1", FLOOR);
  reconcile(store, note([fact("app", "stack.db", "القاعدة SQLite", 0.85)]), "r1", FLOOR);

  const out = applyRetractions(store, [{ subject: "app", key: "arch.lock", reason: "بُني القفل في هذه الجلسة" }], "r2", AT);
  assert.equal(out.length, 1, "سُحب عدد خاطئ");
  assert.equal(out[0].claim, "لا يوجد قفل على المسح", "السحب لم يحمل الادعاء الذي أُبطل");
  assert.equal(out[0].reason, "بُني القفل في هذه الجلسة");
  assert.equal(out[0].retractedAt, AT);
  assert.equal(store.currentFact("app", "arch.lock"), undefined, "بقي حيّاً بعد السحب");
  assert.ok(store.currentFact("app", "stack.db"), "سُحبت خانة أخرى");

  // Replaying the same request changes nothing: the slot is already empty.
  assert.equal(applyRetractions(store, [{ subject: "app", key: "arch.lock", reason: "مرة ثانية" }], "r3", AT).length, 0);
  assert.equal(applyRetractions(store, [{ subject: "app", key: "لا-وجود", reason: "س" }], "r3", AT).length, 0);
});

check("a model may not retract what a human confirmed at 1.0", () => {
  reconcile(store, note([fact("app", "convention.language", "الرسائل بالعربية", 1)]), "human", 0);
  const out = applyRetractions(store, [{ subject: "app", key: "convention.language", reason: "ظننتها تغيّرت" }], "r4", AT);
  assert.equal(out.length, 0, "سُحب ما أكّده الإنسان");
  assert.equal(store.currentFact("app", "convention.language").claim, "الرسائل بالعربية");
});

// ---- keys: one slot per key, however the model spells it — and no more ----
// The six-character root that used to live here merged tender-delete into
// tender-items and bundle-duplicate into bundle-write: 71 remaps in the
// first full scan, 70 of them two different facts filed as one.

check("keys that differ in more than case, dash or plural stay apart", () => {
  const known = ["arch.bundle-write"];
  assert.equal(canonicalKey("arch.bundle-scale", known), "arch.bundle-scale");
  assert.equal(canonicalKey("arch.bundle-duplicate", known), "arch.bundle-duplicate");
  assert.equal(canonicalKey("arch.tender-delete", ["arch.tender-items"]), "arch.tender-delete");
  assert.equal(canonicalKey("arch.reconciliation", ["arch.reconcile"]), "arch.reconciliation", "جذر مشترك دُمج");
  assert.equal(canonicalKey("decision.bundle-write", known), "decision.bundle-write", "بادئة مختلفة دُمجت");
  assert.equal(canonicalKey("stack.dbx", ["stack.db"]), "stack.dbx");
  assert.equal(canonicalKey("arch.bundlewrite", known), "arch.bundlewrite", "كلمتان صارتا كلمة");
});

check("case, dash against underscore, and a plural are one key", () => {
  assert.equal(canonicalKey("arch.bundle_write", ["arch.bundle-write"]), "arch.bundle-write");
  assert.equal(canonicalKey("ARCH.Bundle-Write", ["arch.bundle-write"]), "arch.bundle-write", "حالة الأحرف كسرت المطابقة");
  assert.equal(canonicalKey("convention.gates", ["convention.gate"]), "convention.gate");
  assert.equal(canonicalKey("convention.gate", ["convention.gates"]), "convention.gates", "الجمع في اتجاه واحد فقط");
  assert.equal(canonicalKey("gotcha.tickets-exposure", ["gotcha.ticket-exposure"]), "gotcha.ticket-exposure");
  assert.equal(canonicalKey("constraint.policies", ["constraint.policy"]), "constraint.policy");
  assert.equal(canonicalKey("misc.cookies", ["misc.cookie"]), "misc.cookie");
  assert.equal(canonicalKey("arch.access", ["arch.acces"]), "arch.access", "ss عُدّت جمعاً");
  // Oldest known spelling wins.
  assert.equal(canonicalKey("arch.bundle-writes", ["arch.bundle_write", "arch.bundle-write"]), "arch.bundle_write");
});

check("canonicalizeFacts: bundle-scale/write/duplicate stay three, tender-delete/items stay two, bundle_write is bundle-write", () => {
  reconcile(store, note([fact("keys", "arch.bundle-write", "كتابة الوصفة عبر خدمة واحدة", 0.95)]), "k1", FLOOR);
  reconcile(store, note([fact("keys", "arch.tender-items", "بنود عرض السعر في جدول مستقل", 0.95)]), "k1", FLOOR);
  const { facts, remapped } = canonicalizeFacts(store, [
    fact("keys", "arch.bundle-scale", "تكبير الوصفة يضرب كل المكوّنات", 0.95),
    fact("keys", "arch.bundle_write", "كتابة الوصفة تمرّ بطابور مهام", 0.95),
    fact("keys", "arch.bundle-duplicate", "نسخ الوصفة ينسخ مكوّناتها", 0.95),
    fact("keys", "arch.tender-delete", "حذف عرض السعر ناعم", 0.95),
    fact("keys", "arch.tender_delete", "حذف عرض السعر ناعم مع سجل", 0.95),
    fact("other", "arch.bundle_write", "موضوع آخر لا خانة له", 0.95),
  ]);
  assert.deepEqual(
    facts.map((f) => `${f.subject}.${f.key}`),
    [
      "keys.arch.bundle-scale",
      "keys.arch.bundle-write",
      "keys.arch.bundle-duplicate",
      "keys.arch.tender-delete",
      "keys.arch.tender-delete",
      "other.arch.bundle_write",
    ],
  );
  assert.deepEqual(remapped, [
    { subject: "keys", from: "arch.bundle_write", to: "arch.bundle-write" },
    { subject: "keys", from: "arch.tender_delete", to: "arch.tender-delete" },
  ]);
});

check("a respelled key lands on its slot and supersedes it instead of opening a second one", () => {
  const { facts } = canonicalizeFacts(store, [fact("keys", "arch.bundle_write", "كتابة الوصفة تمرّ بطابور مهام", 0.95)]);
  const r = reconcile(store, note(facts), "k2", FLOOR);
  assert.equal(r.superseded, 1, "لم يستبدل الخانة الموجودة");
  assert.equal(store.currentFact("keys", "arch.bundle_write"), undefined, "فُتحت خانة ثانية");
  assert.equal(store.currentFact("keys", "arch.bundle-write").claim, "كتابة الوصفة تمرّ بطابور مهام");
});

check("a key whose slot was emptied is still that slot for the next claim", () => {
  reconcile(store, note([fact("emptied", "deploy.host", "الاستضافة على Hetzner", 0.95)]), "e0", FLOOR);
  applyRetractions(store, [{ subject: "emptied", key: "deploy.host", reason: "نُقل" }], "e1", AT);
  const { facts } = canonicalizeFacts(store, [fact("emptied", "deploy.hosts", "الاستضافة على Fly.io", 0.95)]);
  assert.equal(facts[0].key, "deploy.host", "فُتحت تهجئة ثانية بجوار تاريخ الخانة");
});

check("reconcile itself stays exact — reindex replays keys as the note recorded them", () => {
  // If the guard lived here, reindex replaying a retracted `arch.reconciliation`
  // entry would land on the live `arch.reconcile`, supersede it, and then
  // withdraw the successor: a slot nobody retracted would end up empty.
  reconcile(store, note([fact("exact", "arch.reconcile", "الخانة الباقية", 0.95)]), "e1", FLOOR);
  const replay = reconcile(store, note([fact("exact", "arch.reconciliation", "ادعاء سُحب لاحقاً", 0.95)]), "e2", FLOOR);
  for (const id of replay.insertedIds) store.retract(id, AT);
  assert.equal(store.currentFact("exact", "arch.reconcile").claim, "الخانة الباقية", "إعادة تشغيل مسحوب أفرغت خانة حيّة");
});

// ---- subjects: a new one named like a part of a project goes back to it -----
// Re-reading 35 sessions without a subject rule gave 86 subjects where there
// had been 14: BillingService, X9-42, CLAUDE.md, ACME.CheckTeam.

check("anchorSubjects: a new subject named like a folder of the project moves to it; a tool named like one stays", () => {
  const kind = (f, subjectKind) => ({ ...f, subjectKind });
  const { facts: out, anchored } = anchorSubjects(
    [
      fact("acme_server", "arch.tender-award", "الترسية تُغلق عند عدم التطابق", 0.95),
      fact("acme_client", "convention.mobile", "sm:-gating فقط", 0.95),
      kind(fact("Docker", "gotcha.volumes", "المجلد يُربط بمسار مطلق", 0.85), "tool"),
    ],
    "acme",
    new Set(["acme"]),
    ["acme_server", "acme-client", "docker", "docs"],
  );
  assert.deepEqual(
    out.map((f) => `${f.subject}.${f.key}`),
    ["acme.arch.server-tender-award", "acme.convention.client-mobile", "Docker.gotcha.volumes"],
  );
  assert.deepEqual(anchored.map((a) => a.why), ["folder", "folder"]);
});

check("anchorSubjects: a new file, class or ticket subject moves to the project, under a key that names the part", () => {
  const known = new Set(["acme", "acme_server", "accounts.tax_code"]);
  const kind = (f, subjectKind) => ({ ...f, subjectKind });
  const input = [
    fact("BillingService", "arch.status", "الحالات تمرّ بخطوات ثابتة", 0.85),
    fact("BillingService", "arch.flow", "الترسية بعد المقارنة", 0.85),
    fact("X9-42", "misc.fix", "أُغلق البند", 0.85),
    fact("CLAUDE.md", "convention.docs", "التعليمات في ملف واحد", 0.95),
    fact("ACME.CheckTeam", "arch.team-check", "الدور يُفحص قبل الصلاحية", 0.85),
    fact("acme.convention", "convention.commits", "commit لكل بند", 0.95),
    fact("ACME", "stack.db", "MySQL 8", 0.95),
    fact("Acme-Server", "arch.api", "REST", 0.85),
    kind(fact("PowerShell", "gotcha.here-string", "الإغلاق في العمود صفر", 0.85), "tool"),
    kind(fact("GitHub", "deploy.ci", "Actions", 0.85), "tool"),
    kind(fact("Node.js", "stack.runtime", "الإصدار 22", 0.85), "tool"),
    kind(fact("gpt-4", "stack.llm", "للتلخيص", 0.85), "tool"),
    kind(fact("McDonald", "person.mcdonald.role", "مراجع", 0.95), "person"),
    fact("accounts.tax_code", "constraint.unique", "فريد", 0.85),
    fact("batch-split-rule", "arch.award", "ترسية لكل بند", 0.85),
    // A path names a use, not a tool, whatever the model called it.
    kind(fact("PowerShell/git stash", "gotcha.stash", "stash قبل التبديل", 0.85), "tool"),
  ];
  const { facts: out, anchored } = anchorSubjects(input, "acme", known);
  assert.deepEqual(
    out.map((f) => `${f.subject}.${f.key}`),
    [
      "acme.arch.billing-service-status",
      "acme.arch.billing-service-flow",
      "acme.misc.x9-42-fix",
      "acme.convention.claude-md-docs",
      "acme.arch.check-team",
      "acme.convention.commits",
      "acme.stack.db",
      "acme_server.arch.api",
      // A tool or a person is a subject by the definition, however spelled.
      "PowerShell.gotcha.here-string",
      "GitHub.deploy.ci",
      "Node.js.stack.runtime",
      "gpt-4.stack.llm",
      "McDonald.person.mcdonald.role",
      // Already live: history is not the guard's to rewrite.
      "accounts.tax_code.constraint.unique",
      // A concept inside the project is the prompt's to catch, not a name pattern's.
      "batch-split-rule.arch.award",
      "acme.gotcha.power-shell-git-stash",
    ],
  );
  assert.deepEqual(
    anchored.map((a) => a.why),
    ["class", "class", "ticket", "file", "file", "file", "spelling", "spelling", "file"],
  );
  assert.ok(out.slice(0, 6).every((f) => f.subjectKind === "project"), "بقي النوع القديم");
  assert.deepEqual(out.map((f) => f.claim), input.map((f) => f.claim), "تغيّر ادعاء");
});

store.close();
fs.rmSync(vault, { recursive: true, force: true });

process.stdout.write(`\nreconcile: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
