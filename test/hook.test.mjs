import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_MARK, hookStatus, installHook, npxInstall, transcriptFromHookPayload, uninstallHook } from "../test-build/serve/hook.js";
import { ConfigSchema, agentForSourceFile } from "../test-build/config.js";
import { LockHeldError, acquireLock } from "../test-build/util/lock.js";
import { syncProjects } from "../test-build/pipeline/run.js";
import { briefPath } from "../test-build/serve/brief.js";
import { writeFileAtomic } from "../test-build/util/fsatomic.js";

/**
 * Three things make an automatic scan safe to leave running: the hook entry
 * that starts it is written without disturbing anything else in the user's
 * settings, two scans cannot run at once, and the brief lands in the project
 * folders without a hand. Each is pinned here against a temp directory —
 * never against the real ~/.claude/settings.json.
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mem-hook-"));
const settings = path.join(base, "settings.json");
const read = () => JSON.parse(fs.readFileSync(settings, "utf8"));

// ---- hook install / uninstall ---------------------------------------------

check("install into a missing settings file creates exactly our SessionEnd entry", () => {
  const r = installHook(settings, "C:/node.exe", "C:/mem/dist/cli.js");
  assert.equal(r.changed, true);
  const s = read();
  assert.equal(s.hooks.SessionEnd.length, 1);
  const h = s.hooks.SessionEnd[0].hooks[0];
  assert.equal(h.type, "command");
  assert.equal(h.command, "C:/node.exe");
  assert.deepEqual(h.args, ["C:/mem/dist/cli.js", "scan", "--agent", "claude-code", "--limit", "1", "--from-hook", "--detach"]);
  assert.equal(h.statusMessage, HOOK_MARK);
  assert.ok(h.timeout > 0, "بلا مهلة");
});

check("installing again changes nothing and never duplicates", () => {
  const r = installHook(settings, "C:/node.exe", "C:/mem/dist/cli.js");
  assert.equal(r.changed, false);
  assert.equal(read().hooks.SessionEnd.length, 1);
});

check("a moved cli path replaces our entry in place", () => {
  installHook(settings, "C:/node.exe", "D:/elsewhere/cli.js");
  const list = read().hooks.SessionEnd;
  assert.equal(list.length, 1, "تكرّر البند بدل استبداله");
  assert.equal(list[0].hooks[0].args[0], "D:/elsewhere/cli.js");
});

// npx runs the package from npm's cache, and the hook names this file by
// absolute path — a path npm empties when it cleans the cache.
check("install refuses to run from npx's cache, and says why; any other place installs", () => {
  for (const p of [
    "C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\3f9a1c\\node_modules\\sila-memory\\dist\\cli.js",
    "/home/x/.npm/_npx/3f9a1c/node_modules/sila-memory/dist/cli.js",
  ]) {
    const why = npxInstall(p);
    assert.ok(why && why.includes(p) && why.includes("npm install -g sila-memory") && why.includes("sila hook install"), `قُبل: ${p}`);
    assert.ok(npxInstall(p, "schedule")?.includes("sila schedule install"), `قُبلت المهمة: ${p}`);
  }
  for (const p of [
    "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\sila-memory\\dist\\cli.js",
    "/usr/local/lib/node_modules/sila-memory/dist/cli.js",
    "C:\\Users\\x\\code\\sila\\dist\\cli.js",
    "/home/x/my_npx_tools/sila/dist/cli.js",
  ]) {
    assert.equal(npxInstall(p), null, `رُفض: ${p}`);
  }
});

check("the CLI run from a _npx path refuses hook and schedule install with exit 1 and writes nothing; the same files by their real path install", () => {
  // npx's cache, in shape: the package under <cache>/_npx/<hash>/node_modules,
  // here a junction to this repository so its dependencies resolve.
  const link = path.join(base, "npm-cache", "_npx", "3f9a1c", "node_modules", "sila-memory");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.resolve(fileURLToPath(new URL("..", import.meta.url))), link, "junction");
  const target = path.join(base, "npx-settings.json");
  try {
    let code = 0;
    let err = "";
    try {
      execFileSync(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", path.join(link, "test-build", "cli.js"), "hook", "install", "--file", target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      code = e.status;
      err = String(e.stderr);
    }
    assert.equal(code, 1, "خرج بصفر");
    assert.ok(err.includes("_npx") && err.includes("npm install -g sila-memory"), err);
    assert.ok(!fs.existsSync(target), "كُتب settings.json من ذاكرة npx");
    // The scheduled task carries the same path. --file writes the definition
    // and registers nothing, so no real Task Scheduler is touched.
    const xml = path.join(base, "npx-task.xml");
    let taskCode = 0;
    try {
      execFileSync(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", path.join(link, "test-build", "cli.js"), "schedule", "install", "--file", xml], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      taskCode = e.status;
    }
    assert.equal(taskCode, 1, "المهمة من ذاكرة npx خرجت بصفر");
    assert.ok(!fs.existsSync(xml), "كُتب تعريف المهمة من ذاكرة npx");
    // Without --preserve-symlinks node runs the real path: the repository.
    execFileSync(process.execPath, [path.join(link, "test-build", "cli.js"), "hook", "install", "--file", target], { encoding: "utf8" });
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).hooks.SessionEnd.length, 1);
  } finally {
    // The link alone, never what it points at.
    fs.rmdirSync(link);
  }
});

check("everything else in the file survives install and uninstall", () => {
  fs.writeFileSync(
    settings,
    JSON.stringify({
      theme: "dark",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }], SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }] },
    }),
  );
  installHook(settings, "C:/node.exe", "C:/mem/dist/cli.js");
  let s = read();
  assert.equal(s.theme, "dark", "ضاع مفتاح آخر");
  assert.equal(s.hooks.Stop[0].hooks[0].command, "echo done", "ضاع hook آخر");
  assert.equal(s.hooks.SessionEnd.length, 2, "أُزيل hook SessionEnd ليس لنا");
  assert.ok(hookStatus(settings), "status لا يرى البند");

  assert.equal(uninstallHook(settings), true);
  s = read();
  assert.equal(s.hooks.SessionEnd.length, 1, "أُزيل ما ليس لنا");
  assert.equal(s.hooks.SessionEnd[0].hooks[0].command, "echo bye");
  assert.equal(s.hooks.Stop[0].hooks[0].command, "echo done");
  assert.equal(hookStatus(settings), null);
  assert.equal(uninstallHook(settings), false, "أبلغ عن إزالة ثانية");
});

check("uninstall leaves no empty husks behind", () => {
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark" }));
  installHook(settings, "C:/node.exe", "C:/mem/dist/cli.js");
  uninstallHook(settings);
  assert.deepEqual(read(), { theme: "dark" });
});

check("a settings file that is not valid JSON is refused, not overwritten", () => {
  fs.writeFileSync(settings, "{ not json");
  assert.throws(() => installHook(settings, "C:/node.exe", "C:/mem/dist/cli.js"), /JSON/);
  assert.equal(fs.readFileSync(settings, "utf8"), "{ not json", "كُتب فوق ملف معطوب");
});

// ---- the transcript the hook names ----------------------------------------

check("the SessionEnd payload names the transcript; anything else falls back to null", () => {
  const payload = { session_id: "abc", transcript_path: "C:/Users/x/.claude/projects/p/abc.jsonl", cwd: "C:/p", hook_event_name: "SessionEnd", reason: "exit" };
  assert.equal(transcriptFromHookPayload(JSON.stringify(payload)), "C:/Users/x/.claude/projects/p/abc.jsonl");
  assert.equal(transcriptFromHookPayload(JSON.stringify({ session_id: "abc" })), null, "بلا مسار لم يُرجع null");
  assert.equal(transcriptFromHookPayload(""), null, "stdin فارغ لم يُرجع null");
  assert.equal(transcriptFromHookPayload("{ not json"), null);
  assert.equal(transcriptFromHookPayload("null"), null);
});

check("a transcript's agent is read off which source root holds it", () => {
  const cfg = ConfigSchema.parse({ vault: base, sources: { claudeCode: path.join(base, "cc"), codex: path.join(base, "cx") } });
  assert.equal(agentForSourceFile(cfg, path.join(base, "cc", "proj", "s.jsonl")), "claude-code");
  assert.equal(agentForSourceFile(cfg, path.join(base, "cx", "2026", "r.jsonl")), "codex");
  assert.equal(agentForSourceFile(cfg, path.join(base, "elsewhere", "s.jsonl")), null, "ملف خارج المصادر خُمّن له وكيل");
  assert.equal(agentForSourceFile(cfg, path.join(base, "ccx", "s.jsonl")), null, "بادئة مشتركة عُدّت احتواءً");
  if (process.platform === "win32") {
    const other = path.join(base, "cc", "proj", "s.jsonl").replace(/\\/g, "/").toUpperCase();
    assert.equal(agentForSourceFile(cfg, other), "claude-code", "اختلاف الشرطات وحالة الأحرف كسر المطابقة");
  }
});

// ---- the scan lock ---------------------------------------------------------

const vault = path.join(base, "vault");

check("a second scan on the same vault is refused while the first holds the lock", () => {
  const release = acquireLock(vault);
  assert.throws(() => acquireLock(vault), LockHeldError);
  release();
  const again = acquireLock(vault);
  again();
});

check("a lock left by a dead process is taken over", () => {
  fs.writeFileSync(
    path.join(vault, ".index", "scan.lock"),
    JSON.stringify({ pid: 2147483646, at: "2020-01-01T00:00:00.000Z" }),
  );
  const release = acquireLock(vault);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vault, ".index", "scan.lock"), "utf8")).pid, process.pid);
  release();
  assert.equal(fs.existsSync(path.join(vault, ".index", "scan.lock")), false, "القفل لم يُحرَّر");
});

// 2026-09-17: a scan slept eleven hours mid-run; the first hook after waking
// took its lock for being old, and two scans ran together.
const lockFile = path.join(vault, ".index", "scan.lock");

check("a live holder keeps its lock however old it is", () => {
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: "2020-01-01T00:00:00.000Z", token: "sleeper" }));
  assert.throws(() => acquireLock(vault), LockHeldError, "انتُزع قفل عملية حيّة لعمره");
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "sleeper", "لُمس قفل صاحبه حيّ");
  fs.unlinkSync(lockFile);
});

check("--break-lock takes a live holder's lock, and the broken holder's release leaves the new lock alone", () => {
  const first = acquireLock(vault);
  let second;
  captureStderr(() => {
    second = acquireLock(vault, { breakLock: true });
  });
  first(); // the broken scan ends — it must not unlock the vault under the second
  assert.ok(fs.existsSync(lockFile), "حرّر المسح المكسور قفل غيره");
  assert.throws(() => acquireLock(vault), LockHeldError, "المخزن بلا قفل والمسح الثاني يعمل");
  second();
  assert.equal(fs.existsSync(lockFile), false, "القفل لم يُحرَّر");
});

check("an unreadable lock counts as held, not as free", () => {
  fs.writeFileSync(lockFile, "");
  assert.throws(() => acquireLock(vault), LockHeldError);
  let release;
  captureStderr(() => {
    release = acquireLock(vault, { breakLock: true });
  });
  release();
  assert.equal(fs.existsSync(lockFile), false);
});

// ---- brief injection after a scan -----------------------------------------

const cfg = ConfigSchema.parse({ vault, sources: {} });

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

check("syncProjects writes the three agent files, once, and skips a missing folder", () => {
  writeFileAtomic(briefPath(vault, "proj"), "# ذاكرة proj\n\n- شيء\n");
  const dir = path.join(base, "proj-folder");
  fs.mkdirSync(dir, { recursive: true });
  let first;
  const err = captureStderr(() => {
    first = syncProjects(cfg, new Map([["proj", dir], ["ghost", path.join(base, "no-such-dir")]]));
  });
  assert.equal(first.written.length, 3, `كُتبت ${first.written.length} ملفات بدل 3`);
  for (const name of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    assert.ok(text.includes("<!-- memory-engine:begin -->"), `${name} بلا كتلة`);
    assert.ok(text.includes("# ذاكرة proj"), `${name} بلا الموجز`);
  }
  assert.equal(err, "", "أُوقف الحقن خارج أي مستودع git");
  const second = syncProjects(cfg, new Map([["proj", dir]]));
  assert.deepEqual(second.written, [], "أُعيدت الكتابة بلا تغيير");
});

// ---- a repository that will be published ----------------------------------
// A warning in a detached scan's log is read by nobody. So a file git would
// carry stops the injection, and the stop is written into the config file.

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
const configOnDisk = () => JSON.parse(fs.readFileSync(path.join(vault, "engine.config.json"), "utf8"));
const freshCfg = (inject = {}) => ConfigSchema.parse({ vault, sources: {}, inject });

check("files git would publish stop the injection: nothing is written and inject:false lands in the config file", () => {
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  const legacy = "# يدوي\n\nسطر للمؤلف.\n\n<!-- memory-engine:begin -->\nقديم\n<!-- memory-engine:end -->\n";
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), legacy);
  // The user's own settings must survive the edit.
  fs.writeFileSync(path.join(vault, "engine.config.json"), JSON.stringify({ minUserChars: 321, inject: { other: true } }));
  const c = freshCfg({ other: true });

  let r;
  const err = captureStderr(() => {
    r = syncProjects(c, new Map([["proj", dir]]));
  });
  assert.deepEqual(r.written, [], "كُتب في مستودع سيُنشر");
  for (const name of ["CLAUDE.local.md", "AGENTS.md", "GEMINI.md"]) {
    assert.ok(!fs.existsSync(path.join(dir, name)), `أُنشئ ${name}`);
  }
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), legacy, "لُمس CLAUDE.md رغم الإيقاف");
  assert.equal(r.stopped.length, 1);
  for (const name of ["CLAUDE.local.md", "AGENTS.md", "GEMINI.md"]) {
    assert.ok(r.stopped[0].includes(name), `التقرير لا يسمّي ${name}`);
  }
  assert.ok(r.stopped[0].includes('"inject": {"proj": false}'), "التقرير لا يقول ما كُتب");
  // Said once, by whoever prints the result — not also on stderr, which a
  // detached scan writes into the same log.
  assert.equal(err, "", "قيل مرتين");

  const onDisk = configOnDisk();
  assert.equal(onDisk.inject.proj, false, "لم يُكتب inject:false في الملف");
  assert.equal(onDisk.inject.other, true, "ضاع بند آخر من inject");
  assert.equal(onDisk.minUserChars, 321, "ضاع حقل آخر من الإعداد");
  assert.equal(c.inject.proj, false, "النسخة المحمّلة لم تعلم بالإيقاف");

  // Stopped means stopped: the next scan neither writes nor repeats itself.
  const again = captureStderr(() => {
    r = syncProjects(c, new Map([["proj", dir]]));
  });
  assert.deepEqual(r, { written: [], stopped: [] });
  assert.equal(again, "");
});

check("once the files are ignored and the stop is removed, CLAUDE.local.md is written and a stale CLAUDE.md block moves out", () => {
  const dir = path.join(base, "repo");
  fs.writeFileSync(path.join(dir, ".gitignore"), "/CLAUDE.local.md\n/AGENTS.md\n/GEMINI.md\n");
  const c = freshCfg();
  let r;
  const err = captureStderr(() => {
    r = syncProjects(c, new Map([["proj", dir]]));
  });
  assert.equal(err, "", `أُوقف رغم .gitignore: ${err}`);
  assert.ok(fs.existsSync(path.join(dir, "CLAUDE.local.md")), "لم يُكتب CLAUDE.local.md");
  const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.equal(claude, "# يدوي\n\nسطر للمؤلف.\n", "بقيت الكتلة القديمة أو ضاع نص المؤلف");
  assert.ok(r.written.some((f) => f.endsWith("CLAUDE.local.md")));
});

check("a tracked file stops the injection too, and inject:true is the explicit approval that writes into it", () => {
  const dir = path.join(base, "repo-tracked");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), "/CLAUDE.local.md\n/GEMINI.md\n");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# تعليمات الفريق\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  writeFileAtomic(briefPath(vault, "team"), "# ذاكرة team\n\n- شيء\n");

  let r;
  captureStderr(() => {
    r = syncProjects(freshCfg(), new Map([["team", dir]]));
  });
  assert.deepEqual(r.written, []);
  assert.match(r.stopped[0] ?? "", /AGENTS\.md \(متتبَّع في git\)/, "لم يُسمَّ الملف المتتبَّع");
  assert.ok(!r.stopped[0].includes("CLAUDE.local.md"), "سُمّي ملف متجاهَل");
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "# تعليمات الفريق\n");

  r = syncProjects(freshCfg({ team: true }), new Map([["team", dir]]));
  assert.equal(r.stopped.length, 0, "أُوقف رغم الإقرار الصريح");
  assert.ok(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").includes("<!-- memory-engine:begin -->"), "لم يُكتب رغم الإقرار");
});

check("inject:false keeps the brief out of that project's folder entirely", () => {
  const off = freshCfg({ proj: false });
  const dir = path.join(base, "repo-off");
  fs.mkdirSync(dir, { recursive: true });
  const r = syncProjects(off, new Map([["proj", dir]]));
  assert.deepEqual(r.written, [], "كُتب رغم inject:false");
  assert.equal(fs.readdirSync(dir).length, 0);
});

// ---- the hook names a transcript that was never written -------------------------
// A session closed without a word has no transcript, and the payload names
// one anyway. The child scan used to die on it with a stack trace in hook.log
// and a non-zero exit; the user's rule (2026-09-25): one line, exit zero.

check("scan --file on a missing transcript prints one line and exits zero — no stack trace", () => {
  const cli = fileURLToPath(new URL("../test-build/cli.js", import.meta.url));
  const vault = path.join(base, "vault-missing");
  const missing = path.join(base, "projects", "C--gone", "00000000-0000-4000-8000-0000000000ff.jsonl");
  const out = execFileSync(process.execPath, [cli, "scan", "--agent", "claude-code", "--limit", "1", "--file", missing, "--vault", vault], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = out.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `أكثر من سطر:\n${out}`);
  assert.match(lines[0], /غير موجود/);
  assert.ok(!/\bat \S+ \(/.test(out) && !out.includes("Error:"), "تتبّع مكدّس في المخرجات");
});

fs.rmSync(base, { recursive: true, force: true });

process.stdout.write(`\nhook: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
