import assert from "node:assert/strict";
import { DEFINITIONS, SLOTS_LINE, SYSTEM, definitionsFor, extractNote, factsContext, parseNote } from "../test-build/pipeline/extract.js";
import { ConfigSchema } from "../test-build/config.js";
import { noteExtractor, renderSessionNote } from "../test-build/store/vault.js";

/**
 * The reply schema must rescue, not reject. The first live run lost a whole
 * note — and, under a same-provider wall, the whole session, forever — to one
 * number where the model was asked for a sentence. Each case here is one
 * shape of reply that used to take the note down with it.
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

/** Run fn with stderr captured; returns what was written. */
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => {
    lines.push(String(s));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines.join("");
}

const base = { title: "عنوان", summary: "ملخص الجلسة.", facts: [] };
const reply = (extra) => JSON.stringify({ ...base, ...extra });

check("a number in open becomes text and the note survives", () => {
  const err = captureStderr(() => {
    const n = parseNote(reply({ open: ["مراجعة الحجب", 3000, "نشر"] }), "s1");
    assert.deepEqual(n.open, ["مراجعة الحجب", "3000", "نشر"]);
  });
  assert.equal(err, "", "أُبلغ عن إسقاط ولم يُسقَط شيء");
});

check("an object in open is dropped alone, and said so on stderr", () => {
  const err = captureStderr(() => {
    const n = parseNote(reply({ open: ["أول", { what: "كائن" }, "ثالث"] }), "s2");
    assert.deepEqual(n.open, ["أول", "ثالث"], "سقط أكثر من العنصر التالف");
  });
  assert.match(err, /s2: أُسقط عنصر تالف من open/, "لا سطر في stderr");
  assert.match(err, /كائن/, "السطر لا يذكر ما أُسقط");
});

check("a fact with no claim is dropped, its neighbours kept, confidence coerced from text", () => {
  const n = parseNote(
    reply({
      facts: [
        { subject: "x", subjectKind: "project", key: "stack.db", claim: "SQLite", confidence: "0.85" },
        { subject: "x", subjectKind: "project", key: "stack.search", confidence: 0.6 },
        { subject: "x", subjectKind: "mystery", key: "deploy.host", claim: "Hetzner", confidence: 0.95 },
      ],
    }),
    "s3",
  );
  assert.equal(n.facts.length, 2, "سقطت حقيقة سليمة أو بقيت تالفة");
  assert.equal(n.facts[0].confidence, 0.85, "الثقة النصية لم تُحوَّل");
  assert.equal(n.facts[1].subjectKind, "term", "subjectKind مجهول لم يعد للافتراضي");
});

check("a confidence out of range drops only that fact", () => {
  const n = parseNote(
    reply({ facts: [{ subject: "x", key: "misc.a", claim: "أ", confidence: 1.5 }, { subject: "x", key: "misc.b", claim: "ب", confidence: 0.6 }] }),
    "s4",
  );
  assert.deepEqual(n.facts.map((f) => f.key), ["misc.b"]);
});

check("a missing title falls back to the summary instead of failing the note", () => {
  const n = parseNote(JSON.stringify({ summary: "أول جملة. ثانية.", facts: [] }), "s5");
  assert.equal(n.title, "أول جملة");
});

check("a decision handed back as a bare string is dropped, not fatal", () => {
  const n = parseNote(reply({ decisions: ["قرار بلا كائن", { what: "SQLite", why: "ملف واحد" }] }), "s6");
  assert.equal(n.decisions.length, 1);
  assert.equal(n.decisions[0].why, "ملف واحد");
});

check("a resume that is not an object is replaced, not fatal", () => {
  const n = parseNote(reply({ resume: "توقفنا هنا" }), "s7");
  assert.deepEqual(n.resume, { where: "", next: "", files: [], resumeCommand: null });
});

check("a reply with no JSON object in it is still an error", () => {
  assert.throws(() => parseNote("لا يوجد شيء هنا", "s8"), /JSON/);
});

// ---- which extractor wrote a note, as run.ts reads it back ---------------
// A local note may not overwrite a model note; the frontmatter is how the
// orchestrator tells them apart, so the round trip is pinned here.

