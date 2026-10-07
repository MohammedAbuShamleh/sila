import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_INTERVAL, TASK_NAME, conhostPath, posixInstructions, scanArgs, taskXml, taskXmlBytes } from "../test-build/serve/schedule.js";

/**
 * The scheduled scan, checked as text rather than by registering anything:
 * the task definition is what Task Scheduler reads, and the two ways it
 * silently fails — UTF-8 bytes, and an unquoted path with a space in it —
 * are both invisible until the day it does not run.
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

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const CLI = "C:\\Users\\x\\memory-engine\\dist\\cli.js";
const VAULT = "C:\\Users\\x\\.memory";

check("the scheduled command names the vault and detaches so it can log", () => {
  const args = scanArgs(CLI, VAULT);
  assert.deepEqual(args, [CLI, "scan", "--vault", VAULT, "--detach"]);
});

check("the task runs at logon, repeats on the interval, and is hidden", () => {
  const xml = taskXml(NODE, CLI, VAULT);
  assert.ok(xml.includes("<LogonTrigger>"), "لا مشغّل عند تسجيل الدخول");
  assert.ok(xml.includes(`<Interval>PT${DEFAULT_INTERVAL}M</Interval>`), "لا تكرار كل 15 دقيقة");
  assert.ok(xml.includes("<Hidden>true</Hidden>"), "ليست مخفية");
  assert.ok(xml.includes("<MultipleInstancesPolicy>IgnoreNew"), "قد تبدأ نسخة ثانية فوق الأولى");
  assert.ok(xml.includes(`&quot;${NODE}&quot;`), "node بمسار غير مطلق");
  assert.equal(taskXml(NODE, CLI, VAULT, 5).includes("<Interval>PT5M</Interval>"), true, "--interval غير محترم");
});

check("the logon trigger names its user — without it, only an administrator may register the task", () => {
  const xml = taskXml(NODE, CLI, VAULT);
  const trigger = /<LogonTrigger>([\s\S]*?)<\/LogonTrigger>/.exec(xml)?.[1] ?? "";
  const user = os.userInfo().username;
  assert.ok(trigger.includes(`<UserId>`), "مشغّل الدخول بلا UserId — يعني أي مستخدم ويُرفض بلا صلاحية مدير");
  assert.ok(trigger.includes(user.replace(/&/g, "&amp;").replace(/</g, "&lt;")), "UserId ليس المستخدم الحالي");
});

check("a time trigger starts the cycle one interval after install, so it runs before the next logon", () => {
  const start = new Date(2026, 8, 17, 9, 5, 7);
  const xml = taskXml(NODE, CLI, VAULT, 15, start);
  const trigger = /<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/.exec(xml)?.[1] ?? "";
  assert.ok(trigger, "لا مشغّل زمني — التكرار ينتظر تسجيل الدخول القادم");
  assert.ok(trigger.includes("<StartBoundary>2026-09-17T09:05:07</StartBoundary>"), `StartBoundary خاطئ: ${trigger}`);
  assert.ok(trigger.includes("<Interval>PT15M</Interval>"), "المشغّل الزمني بلا تكرار");
  assert.ok(trigger.includes("<StopAtDurationEnd>false</StopAtDurationEnd>") && !trigger.includes("<Duration>"), "للتكرار مدة تنتهي");

  const soon = /<StartBoundary>([^<]+)<\/StartBoundary>/.exec(taskXml(NODE, CLI, VAULT, 15))?.[1] ?? "";
  const delta = new Date(soon).getTime() - Date.now();
  assert.ok(delta > 14 * 60_000 && delta <= 15 * 60_000 + 2000, `البداية الافتراضية ليست بعد فترة واحدة: ${soon}`);
});

check("every path holding a space is quoted inside Arguments, and only those", () => {
  const vaultSpaced = "D:\\My Vault\\.memory";
  const cliSpaced = "C:\\My Tools\\memory-engine\\dist\\cli.js";
  const args = /<Arguments>(.*)<\/Arguments>/.exec(taskXml(NODE, cliSpaced, vaultSpaced))[1];
  assert.ok(args.includes(`&quot;${vaultSpaced}&quot;`), `مسار المخزن فيه مسافة بلا اقتباس: ${args}`);
  assert.ok(args.includes(`&quot;${cliSpaced}&quot;`), "مسار cli.js فيه مسافة بلا اقتباس");

  const plain = /<Arguments>(.*)<\/Arguments>/.exec(taskXml(NODE, CLI, VAULT))[1];
  assert.equal(plain, `--headless &quot;${NODE}&quot; ${CLI} scan --vault ${VAULT} --detach`, "اقتُبس ما لا يحتاج اقتباساً");
  assert.ok(!plain.includes("<"), "الوسائط غير مهروبة XML");
});

// Hidden hides the task from the list, not its window: node started by the
// scheduler opened a Windows Terminal window on 2026-09-24, every cycle.
check("the scheduler starts node inside a headless console host — Hidden hides no window", () => {
  const xml = taskXml(NODE, CLI, VAULT);
  const command = /<Command>(.*)<\/Command>/.exec(xml)?.[1] ?? "";
  assert.equal(command, conhostPath(), `الأمر ليس conhost: ${command}`);
  assert.ok(/\\System32\\conhost\.exe$/i.test(command), "conhost بمسار غير مطلق");
  const args = /<Arguments>(.*)<\/Arguments>/.exec(xml)?.[1] ?? "";
  assert.ok(args.startsWith(`--headless &quot;${NODE}&quot; ${CLI} scan`), `لا --headless قبل node: ${args}`);
});

check("a name with an XML character cannot break the document", () => {
  const xml = taskXml(NODE, "C:\\a&b\\cli.js", VAULT);
  assert.ok(xml.includes("a&amp;b"), "& لم يُهرَّب");
  assert.ok(!/&(?!amp;|quot;|lt;|gt;|apos;)/.test(xml), "بقي & غير مهروب");
});

check("the bytes are UTF-16LE with a BOM, which is all Task Scheduler accepts", () => {
  const bytes = taskXmlBytes(taskXml(NODE, CLI, VAULT));
  assert.equal(bytes[0], 0xff, "لا BOM");
  assert.equal(bytes[1], 0xfe, "BOM ليس little-endian");
  assert.equal(bytes.slice(2).toString("utf16le").startsWith("<?xml"), true, "المحتوى ليس UTF-16LE");
});

check("the posix path prints launchd and cron and installs nothing", () => {
  const text = posixInstructions("/usr/bin/node", "/home/x/mem/dist/cli.js", "/home/x/.memory");
  assert.ok(text.includes("com.sila-memory.scan"), "لا تسمية launchd");
  assert.ok(text.includes(`<integer>${DEFAULT_INTERVAL * 60}</integer>`), "StartInterval بالثواني خاطئ");
  assert.ok(text.includes(`*/${DEFAULT_INTERVAL} * * * *`), "لا سطر cron");
  assert.ok(text.includes("لن أكتب"), "لا يقول إنه لا يثبّت تلقائياً");
});

check("the task name is one constant, used by install, uninstall and status alike", () => {
  assert.equal(TASK_NAME, "memory-engine scan");
  assert.ok(taskXml(NODE, CLI, VAULT).includes(TASK_NAME), "الاسم غير مكتوب في التعريف");
});

// dist is what the scheduled task and the hook run against the real vault. A
// test that read it made every build a deploy, and every guard broken to
// prove a test fails was live on the vault until it was put back — on
// 2026-10-01 nothing but a review afterwards showed no scan had met one.
check("no test reads what the scheduled task runs: npm test builds into test-build, and a guard broken there reaches no vault", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
    assert.ok(!fs.readFileSync(path.join(dir, f), "utf8").includes("../" + "dist/"), `${f} يقرأ dist`);
  }
  const test = JSON.parse(fs.readFileSync(path.join(dir, "..", "package.json"), "utf8")).scripts.test;
  assert.match(test, /^tsc --outDir test-build && /, "npm test لا يبني إلى test-build");
  assert.ok(!test.includes("npm run build"), "npm test يبني dist");
});

// What npm would publish, asked of npm itself. CLAUDE.md, src and test hold
// names from the user's projects and sessions, and a source map carries the
// path it was built at — on 2026-10-06 one built outside the repository ran
// through the user's home directory. A dist built with maps still ships none.
check("npm pack publishes dist without source maps, the two READMEs and LICENSE — nothing else; the publish build makes no maps", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  const allowed = new Set(["package.json", "README.md", "README.en.md", "LICENSE"]);
  for (const f of files) assert.ok(allowed.has(f) || (f.startsWith("dist/") && !f.endsWith(".map")), `يُنشر: ${f}`);
  assert.ok(files.includes("LICENSE") && files.includes("README.md"), files.join(" "));
  const publish = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.publish.json"), "utf8"));
  assert.equal(publish.compilerOptions.sourceMap, false, "بناء النشر يكتب خرائط");
  assert.match(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts["build:publish"], /-p tsconfig\.publish\.json/);
});

process.stdout.write(`\nschedule: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
