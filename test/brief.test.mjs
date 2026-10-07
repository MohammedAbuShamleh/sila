import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../test-build/store/db.js";
import { buildBrief } from "../test-build/serve/brief.js";
import { renderSessionNote, retractInNote, selectResumeFiles } from "../test-build/store/vault.js";

/**
 * What the brief and the resume block choose to show. Both are read at the
 * start of every later session, so what they leave out matters as much as
 * what they keep.
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

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mem-brief-"));
const store = new Store(vault);

const session = (id, startedAt) => ({
  id,
  agent: "claude-code",
  source_file: `${id}.jsonl`,
  content_hash: "1:1",
  cwd: null,
  project: "p",
  started_at: startedAt,
  processed_at: startedAt,
  status: "ok",
  note_path: null,
});
const pending = (sessionId, key, claim, createdAt) =>
  store.addPending({ subject: "p", subject_kind: "project", key, claim, confidence: 0.6, reason: "below-confidence-floor", session_id: sessionId, created_at: createdAt });

// ---- pending: the latest session only ---------------------------------------

check("the brief's pending section comes from the latest session only", () => {
  store.upsertSession(session("claude-code:old", "2026-09-01T00:00:00.000Z"));
  store.upsertSession(session("claude-code:new", "2026-09-10T00:00:00.000Z"));
  pending("claude-code:old", "stack.db", "ادعاء قديم من جلسة سابقة", "2026-09-01T00:00:00.000Z");
  pending("claude-code:new", "deploy.host", "ادعاء من آخر جلسة", "2026-09-10T00:00:00.000Z");
  const brief = buildBrief(store, vault, "p");
  assert.ok(brief.includes("ادعاء من آخر جلسة"), "معلّق آخر جلسة غائب");
  assert.ok(!brief.includes("ادعاء قديم"), "معلّق جلسة سابقة ظهر");
  assert.ok(brief.includes("## معلّق"), "لا قسم معلّق");
});

check("no pending in the latest session means no section, even if older sessions have some", () => {
  store.upsertSession(session("claude-code:newest", "2026-09-12T00:00:00.000Z"));
  const brief = buildBrief(store, vault, "p");
  assert.ok(!brief.includes("## معلّق"), "قسم معلّق لجلسة بلا معلّق");
});

// ---- the resume command: offered only while it can work ---------------------

check("the resume block offers its command only while the transcript it reopens is there — the rest of it stays", () => {
  const transcript = path.join(vault, "q1.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  const resume = { where: "توقفنا عند الاختبار", next: "شغّل الحزمة", files: ["C:\\code\\q\\a.ts"], resumeCommand: `cd "${vault}" && claude --resume q1` };
  store.upsertSession({ ...session("claude-code:q1", "2026-09-20T00:00:00.000Z"), project: "q", source_file: transcript, resume_json: JSON.stringify(resume) });
  assert.ok(buildBrief(store, vault, "q").includes("claude --resume q1"), "الأمر غائب ونصّه موجود");
  fs.rmSync(transcript);
  const brief = buildBrief(store, vault, "q");
  assert.ok(!brief.includes("claude --resume"), "عُرض أمر لا يعمل");
  for (const kept of ["توقفنا عند الاختبار", "شغّل الحزمة", "a.ts"]) assert.ok(brief.includes(kept), `ذهب مع الأمر: ${kept}`);
});

check("the resume block offers no command whose folder has gone, its transcript still there — the rest of it stays", () => {
  const transcript = path.join(vault, "q2.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  const folder = path.join(vault, "q2-project");
  fs.mkdirSync(folder);
  const resume = { where: "توقفنا عند الترحيل", next: "راجع الجدول", files: [], resumeCommand: `cd "${folder}" && claude --resume q2` };
  store.upsertSession({ ...session("claude-code:q2", "2026-09-21T00:00:00.000Z"), project: "q", source_file: transcript, resume_json: JSON.stringify(resume) });
  assert.ok(buildBrief(store, vault, "q").includes("claude --resume q2"), "الأمر غائب ومجلده موجود");
  fs.rmSync(folder, { recursive: true });
  const brief = buildBrief(store, vault, "q");
  assert.ok(!brief.includes("claude --resume q2"), "عُرض أمر يدخل مجلداً ذهب");
  for (const kept of ["توقفنا عند الترحيل", "راجع الجدول"]) assert.ok(brief.includes(kept), `ذهب مع الأمر: ${kept}`);
});

check("the freshness stamp names node and this CLI by full path, with the brief's vault — never a bare mem or sila", () => {
  const line = buildBrief(store, vault, "q").split("\n")[0];
  const command = /`([^`]+)`/.exec(line)?.[1] ?? "";
  assert.ok(!/^(mem|sila)\b/.test(command), `الختم يطلب ${command}`);
  const [node, cli, ...rest] = [...command.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  assert.equal(node, process.execPath);
  assert.ok(path.isAbsolute(cli) && fs.existsSync(cli) && cli.endsWith("cli.js"), `لا CLI في ${cli}`);
  assert.deepEqual(rest, ["scan", "--vault", path.resolve(vault)]);
});

// ---- resume files: what is worth reopening ----------------------------------

check("scratch, temp and memory paths are dropped from resume files", () => {
  const files = [
    "C:\\code\\app\\src\\index.ts",
    "C:\\Users\\x\\AppData\\Local\\Temp\\claude\\proj\\abc\\scratchpad\\out.html",
    "/tmp/mem-test-123/vault/x.md",
    "C:\\Users\\x\\.claude\\projects\\C--code-app\\memory\\notes.md",
    "C:\\Users\\x\\.claude\\projects\\C--code-app\\memory\\MEMORY.md",
    "C:\\code\\app\\README.md",
  ];
  assert.deepEqual(selectResumeFiles(files, () => 0), ["C:\\code\\app\\src\\index.ts", "C:\\code\\app\\README.md"]);
});

check("up to fifteen files keep their first-seen order; beyond that the most recently modified win", () => {
  const few = Array.from({ length: 15 }, (_, i) => `C:\\code\\f${i}.ts`);
  assert.deepEqual(selectResumeFiles(few, (f) => 100 - Number(f.match(/\d+/)[0])), few, "أُعيد ترتيب ما دون الحد");

  const many = Array.from({ length: 20 }, (_, i) => `C:\\code\\f${i}.ts`);
  const out = selectResumeFiles(many, (f) => Number(f.match(/\d+/)[0]));
  assert.equal(out.length, 15, "لم يُقتطع إلى 15");
  assert.equal(out[0], "C:\\code\\f19.ts", "الأحدث تعديلاً ليس أولاً");
  assert.equal(out[14], "C:\\code\\f5.ts");
});

check("a file that no longer exists sorts last when the list is cut", () => {
  const many = Array.from({ length: 16 }, (_, i) => `C:\\code\\f${i}.ts`);
  const out = selectResumeFiles(many, (f) => (f.endsWith("f0.ts") ? 0 : 1));
  assert.ok(!out.includes("C:\\code\\f0.ts"), "الملف الغائب بقي على حساب موجود");
});

// ---- retracting a claim out of the note that made it ------------------------
// The database alone is not enough: reindex replays the trailer, so a claim
// struck only in SQLite comes back live. It has to leave the Markdown.

check("retractInNote moves the claim to سُحب, keeps the prose, and is idempotent", () => {
  const note = {
    title: "عنوان الجلسة",
    project: "p",
    summary: "ملخص.",
    did: ["عملنا شيئاً"],
    decisions: [{ what: "قرار", why: "سبب" }],
    rejected: [],
    open: ["سؤال معلّق"],
    facts: [
      { subject: "p", subjectKind: "project", key: "arch.lock", claim: "لا يوجد قفل على المسح", confidence: 0.85 },
      { subject: "p", subjectKind: "project", key: "stack.db", claim: "القاعدة SQLite", confidence: 0.85 },
    ],
    links: [],
    resume: { where: "هنا", next: "التالي", files: [], resumeCommand: null },
  };
  const file = path.join(vault, "note.md");
  fs.writeFileSync(
    file,
    renderSessionNote({ note, sessionId: "claude-code:n1", agent: "claude-code", sourceFile: "n1.jsonl", startedAt: "2026-09-01T00:00:00.000Z", usedModel: true, distilled: "0".repeat(64) }),
  );

  const gone = retractInNote(file, "p", "arch.lock", "2026-09-20T00:00:00.000Z", "حُلّت في eb6e8c7");
  assert.equal(gone.key, "arch.lock");
  assert.equal(gone.reason, "حُلّت في eb6e8c7");
  assert.equal(gone.createdAt, "2026-09-01T00:00:00.000Z", "تاريخ التعلّم من الساعة لا من الملاحظة");

  const md = fs.readFileSync(file, "utf8");
  assert.ok(md.includes("## عملنا"), "ضاعت prose الملاحظة");
  assert.ok(md.includes("سؤال معلّق"), "ضاع قسم معلّق");
  assert.ok(md.includes("## سُحب"), "لا قسم سُحب");
  assert.ok(md.includes("حُلّت في eb6e8c7"), "السبب غير مكتوب في الملاحظة");

  const trailer = JSON.parse(md.slice(md.indexOf("<!-- engine:facts") + 17, md.lastIndexOf("-->")).trim());
  assert.deepEqual(trailer.facts.map((f) => f.key), ["stack.db"], "الحقيقة الأخرى تأثرت");
  assert.equal(trailer.retracted.length, 1);
  assert.equal(trailer.retracted[0].reason, "حُلّت في eb6e8c7");
  assert.ok(trailer.resume, "ضاع الاستئناف من الذيل");

  assert.equal(retractInNote(file, "p", "arch.lock", "2026-09-21T00:00:00.000Z", "مرة ثانية"), null, "سُحب مرتين");
  assert.equal(retractInNote(file, "p", "لا-وجود-له", "2026-09-21T00:00:00.000Z", "س"), null);
});

store.close();
fs.rmSync(vault, { recursive: true, force: true });

process.stdout.write(`\nbrief: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