check("noteExtractor reads back what renderSessionNote wrote", () => {
  const note = { title: "ت", project: "p", summary: "", did: [], decisions: [], rejected: [], open: [], facts: [], links: [] };
  const args = { note, sessionId: "claude-code:1", agent: "claude-code", sourceFile: "x.jsonl", startedAt: null, distilled: "0".repeat(64) };
  assert.equal(noteExtractor(renderSessionNote({ ...args, usedModel: true })), "model");
  assert.equal(noteExtractor(renderSessionNote({ ...args, usedModel: false })), "local");
  assert.equal(noteExtractor(renderSessionNote({ ...args, usedModel: true }).replace(/\n/g, "\r\n")), "model", "CRLF كسر القراءة");
  assert.equal(noteExtractor(""), null);
  assert.equal(noteExtractor("# ملف يدوي\nextractor: model في وسط سطر"), null, "طابق خارج الترويسة");
});

// ---- the memory the extractor is shown before it reads a session ----------
// Without it the model reports the problem a session discussed as if it were
// the current state; with it, "problem then fix" is a replacement.

check("factsContext lists every key under the heading, and the claim for forty of them", () => {
  assert.equal(factsContext([]), "", "قائمة فارغة أنتجت كتلة");

  const one = factsContext([{ subject: "p", key: "stack.db", claim: "SQLite" }]);
  assert.ok(one.includes("## ما تعرفه الذاكرة الآن"), "بلا عنوان");
  assert.ok(one.includes("- p.stack.db: SQLite"), "المفتاح أو الادعاء غائب");
  assert.match(one, /retract/, "لا تعليمة عن retract");
  assert.ok(one.includes("لا تنشئ مفتاحاً يشبه مفتاحاً حيّاً"), "لا تعليمة عن إعادة استخدام المفاتيح");
  // Sessions filed a fact memory held under a key of their own; the line sits
  // directly above the slots, word for word.
  const rows = one.split("\n");
  assert.equal(rows[rows.indexOf("- p.stack.db: SQLite") - 1], "هذه الخانات موجودة. إن كان ادعاؤك يخص إحداها، استخدم مفتاحها حرفياً ولا تشتق منه مفتاحاً جديداً.", "السطر ليس فوق الخانات مباشرة");
  assert.equal(SLOTS_LINE, "هذه الخانات موجودة. إن كان ادعاؤك يخص إحداها، استخدم مفتاحها حرفياً ولا تشتق منه مفتاحاً جديداً.");
  assert.ok(!factsContext([], "p").includes(SLOTS_LINE), "السطر بلا خانات");

  const many = Array.from({ length: 45 }, (_, i) => ({ subject: "p", key: `misc.k${i}`, claim: `ادعاء ${i}` }));
  const text = factsContext(many);
  const slots = text.split("\n").filter((l) => /^- p\./.test(l));
  assert.equal(slots.length, 45, "مفتاح غاب عن القائمة");
  assert.equal(slots.filter((l) => l.includes(": ادعاء")).length, 40, "لم يُحترم سقف الادعاءات");
  assert.ok(slots.includes("- p.misc.k44"), "مفتاح بلا ادعاء لم يُعرض وحده");
  assert.ok(!text.includes("غير معروضة"), "ما زال يُسقط خانات");
});

// The first 40 by subject and key was all a acme reading saw of 223: never a
// decision.* key, never a tooling one — the old key behind all five drifts.
check("the claims shown are the nearest to the session, by indexable() on both sides — and every other key is still listed", () => {
  const facts = Array.from({ length: 45 }, (_, i) => ({ subject: "acme", key: `arch.k${String(i).padStart(2, "0")}`, claim: `ادعاء عام رقم ${i}`, subject_kind: "project" }));
  facts.push({ subject: "acme", key: "decision.hosting", claim: "الاستضافة على Hetzner", subject_kind: "project" });
  facts.push({ subject: "tooling", key: "gotcha.git-diff-pathspec", claim: "git diff يعيد نتيجة فارغة مع pathspec", subject_kind: "tool" });
  const session = "جرّبنا git diff مع pathspec فأعاد فراغاً، وناقشنا استضافه الخادم";
  const text = factsContext(facts, "acme", 40, [], DEFINITIONS, session);
  assert.ok(text.includes("- tooling.gotcha.git-diff-pathspec: git diff"), "الأقرب بلا ادعائه");
  // «الاستضافة» in the claim, «استضافه» in the session: normalized and stripped alike.
  assert.ok(text.includes("- acme.decision.hosting: الاستضافة على Hetzner"), "التطبيع لم يُطبَّق على الطرفين");
  const rows = text.split("\n");
  for (const f of facts) assert.ok(rows.some((l) => l === `- ${f.subject}.${f.key}` || l.startsWith(`- ${f.subject}.${f.key}: `)), `غاب ${f.key}`);
  assert.equal(rows.filter((l) => /^- (acme|tooling)\.[^:]+: /.test(l)).length, 40);
  // Without the session, the two are past the first forty: their keys, alone.
  const blind = factsContext(facts, "acme", 40, [], DEFINITIONS).split("\n");
  assert.ok(blind.includes("- tooling.gotcha.git-diff-pathspec") && blind.includes("- acme.decision.hosting"), "بلا نص الجلسة تغيّر الترتيب");
});

// Without a word of which subjects exist, a session read against an empty
// memory named a subject after every file, class and audit item it touched.
check("factsContext names the project and every live subject, beyond the forty-fact cap, and says to reuse them", () => {
  const facts = [
    ...Array.from({ length: 45 }, (_, i) => ({ subject: "acme", key: `misc.k${i}`, claim: `ادعاء ${i}` })),
    { subject: "acme_server", key: "arch.queue", claim: "طابور" },
  ];
  const text = factsContext(facts, "acme");
  assert.ok(text.includes("المشروع: acme"), "اسم المشروع غائب");
  assert.ok(text.includes("المواضيع الحيّة: acme، acme_server"), "موضوع بعد السقف غاب من القائمة");
  assert.ok(text.includes("لا تنشئ موضوعاً جديداً إن كان القائم يفي"), "لا تعليمة إعادة الاستخدام");
  assert.ok(text.indexOf("المواضيع الحيّة") < text.indexOf("- acme.misc.k0"), "المواضيع جاءت بعد الحقائق");

  const empty = factsContext([], "acme");
  assert.ok(empty.includes("المشروع: acme"), "ذاكرة فارغة بلا اسم المشروع");
  assert.ok(!empty.includes("المواضيع الحيّة"), "قائمة مواضيع فارغة");
  assert.ok(!empty.includes("retract"), "تعليمات الحقائق بلا حقائق");
});

check("a live subject the guard would reject is shown nowhere — not offered, and none of its facts", () => {
  // Left in the vault by readings from before the definition. Shown, its
  // name was taught back to every later reading: acme_server grew so.
  const text = factsContext(
    [
      ...["acme", "lib/handlers.rb", "OrderDraft", "acme.constraint.eslint", "X9-42", "acme_server"].map((subject) => ({
        subject,
        key: "misc.x",
        claim: `ادعاء ${subject}`,
        subject_kind: "project",
      })),
      // A tool is a subject by the definition, PascalCase or folder-like or not — a path is not.
      { subject: "PowerShell", key: "gotcha.here-string", claim: "ادعاء", subject_kind: "tool" },
      { subject: "Docker", key: "gotcha.volumes", claim: "ادعاء", subject_kind: "tool" },
      { subject: "PowerShell/git stash", key: "gotcha.stash", claim: "ادعاء", subject_kind: "tool" },
    ],
    "acme",
    40,
    ["acme_server", "docker", "acme-client"],
    // Defined, so that only the guard decides here — see the next check.
    { PowerShell: "الصدفة نفسها", Docker: "الحاويات", "PowerShell/git stash": "مسار" },
  );
  assert.ok(text.includes("المواضيع الحيّة: acme، PowerShell، Docker\n"), text.split("\n").find((l) => l.startsWith("المواضيع")));
  for (const gone of ["lib/handlers.rb", "OrderDraft", "acme.constraint.eslint", "X9-42", "acme_server", "PowerShell/git stash"]) {
    assert.ok(!text.includes(gone), `عُرض على النموذج: ${gone}`);
  }
  assert.ok(text.includes("- acme.misc.x: ادعاء acme"), "حقيقة المشروع غابت");
});

// tooling was offered by name alone, and 4fb58e98 filed under it a gotcha
// about a script the session had written for the acme audit. A tool is
// offered with the line that says what it admits, or not at all.
check("a tool is offered only with the line that says what it admits — without one, neither its name nor its facts", () => {
  const facts = [
    { subject: "acme", key: "arch.x", claim: "ادعاء المشروع", subject_kind: "project" },
    { subject: "tooling", key: "gotcha.git-diff-pathspec", claim: "ادعاء الأداة", subject_kind: "tool" },
    { subject: "PowerShell", key: "gotcha.select-string", claim: "ادعاء الصدفة", subject_kind: "tool" },
    { subject: "video-ad-editor", key: "gotcha.font", claim: "ادعاء المحرّر", subject_kind: "tool" },
    { subject: "omar", key: "role", claim: "ادعاء الشخص", subject_kind: "person" },
  ];
  const text = factsContext(facts, "acme");
  assert.ok(text.includes("المواضيع الحيّة: acme، tooling، omar\n"), text.split("\n").find((l) => l.startsWith("المواضيع")));
  assert.ok(text.includes(`- tooling: ${DEFINITIONS.tooling}`), "tooling بلا سطر يعرّفه");
  assert.ok(text.includes("- tooling.gotcha.git-diff-pathspec: ادعاء الأداة"), "حقيقة الأداة المعرّفة غابت");
  // A definition may name a tool in passing; what must not appear is the
  // subject — the list of subjects is checked whole above.
  for (const gone of ["- PowerShell", "ادعاء الصدفة", "video-ad-editor", "ادعاء المحرّر"]) assert.ok(!text.includes(gone), `عُرض بلا تعريف: ${gone}`);
  // A person and a project need no line: the condition is on tools.
  assert.ok(text.includes("- omar.role: ادعاء الشخص") && text.includes("- acme.arch.x: ادعاء المشروع"));

  const defined = factsContext(facts, "acme", 40, [], { ...DEFINITIONS, PowerShell: "الصدفة نفسها وأوامرها", "video-ad-editor": "   " });
  assert.ok(defined.includes("- PowerShell: الصدفة نفسها وأوامرها") && defined.includes("- PowerShell.gotcha.select-string: ادعاء الصدفة"));
  assert.ok(!defined.includes("video-ad-editor"), "سطر فارغ عُدّ تعريفاً");
  assert.ok(defined.indexOf("- PowerShell: ") < defined.indexOf("- acme.arch.x"), "التعريف جاء بعد الحقائق");
});

// The first line went by who made the tool and named Laravel, so 476578b4
// filed a fact about acme's own files under tooling. The rule is where the
// gotcha shows up — replaced, not excepted: the maker is gone from the line
// and from the prompt.
check("tooling goes by where a gotcha shows up, not by who made the tool — with both examples, in the context and the prompt — and a vault adds its own lines", () => {
  for (const part of [
    "يظهر مع الأداة في أي مشروع",
    "في هذا المشروع وحده بسبب ملفاته أو قاعدته أو إعداده ← المشروع، ولو كانت الأداة خارجية",
    "«git diff -- path يفشل صامتاً» ← tooling",
    "«php artisan test يمسح acme_local لغياب .env.testing» ← acme",
  ]) {
    assert.ok(DEFINITIONS.tooling.includes(part), `تعريف tooling بلا: ${part}`);
  }
  assert.ok(SYSTEM.includes(DEFINITIONS.tooling), "البرومبت بلا تعريف tooling");
  for (const text of [DEFINITIONS.tooling, SYSTEM]) assert.ok(!/تكتبها الجلسة|كتبتها الجلسة|كتبته الجلسة/.test(text), "معيار الصنع ما زال قائماً");
  const cfg = ConfigSchema.parse({ vault: "/tmp/x", sources: {}, definitions: { PowerShell: "الصدفة" } });
  assert.deepEqual(definitionsFor(cfg), { tooling: DEFINITIONS.tooling, PowerShell: "الصدفة" });
  assert.equal(definitionsFor(ConfigSchema.parse({ vault: "/tmp/x", sources: {}, definitions: { tooling: "غيره" } })).tooling, "غيره");
  assert.throws(() => ConfigSchema.parse({ vault: "/tmp/x", sources: {}, definitions: { PowerShell: "  " } }), "تعريف فارغ قُبل في الإعداد");
});

check("a folder of the project is not a subject by name alone: without the folders, acme_server is offered", () => {
  const facts = [{ subject: "acme_server", key: "arch.x", claim: "ادعاء", subject_kind: "project" }];
  assert.ok(factsContext(facts, "acme").includes("المواضيع الحيّة: acme_server"));
  assert.ok(!factsContext(facts, "acme", 40, ["acme_server"]).includes("acme_server"));
  // Spelled another way than the folder, it is the folder all the same.
  assert.ok(!factsContext([{ ...facts[0], subject: "acme_client" }], "acme", 40, ["acme-client"]).includes("acme_client"));
});

await (async () => {
  let sent = "";
  const runner = async (_name, input) => {
    sent = input;
    return { text: JSON.stringify({ title: "ت", facts: [] }), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, model: "x" } };
  };
  const cfg = ConfigSchema.parse({ vault: "/tmp/x", sources: {}, extractor: { provider: "cli", cliOrder: ["claude"] } });
  const session = { id: "claude-code:1", agent: "claude-code", sourceFile: "x.jsonl", cwd: "D:/p", startedAt: null, endedAt: "2026-09-15T00:00:00.000Z", turns: [], contentHash: "1:1", files: [] };
  const distilled = { text: "…", userChars: 400, turnCount: 1, toolNames: [], truncated: false };

  await check("the context reaches the provider ahead of the transcript", async () => {
    await extractNote({
      session,
      distilled,
      redactedText: "نص الجلسة الحقيقي",
      cfg,
      useModel: true,
      sameProvider: true,
      context: factsContext([{ subject: "p", key: "arch.lock", claim: "لا يوجد قفل" }]),
      runner,
    });
    assert.ok(sent.includes("- p.arch.lock: لا يوجد قفل"), "السياق لم يصل للمزوّد");
    assert.ok(sent.includes("نص الجلسة الحقيقي"), "نص الجلسة ضاع");
    assert.ok(sent.indexOf("arch.lock") < sent.indexOf("نص الجلسة الحقيقي"), "السياق جاء بعد النص");
  });

  await check("no context means the transcript is sent exactly as it was redacted", async () => {
    await extractNote({ session, distilled, redactedText: "نص وحده", cfg, useModel: true, sameProvider: true, runner });
    assert.equal(sent, "نص وحده", "أُضيف شيء إلى نص بلا سياق");
  });

  // 3 of the first full scan's 173 calls, and 2952933d on 2026-09-23: the
  // reply broke off mid-JSON, and the same call again answered whole.
  const u = (n) => ({ inputTokens: n, outputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0, model: "x", costUsd: n / 100 });
  const whole = JSON.stringify({ title: "كاملة", facts: [] });
  const replying = (...texts) => {
    const r = async () => ({ text: texts[Math.min(r.calls++, texts.length - 1)], usage: u(1) });
    r.calls = 0;
    return r;
  };
  const quietly = async (fn) => {
    const said = [];
    const write = process.stderr.write;
    process.stderr.write = (s) => (said.push(String(s)), true);
    try {
      return { r: await fn(), said: said.join("") };
    } finally {
      process.stderr.write = write;
    }
  };

  await check("a reply cut off mid-JSON is asked for once more, said on stderr, and both calls are counted", async () => {
    const runner = replying(whole.slice(0, 20), whole);
    const { r, said } = await quietly(() => extractNote({ session, distilled, redactedText: "n", cfg, useModel: true, sameProvider: true, runner }));
    assert.equal(runner.calls, 2);
    assert.equal(r.usedModel, true);
    assert.equal(r.pending, undefined);
    assert.equal(r.note.title, "كاملة");
    assert.equal(r.calls, 2);
    assert.equal(r.usage.inputTokens, 2, "لم تُحسب رموز النداء الأول");
    assert.equal(r.usage.costUsd, 0.02, "لم تُحسب تكلفة النداء الأول");
    assert.ok(said.includes("JSON غير مكتمل في الرد — أُعيد النداء مرة واحدة"), said);
  });

  await check("a garbled reply is asked for again too; twice garbled, the session waits as before — asked only twice", async () => {
    const garbled = '{"title": "ت", "facts": [,]}';
    const again = replying(garbled, whole);
    assert.equal((await quietly(() => extractNote({ session, distilled, redactedText: "n", cfg, useModel: true, sameProvider: true, runner: again }))).r.note.title, "كاملة");
    const runner = replying(whole.slice(0, 20));
    const { r } = await quietly(() => extractNote({ session, distilled, redactedText: "n", cfg, useModel: true, sameProvider: true, runner }));
    assert.equal(runner.calls, 2, "أُعيد النداء أكثر من مرة");
    assert.match(r.pending ?? "", /JSON غير مكتمل في الرد مرتين/);
    assert.deepEqual(r.garbled, [whole.slice(0, 20), whole.slice(0, 20)], "لم يُحمل الردّان للحفظ");
  });

  await check("a reply with no JSON at all is not asked again", async () => {
    const runner = replying("لا أستطيع المساعدة في هذا.", whole);
    const { r } = await quietly(() => extractNote({ session, distilled, redactedText: "n", cfg, useModel: true, sameProvider: true, runner }));
    assert.equal(runner.calls, 1);
    assert.ok(r.pending);
  });

  await check("a reply naming a retraction carries it through to the note", async () => {
    const withRetract = async () => ({
      text: JSON.stringify({ title: "ت", facts: [], retract: [{ subject: "p", key: "arch.lock", reason: "بُني القفل" }, { key: "بلا موضوع" }] }),
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, model: "x" },
    });
    const r = await extractNote({ session, distilled, redactedText: "n", cfg, useModel: true, sameProvider: true, runner: withRetract });
    assert.equal(r.note.retract.length, 1, "العنصر التالف لم يُسقط وحده");
    assert.deepEqual(r.note.retract[0], { subject: "p", key: "arch.lock", reason: "بُني القفل" });
  });
})();

// ---- the call itself --------------------------------------------------------

await check("no extraction call becomes a session on disk: --no-session-persistence, --ephemeral", async () => {
  const { cliCall } = await import("../test-build/pipeline/extract.js");
  const cfg = ConfigSchema.parse({ vault: "v", sources: {} });
  // Without these each call left a transcript the next scan would find, and
  // Codex's also a thread in the app's list — six on 2026-09-26.
  assert.ok(cliCall("claude", "n", cfg).args.includes("--no-session-persistence"));
  const codex = cliCall("codex", "n", cfg);
  assert.equal(codex.args[0], "exec");
  assert.ok(codex.args.includes("--ephemeral"), "نداء codex يترك جلسة على القرص");
  assert.ok(codex.args.includes("--json"), "بلا --json لا رموز من codex");
  assert.ok(codex.stdin.startsWith(SYSTEM), "برومبت النظام ليس أول المدخل");
});

await check("codex --json: the reply is the agent's message, and its tokens are counted — cached apart", async () => {
  const { parseCliOutput } = await import("../test-build/pipeline/extract.js");
  // The four lines 0.157.1 printed for one call on 2026-09-26.
  const out = [
    '{"type":"thread.started","thread_id":"01a0ddc2-1cd0-7313-8e4d-19901aaf345f"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"ok\\": true}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":18196,"cached_input_tokens":8192,"cache_write_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":0}}',
  ].join("\n");
  const r = parseCliOutput("codex", out, "codex");
  assert.equal(r.text, '{"ok": true}');
  assert.equal(r.usage.inputTokens, 10004, "المخزّن حُسب مرتين");
  assert.equal(r.usage.cacheReadTokens, 8192);
  assert.equal(r.usage.outputTokens, 9);
  assert.equal(r.usage.costUsd, undefined, "سعر مخترع");
});

await check("codex: a failed turn is a failure, and bare text from an older CLI is still read", async () => {
  const { parseCliOutput } = await import("../test-build/pipeline/extract.js");
  const failed = ['{"type":"thread.started","thread_id":"x"}', '{"type":"turn.failed","error":{"message":"usage limit reached"}}'].join("\n");
  assert.throws(() => parseCliOutput("codex", failed, "codex"), /turn\.failed: usage limit reached/);
  const bare = parseCliOutput("codex", '{"title": "ت", "facts": []}', "codex");
  assert.equal(bare.text, '{"title": "ت", "facts": []}');
  assert.equal(bare.usage.inputTokens, 0);
});

process.stdout.write(`\nextract: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
