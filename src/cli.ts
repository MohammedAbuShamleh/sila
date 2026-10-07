#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, defaultSources, defaultVault, injectAllowed, loadConfig, migrateConfig, writeConfig } from "./config.js";
import { ADAPTERS } from "./adapters/index.js";
import { Store, transcriptGone } from "./store/db.js";
import { Git } from "./store/git.js";
import { MissingTranscriptError, REREAD_DAYS, REREAD_OVER, frequentRereads, openSessions, rejectedLiveSubjects, scan, undefinedLiveTools, usageLines, waitingLines, writeInbox } from "./pipeline/run.js";
import { rebaseAll, rebuildIndex } from "./pipeline/reindex.js";
import { movePlan, readPlan, restoreSlot } from "./pipeline/move.js";
import { runAudit } from "./pipeline/audit.js";
import { inferDigests } from "./pipeline/digests.js";
import { cliAvailable, cliModel } from "./pipeline/extract.js";
import { buildBrief, describeStop, injectBrief, writeBrief } from "./serve/brief.js";
import { hookStatus, installHook, npxInstall, transcriptFromHookPayload, uninstallHook } from "./serve/hook.js";
import { DEFAULT_INTERVAL, TASK_NAME, posixInstructions, taskXml, taskXmlBytes } from "./serve/schedule.js";
import { initVault, listSessionNotes, retractInNote, writeSubject } from "./store/vault.js";
import { reconcile } from "./pipeline/reconcile.js";
import { LockHeldError } from "./util/lock.js";
import type { AgentId } from "./types.js";
import { CLI_FOR_AGENT } from "./types.js";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";

function flag(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1];
  return fallback;
}
function bool(name: string): boolean {
  return argv.includes(`--${name}`);
}
function positional(n: number): string | undefined {
  return argv.slice(1).filter((a) => !a.startsWith("--"))[n];
}

const vault = flag("vault") ?? defaultVault();

/**
 * `sila hook install|uninstall|status [--file <settings.json>]`
 *
 * User-level settings by default: the hook belongs to the person, not to a
 * project, and a scan started from any folder covers every project anyway.
 * `--file` exists so the command can be exercised against a copy first.
 *
 * The entry names node and this file by absolute path — exec form, no shell,
 * no reliance on `sila` being on PATH — which is the form that survives a
 * home directory with a non-ASCII character in it.
 */
function cmdHook(): void {
  const action = positional(0) ?? "status";
  const file = flag("file") ?? path.join(os.homedir(), ".claude", "settings.json");
  const cliPath = fileURLToPath(import.meta.url);

  if (action === "install") {
    const refused = npxInstall(cliPath);
    if (refused) {
      process.stderr.write(`${refused}\n`);
      process.exitCode = 1;
      return;
    }
    const { changed, entry } = installHook(file, process.execPath, cliPath);
    process.stdout.write(changed ? `كُتب hook SessionEnd في ${file}:\n` : `موجود بالفعل في ${file} بلا تغيير:\n`);
    process.stdout.write(`  ${JSON.stringify(entry.hooks[0])}\n`);
    process.stdout.write("يسري من الجلسة التالية لـ Claude Code؛ الإعدادات تُقرأ عند البدء.\n");
    return;
  }
  if (action === "uninstall") {
    process.stdout.write(uninstallHook(file) ? `أُزيل من ${file}.\n` : `لا hook لنا في ${file}.\n`);
    return;
  }
  if (action === "status") {
    const entry = hookStatus(file);
    process.stdout.write(entry ? `مثبَّت في ${file}:\n  ${JSON.stringify(entry.hooks[0])}\n` : `غير مثبَّت في ${file}.\n`);
    return;
  }
  process.stderr.write("استخدام: sila hook install|uninstall|status [--file <settings.json>]\n");
}

/**
 * `sila schedule install|uninstall|status [--file <out.xml>] [--interval 15]`
 *
 * What covers Codex and Gemini, which have no hook to install: the machine
 * starts the scan instead of a terminal someone left open.
 *
 * `--file` writes the task definition and registers nothing, which is how
 * this was exercised without touching the real Task Scheduler.
 */
function cmdSchedule(): void {
  const action = positional(0) ?? "status";
  const cliPath = fileURLToPath(import.meta.url);
  const minutes = Number(flag("interval", String(DEFAULT_INTERVAL)));
  const out = flag("file");

  // Install here, and on other systems the printed entry the user installs:
  // either carries this file's path, which must outlast npx's cache.
  const refused = npxInstall(cliPath, "schedule");
  if (refused && (action === "install" || process.platform !== "win32")) {
    process.stderr.write(`${refused}\n`);
    process.exitCode = 1;
    return;
  }

  if (process.platform !== "win32") {
    process.stdout.write(`${posixInstructions(process.execPath, cliPath, vault, minutes)}\n`);
    return;
  }

  const schtasks = (args: string[]): { ok: boolean; text: string } => {
    try {
      return {
        ok: true,
        text: execFileSync("schtasks.exe", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, text: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message ?? err) };
    }
  };

  if (action === "install") {
    const xml = taskXml(process.execPath, cliPath, vault, minutes);
    const file = out ?? path.join(os.tmpdir(), `sila-task-${process.pid}.xml`);
    // Not writeFileAtomic: Task Scheduler demands UTF-16, and this file is
    // outside the vault.
    fs.writeFileSync(file, taskXmlBytes(xml));
    if (out) {
      process.stdout.write(`كُتب تعريف المهمة في ${out} — لم يُسجَّل شيء في المجدول.\n`);
      process.stdout.write(`للتسجيل يدوياً:\n  schtasks /Create /TN "${TASK_NAME}" /XML "${out}" /F\n`);
      return;
    }
    const r = schtasks(["/Create", "/TN", TASK_NAME, "/XML", file, "/F"]);
    fs.unlinkSync(file);
    process.stdout.write(
      r.ok
        ? `سُجِّلت المهمة "${TASK_NAME}": كل ${minutes} دقيقة بدءاً بعد ${minutes} دقيقة، وعند تسجيل الدخول؛ مخفية.\n`
        : `فشل التسجيل:\n${r.text}\n`,
    );
    if (r.ok) process.stdout.write(`السجل: ${path.join(vault, ".index", "hook.log")}\n`);
    return;
  }

  if (action === "uninstall") {
    const r = schtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
    process.stdout.write(r.ok ? `أُزيلت المهمة "${TASK_NAME}".\n` : `لا مهمة بهذا الاسم، أو فشل الحذف:\n${r.text}\n`);
    return;
  }

  if (action === "status") {
    const r = schtasks(["/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"]);
    process.stdout.write(r.ok ? r.text : `غير مثبَّتة: "${TASK_NAME}"\n`);
    return;
  }

  process.stderr.write("استخدام: sila schedule install|uninstall|status [--file <out.xml>] [--interval 15]\n");
}

async function main(): Promise<void> {
  switch (cmd) {
    case "init":
      return cmdInit();
    case "scan":
      return cmdScan();
    case "watch":
      return cmdWatch();
    case "search":
      return cmdSearch();
    case "brief":
      return cmdBrief();
    case "subject":
      return cmdSubject();
    case "history":
      return cmdHistory();
    case "pending":
      return cmdPending();
    case "accept":
      return cmdDecide("accepted");
    case "reject":
      return cmdDecide("rejected");
    case "retract":
      return cmdRetract();
    case "restore":
      return cmdRestore();
    case "move":
      return cmdMove();
    case "reindex":
      return cmdReindex();
    case "rebase":
      return cmdRebase();
    case "stats":
      return cmdStats();
    case "doctor":
      return cmdDoctor();
    case "audit":
      return cmdAudit();
    case "infer-digests":
      return cmdInferDigests();
    case "hook":
      return cmdHook();
    case "schedule":
      return cmdSchedule();
    default:
      return help();
  }
}

function help(): void {
  process.stdout.write(
    `
sila — ذاكرة مشتركة لوكلائك البرمجية

  sila init                      أنشئ المخزن واكتشف مصادر الجلسات
  sila scan [--limit N]          اقرأ الجلسات الجديدة وحدّث الذاكرة
       [--concurrency N] [--dry-run] [--force] [--agent claude-code|codex|gemini]
       [--project <slug>]       مشروع واحد فقط؛ مع --force لإعادة معالجته كله
       [--file <transcript>]    ملف جلسة واحد بعينه؛ وكيله من موقعه أو من --agent
       [--max-chars N]          سقف نص الجلسة لهذا التشغيل بدل distillMaxChars — لجلسة يتلف ردّها
       [--from-hook]            اقرأ transcript_path من حمولة SessionEnd على stdin
       [--detach]               أعد التشغيل في الخلفية وارجع فوراً (للـhooks)
       [--break-lock]           خذ القفل ولو كان صاحبه حيّاً — لمسح معلّق أو pid أُعيد استعماله
  sila watch [--interval 900]    نفس scan كل فترة — لـCodex وGemini: --interval 60
  sila hook install|uninstall|status   hook انتهاء جلسة Claude Code
       [--file <settings.json>] يشغّل scan --agent claude-code --from-hook --detach
  sila schedule install|uninstall|status  مهمة مجدولة: scan كل 15 دقيقة
       [--interval 15] [--file <out.xml>]  ويندوز؛ غيره يطبع launchd/cron
  sila search "نص" [--project p] بحث عربي/إنجليزي في كل الجلسات
  sila brief <project> [--sync <cwd>]   اطبع الموجز، أو احقنه في CLAUDE.local.md/AGENTS.md/GEMINI.md
  sila subject <name>            اعرض ملف موضوع
  sila history <subject> <key>   تاريخ خانة واحدة: ما كان، ومتى تغيّر
  sila pending | accept <id> | reject <id>
  sila retract <subject> <key> --reason "..."   اسحب حقيقة لم تعد صحيحة
  sila restore <subject> <key> [--session <id>] [--confirm]  أعِد حقيقة سُحبت خطأً إلى ملاحظتها كما كانت؛ --confirm يثبّتها بثقة 1.0
  sila move --plan <file.json> [--dry-run]   انقل خانات إلى موضوعها: {reason, moves:[{subject,key,to,toKey,kind}]}
  sila reindex [--break-lock]    أعد بناء القاعدة من ملفات Markdown وحدها
  sila rebase [--break-lock]     طابِق القاعدة القائمة مع الملاحظات بترتيب تاريخ الجلسة — بلا حذف ولا تصفير بصمات
  sila audit [--days 60] [--pending-days 7] [--break-lock]   فحص أسبوعي بلا نموذج: تقرير في _inbox/audit.md
  sila infer-digests [--dry-run] [--break-lock]   بصمة مُستنتَجة لملاحظات ما قبل البصمة — بلا نداء، ولا تدّعي قراءة
  sila stats | doctor

  --vault <path>                افتراضياً ${defaultVault()}
`.trimStart(),
  );
}

function cmdInit(): void {
  const sources = defaultSources();
  const found: Record<string, string | null> = {};
  for (const [k, p] of Object.entries(sources)) found[k] = fs.existsSync(p) ? p : null;

  // Re-running init on an existing vault must not erase the walls — they are
  // the one thing the user wrote by hand, and the one thing whose loss is a
  // leak rather than an inconvenience. Everything already configured is kept;
  // only sources that were never found are filled in from detection.
  const existing = fs.existsSync(path.join(vault, "engine.config.json")) ? loadConfig(vault) : null;
  const cfg = ConfigSchema.parse({
    ...(existing ?? {}),
    vault,
    sources: existing
      ? Object.fromEntries(Object.entries(found).map(([k, p]) => [k, existing.sources[k as keyof typeof existing.sources] ?? p]))
      : found,
    walls: existing?.walls ?? [],
  });
  if (existing) process.stdout.write(`الإعداد موجود؛ حُفظت walls (${existing.walls.length}).\n`);
  initVault(vault);
  writeConfig(cfg);
  new Git(vault, cfg.git).init();
  const store = new Store(vault);
  store.close();

  process.stdout.write(`المخزن: ${vault}\n`);
  for (const [k, p] of Object.entries(found)) {
    process.stdout.write(`  ${p ? "✓" : "—"} ${k}: ${p ?? "غير موجود"}\n`);
  }
  process.stdout.write(
    `\nالخطوة التالية:\n  sila scan --dry-run        # اعرف كم جلسة موجودة\n  sila scan --limit 20       # جرّب على عشرين أولاً\n\nقبل التشغيل الكامل: افتح ${path.join(vault, "engine.config.json")} وعرّف "walls"\nلأي مجلد فيه بيانات أشخاص حقيقيين، مع localOnly: true.\n`,
  );
}

/** Older config files get the fields newer policy added, and say so. */
function announceMigration(): void {
  const migrated = migrateConfig(vault);
  if (migrated.length) {
    process.stdout.write(`هاجرتُ ${migrated.length} جداراً إلى same-provider: ${migrated.join("، ")}\n`);
  }
}

/**
 * Re-launch this very command in the background and return at once.
 *
 * A session-end hook that waited for a scan would hold every `claude` exit
 * for as long as an extraction takes. The child is detached from the hook's
 * process group, keeps running after the parent exits, and writes what it
 * did to <vault>/.index/hook.log — the only place a hook's output can go.
 */
function detachScan(extra: string[] = []): void {
  // --from-hook is consumed here: the child has no stdin, so what the
  // payload said travels as `--file` in argv instead.
  const args = [...process.argv.slice(1).filter((a) => a !== "--detach" && a !== "--from-hook"), ...extra];
  const logDir = path.join(vault, ".index");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "hook.log");
  const log = fs.openSync(logFile, "a");
  fs.writeSync(log, `\n[${new Date().toISOString()}] ${args.slice(1).join(" ")}\n`);
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  fs.closeSync(log);
  process.stdout.write(`بدأ المسح في الخلفية (pid ${child.pid}) · السجل ${logFile}\n`);
}

/** The hook payload on stdin, or nothing when there is no pipe to read. */
function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function cmdScan(): Promise<void> {
  // A session-end hook says which transcript just closed, on stdin. Read
  // before any detach — the detached child has no stdin to read it from.
  const hookFile = bool("from-hook") ? transcriptFromHookPayload(readStdin()) : null;
  if (bool("from-hook") && !hookFile) process.stderr.write("حمولة الـhook بلا transcript_path؛ سيُمسح أقدم ملف متغيّر.\n");
  if (bool("detach")) return detachScan(hookFile ? ["--file", hookFile] : []);
  announceMigration();
  const cfg = loadConfig(vault);
  const t0 = Date.now();
  let r: Awaited<ReturnType<typeof scan>>;
  try {
    r = await scan(cfg, {
      limit: Number(flag("limit", "100")),
      concurrency: Number(flag("concurrency", "3")),
      dryRun: bool("dry-run"),
      force: bool("force"),
      onlyAgent: flag("agent"),
      onlyProject: flag("project"),
      onlyFile: flag("file") ?? hookFile ?? undefined,
      maxChars: flag("max-chars") ? Number(flag("max-chars")) : undefined,
      breakLock: bool("break-lock"),
    });
  } catch (err) {
    // Another scan owns the vault right now — a hook firing while `watch`
    // runs, or the reverse. Losing this one costs nothing: the next scan
    // reads the same files.
    if (err instanceof LockHeldError) {
      process.stdout.write(`${err.message}. لم يُشغَّل مسح ثانٍ. إن كنت متأكداً أنه ليس مسحاً يعمل: --break-lock\n`);
      return;
    }
    // The hook named a transcript that was never written. One line in
    // hook.log and a clean exit: nothing failed, there was nothing to read.
    if (err instanceof MissingTranscriptError) {
      process.stdout.write(`${err.message}\n`);
      return;
    }
    throw err;
  }
  if (bool("dry-run")) return;
  if (r.briefsRewritten.length) process.stdout.write(`أُعيد موجز كان يعرض ما لا يعمل: ${r.briefsRewritten.join("، ")}.\n`);
  if (r.synced.length) process.stdout.write(`حُقن الموجز في ${r.synced.length} ملف.\n`);
  for (const report of r.injectStopped) process.stdout.write(report);
  const project = flag("project");
  const u = r.usage;
  process.stdout.write(
    `\nاكتُشف ${r.discovered} · عولج ${r.processed} · دون تغيير ${r.skippedUnchanged} · قصيرة ${r.skippedTiny}` +
      (r.unchangedText ? ` · تغيّر الملف لا نصه ${r.unchangedText}` : "") +
      (project ? ` · خارج ${project}: ${r.skippedOtherProject}` : "") +
      (r.skippedSelf ? ` · ذاتية ${r.skippedSelf}` : "") +
      (r.skippedOpen ? ` · مفتوحة ${r.skippedOpen}` : "") +
      (r.keptPrevious ? ` · بقيت ملاحظتها السابقة ${r.keptPrevious}` : "") +
      (r.leftAtLimit ? ` · توقّف عند الحدّ ${Number(flag("limit", "100"))}، بقي ${r.leftAtLimit}` : "") +
      `\nحقائق +${r.factsAdded} · استُبدل ${r.factsSuperseded} · سُحب ${r.factsRetracted} · معلّق +${r.queued}` +
      (r.factsRestored ? ` · أُعيد بتاريخ الجلسة ${r.factsRestored}` : "") +
      (r.subjectsAnchored ? ` · مواضيع أُعيدت لمشروعها ${r.subjectsAnchored}` : "") +
      (r.movesApplied ? ` · نقل مسجّل طُبّق ${r.movesApplied}` : "") +
      (r.confirmedCarried ? ` · مثبَّت محمول ${r.confirmedCarried}` : "") +
      `\nمحجوب ${r.quarantined} · فشل ${r.failed}` +
      (r.pendingExtraction ? ` · ينتظر استخلاصه ${r.pendingExtraction}` : "") +
      ` · ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (r.commit ? ` · commit ${r.commit}` : "") +
      // Who answered, each on its line (usageLines) — not the configured
      // provider, which on a fresh config said "anthropic" for calls the
      // agents' CLIs took.
      (u.calls ? `\nنداءات النموذج ${u.calls}${usageLines(r.usageBy)}` : "") +
      (r.waiting.length ? `\nينتظر استخلاصه${waitingLines(r.waiting)}` : "") +
      `\n`,
  );
  if (project && !r.processed && r.skippedOtherProject) {
    process.stdout.write(`لا جلسة جديدة تطابق --project ${project}. جرّب --force لإعادة معالجة ما سبق.\n`);
  }
  if (r.quarantined) process.stdout.write(`راجع ${path.join(vault, "_inbox", "quarantine.md")}\n`);
}

async function cmdWatch(): Promise<void> {
  // Every cycle would break the lock of whatever else is scanning — a hook's
  // scan, a manual one — for as long as watch runs.
  if (bool("break-lock")) {
    return void process.stderr.write("--break-lock لا يُستعمل مع watch: كل دورة ستكسر قفل غيرها. استعمله مع scan مرة واحدة.\n");
  }
  const interval = Number(flag("interval", "900")) * 1000;
  process.stdout.write(`watch: كل ${interval / 1000} ثانية. Ctrl+C للإيقاف.\n`);
  for (;;) {
    try {
      await cmdScan();
    } catch (err) {
      process.stderr.write(`watch: ${String(err).slice(0, 200)}\n`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

function cmdSearch(): void {
  const q = positional(0);
  if (!q) return void process.stderr.write("استخدام: sila search \"نص\"\n");
  const store = new Store(vault);
  const rows = store.search(q, Number(flag("limit", "15")), flag("project"));
  if (!rows.length) process.stdout.write("لا نتائج.\n");
  for (const r of rows) {
    process.stdout.write(`\n${r.project} · ${r.title}\n  ${r.snippet.replace(/\s+/g, " ")}\n  ${r.session_id}\n`);
  }
  store.close();
}

function cmdBrief(): void {
  const project = positional(0);
  if (!project) return void process.stderr.write("استخدام: sila brief <project>\n");
  const store = new Store(vault);
  const sync = flag("sync");
  if (sync) {
    const cfg = loadConfig(vault);
    if (!injectAllowed(cfg, project)) {
      process.stdout.write(`الحقن موقوف لـ ${project} في engine.config.json ("inject"). لم يُكتب شيء.\n`);
    } else {
      writeBrief(store, vault, project);
      const r = injectBrief(cfg, project, sync);
      if (r.stopped.length) process.stdout.write(describeStop(project, r.stopped));
      else process.stdout.write(r.written.length ? `حُدِّث:\n${r.written.map((w) => `  ${w}`).join("\n")}\n` : "لا تغيير.\n");
    }
  } else {
    process.stdout.write(buildBrief(store, vault, project) + "\n");
  }
  store.close();
}

function cmdSubject(): void {
  const name = positional(0);
  if (!name) return void process.stderr.write("استخدام: sila subject <name>\n");
  const store = new Store(vault);
  const facts = store.liveFacts(name);
  if (!facts.length) {
    process.stdout.write(`لا حقائق حيّة لـ ${name}\n`);
  } else {
    process.stdout.write(`# ${name}\n\n`);
    for (const f of facts) {
      process.stdout.write(`  ${f.key.padEnd(22)} ${f.claim}\n`);
    }
  }
  store.close();
}

function cmdHistory(): void {
  const subject = positional(0);
  const key = positional(1);
  if (!subject || !key) return void process.stderr.write("استخدام: sila history <subject> <key>\n");
  const store = new Store(vault);
  const rows = store.history(subject, key);
  if (!rows.length) process.stdout.write("لا تاريخ.\n");
  for (const r of rows) {
    const state = r.retracted_at
      ? `سُحب ${r.retracted_at.slice(0, 10)}`
      : r.superseded_at
        ? `حتى ${r.superseded_at.slice(0, 10)}`
        : "حالي";
    process.stdout.write(`${r.created_at.slice(0, 10)}  [${state}]  ${r.claim}\n            ${r.session_id}\n`);
  }
  store.close();
}

function cmdPending(): void {
  const store = new Store(vault);
  const rows = store.db
    .prepare("SELECT * FROM pending WHERE status='waiting' ORDER BY created_at DESC LIMIT 100")
    .all() as Array<{ id: number; subject: string; key: string; claim: string; confidence: number; reason: string }>;
  if (!rows.length) process.stdout.write("لا شيء ينتظر.\n");
  for (const r of rows) {
    process.stdout.write(`[${r.id}] ${r.subject}.${r.key}\n     ${r.claim}\n     ${r.reason} · ${r.confidence.toFixed(2)}\n`);
  }
  store.close();
}

function cmdDecide(status: "accepted" | "rejected"): void {
  const id = Number(positional(0));
  if (!id) return void process.stderr.write(`استخدام: sila ${status === "accepted" ? "accept" : "reject"} <id>\n`);
  const store = new Store(vault);
  const row = store.db.prepare("SELECT * FROM pending WHERE id = ?").get(id) as
    | { id: number; subject: string; subject_kind: string; key: string; claim: string; session_id: string }
    | undefined;
  if (!row) {
    store.close();
    return void process.stderr.write("لا يوجد بند بهذا الرقم.\n");
  }
  store.db.prepare("UPDATE pending SET status = ? WHERE id = ?").run(status, id);

  if (status === "accepted") {
    // Confidence 1.0: a human said so. Nothing the model produces can override it.
    reconcile(
      store,
      {
        title: "",
        project: "",
        summary: "",
        did: [],
        decisions: [],
        rejected: [],
        open: [],
        links: [],
        facts: [
          {
            subject: row.subject,
            subjectKind: row.subject_kind as never,
            key: row.key,
            claim: row.claim,
            confidence: 1,
          },
        ],
      },
      row.session_id,
      0,
    );
    writeSubject(vault, store, row.subject, row.subject_kind);
  }
  writeInbox(store, vault);
  // The brief carries this slot either way — as a live fact after accept, or
  // in its pending section until reject removes it. Both change what an agent
  // reads at its next session start, so both regenerate it.
  const owner = store.db.prepare("SELECT project FROM sessions WHERE id = ?").get(row.session_id) as
    | { project: string }
    | undefined;
  if (owner) writeBrief(store, vault, owner.project);
  new Git(vault, true).commit(`${status}: ${row.subject}.${row.key}`);
  store.close();
  process.stdout.write(`${status}: ${row.subject}.${row.key}\n`);
}

/**
 * `sila retract <subject> <key> --reason "..."`
 *
 * The correction a human makes by hand when a claim was never true — as
 * opposed to `accept`/`reject`, which decide a claim that never entered.
 * Nothing is deleted: the row keeps its retracted_at, and the note that made
 * the claim moves it into its own `سُحب` section. Both halves are required —
 * the database alone would be undone by the next `reindex`.
 */
function cmdRetract(): void {
  const subject = positional(0);
  const key = positional(1);
  const reason = flag("reason");
  if (!subject || !key) {
    return void process.stderr.write('استخدام: sila retract <subject> <key> --reason "لماذا"\n');
  }
  if (!reason) {
    // A withdrawal with no reason is indistinguishable six months later from
    // a mistake, and this is the one operation with no session behind it.
    return void process.stderr.write("--reason مطلوب: لماذا لم تعد هذه الحقيقة صحيحة؟\n");
  }

  const store = new Store(vault);
  const now = new Date().toISOString();

  // The slot is emptied everywhere, not just where it is currently live.
  // Two sessions can each claim a slot — the newer superseding the older —
  // and withdrawing only the live row leaves the older note still claiming
  // it, so `reindex` replays that note and the slot comes back. Seen live
  // with `arch.storage`. So every note that claims it gives it up, and every
  // row of the slot that is not already withdrawn is marked.
  const touched: string[] = [];
  let claim = "";
  for (const file of listSessionNotes(vault)) {
    const gone = retractInNote(file, subject, key, now, reason);
    if (!gone) continue;
    claim ||= gone.claim;
    touched.push(path.relative(vault, file).replace(/\\/g, "/"));
  }

  const rows = store.db
    .prepare("SELECT * FROM facts WHERE subject = ? AND key = ? AND retracted_at IS NULL")
    .all(subject, key) as Array<{ id: number; claim: string; subject_kind: string; session_id: string }>;

  if (!touched.length && !rows.length) {
    store.close();
    return void process.stderr.write(`لا شيء في ${subject}.${key} — لا ملاحظة تدّعيها ولا صف غير مسحوب.\n`);
  }
  if (!touched.length) {
    // Live in the index, claimed by no note. Marking only the database would
    // be undone by the next rebuild, so nothing is marked and the mismatch
    // is reported instead.
    store.close();
    return void process.stderr.write(
      `${subject}.${key} حيّ في الفهرس ولا ملاحظة تحمله — لم يُسحب شيء. شغّل sila reindex ثم أعد المحاولة.\n`,
    );
  }

  for (const r of rows) store.retract(r.id, now);
  const kind = rows[0]?.subject_kind ?? "project";
  claim ||= rows[0]?.claim ?? "";
  writeSubject(vault, store, subject, kind);

  const projects = new Set(
    (store.db.prepare("SELECT DISTINCT project FROM sessions WHERE status = 'ok'").all() as Array<{ project: string }>)
      .map((p) => p.project),
  );
  const cfg = loadConfig(vault);
  for (const p of projects) writeBrief(store, vault, p, cfg.briefMaxChars);
  writeInbox(store, vault);
  new Git(vault, true).commit(`retract: ${subject}.${key} — ${reason}`);
  store.close();
  process.stdout.write(
    `سُحب ${subject}.${key}\n  ${claim}\n  السبب: ${reason}\n  ${touched.length} ملاحظة · ${rows.length} صف\n`,
  );
}

/**
 * `sila restore <subject> <key> [--session <id>] [--confirm]` — see
 * restoreSlot. The mirror of retract: the withdrawn claim goes back into the
 * note that made it, as it was — or at 1.0 with --confirm — and the subject
 * is re-derived from its notes.
 */
function cmdRestore(): void {
  const subject = positional(0);
  const key = positional(1);
  if (!subject || !key) return void process.stderr.write("استخدام: sila restore <subject> <key> [--session <id>] [--confirm]\n");
  let r: ReturnType<typeof restoreSlot>;
  try {
    r = restoreSlot(loadConfig(vault), subject, key, { session: flag("session"), breakLock: bool("break-lock"), confirm: bool("confirm") });
  } catch (err) {
    if (err instanceof LockHeldError) {
      return void process.stdout.write(`${err.message}. لم يُستعد شيء. إن كنت متأكداً أنه ليس مسحاً يعمل: --break-lock\n`);
    }
    throw err;
  }
  if (r.refused) {
    process.stderr.write(`${r.refused}\n`);
    process.exitCode = 1;
    return;
  }
  const rb = r.rebase;
  process.stdout.write(
    `أُعيدت ${subject}.${key} إلى ملاحظة ${r.session}\n  ${r.fact?.claim ?? ""}\n  الثقة: ${(r.fact?.confidence ?? 0).toFixed(2)}${bool("confirm") ? " — ثبّتها الإنسان" : ""}` +
      (rb ? `\n  صفوف +${rb.inserted} · استبدال ${rb.superseded} · سحب ${rb.retracted} · أُعيد ${rb.restored}` : "") +
      (r.commit ? ` · commit ${r.commit}` : "") +
      "\n",
  );
}

/**
 * `sila move --plan <file.json> [--dry-run]` — see movePlan. The dry run
 * prints what would move and what the notes would give after, and writes
 * nothing; a refused move refuses the whole plan either way.
 */
function cmdMove(): void {
  const file = flag("plan");
  if (!file) return void process.stderr.write("استخدام: sila move --plan <file.json> [--dry-run]\n");
  let r: ReturnType<typeof movePlan>;
  try {
    r = movePlan(loadConfig(vault), readPlan(file), { dryRun: bool("dry-run"), breakLock: bool("break-lock") });
  } catch (err) {
    if (err instanceof LockHeldError) {
      return void process.stdout.write(`${err.message}. لم يُنقل شيء. إن كنت متأكداً أنه ليس مسحاً يعمل: --break-lock\n`);
    }
    throw err;
  }
  for (const m of r.moves) {
    const live = m.live ? `  «${m.live.slice(0, 70)}»` : "  (لا ادعاء حيّ)";
    process.stdout.write(`${m.subject}.${m.key} → ${m.to}.${m.toKey} [${m.kind}] · ${m.notes} ملاحظة\n${live}\n`);
  }
  if (r.refused.length) {
    process.stdout.write(`\nرُفضت الخطة كلها — لم يُكتب شيء:\n${r.refused.map((x) => `  ${x}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `\n${r.moves.length} خانة · حيّ ${r.before.facts} ← ${r.after.facts} · مواضيع ${r.before.subjects} ← ${r.after.subjects}` +
      `\nمواضيع لا يبقى لها ادعاء: ${r.emptied.join("، ") || "—"}\n`,
  );
  if (bool("dry-run")) return void process.stdout.write("--dry-run: لم يُكتب شيء.\n");
  const rb = r.rebase;
  process.stdout.write(
    `كُتبت ${r.notesWritten} ملاحظة` +
      (rb ? ` · صفوف +${rb.inserted} · استبدال ${rb.superseded} · سحب ${rb.retracted} · أُعيد ${rb.restored}` : "") +
      (r.commit ? ` · commit ${r.commit}` : "") +
      "\n",
  );
}

/** See rebuildIndex: the notes alone, replayed in session-date order. */
function cmdReindex(): void {
  let r: ReturnType<typeof rebuildIndex>;
  try {
    r = rebuildIndex(loadConfig(vault), { breakLock: bool("break-lock") });
  } catch (err) {
    if (err instanceof LockHeldError) {
      return void process.stdout.write(`${err.message}. لم يُعَد البناء. إن كنت متأكداً أنه ليس مسحاً يعمل: --break-lock\n`);
    }
    throw err;
  }
  process.stdout.write(`أُعيد بناء الفهرس من ${r.notes} ملاحظة · ${r.facts} حقيقة · ${r.subjects} موضوعاً\n`);
  process.stdout.write(
    "ملاحظة: content_hash أُعيد ضبطه، فالمسح القادم يعيد قراءة الملفات الأصلية مرة — بلا نموذج لكل جلسة تحمل ملاحظتها بصمة نصها.\n",
  );
}

/** See rebaseAll: the index brought into line with its notes, in place. */
function cmdRebase(): void {
  let r: ReturnType<typeof rebaseAll>;
  try {
    r = rebaseAll(loadConfig(vault), { breakLock: bool("break-lock") });
  } catch (err) {
    if (err instanceof LockHeldError) {
      return void process.stdout.write(`${err.message}. لم يُطابَق شيء. إن كنت متأكداً أنه ليس مسحاً يعمل: --break-lock\n`);
    }
    throw err;
  }
  process.stdout.write(
    `طوبقت ${r.subjects} موضوعاً مع ${r.notes} ملاحظة بترتيب تاريخ الجلسة؛ تغيّر ${r.changed.length}\n` +
      `صفوف +${r.inserted} · استبدال ${r.superseded} · سحب ${r.retracted} · أُعيد ${r.restored} · معلّق +${r.queued}` +
      (r.resumes ? ` · استئناف ${r.resumes}` : "") +
      (r.commit ? ` · commit ${r.commit}` : "") +
      "\n",
  );
}

function cmdStats(): void {
  const store = new Store(vault);
  const s = store.stats();
  const last = store.getMeta("last_scan");
  // A session whose transcript has gone is not waiting: no scan will find it
  // to try again. It is counted apart, by name — see transcriptGone.
  const rows = store.pendingExtractions();
  const waiting = rows.filter((r) => !transcriptGone(r));
  const gone = rows.filter(transcriptGone);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (k !== "pendingExtraction") {
      lines.push(`${k.padEnd(14)} ${v}`);
      continue;
    }
    // Who each waiting session waits on, and what it said — see waitingLines.
    lines.push(`${k.padEnd(14)} ${waiting.length}${waiting.length ? waitingLines(waiting) : ""}`);
    lines.push(`${"unreadTextGone".padEnd(14)} ${gone.length}${gone.map((r) => `\n  ${r.id} — نصّها مفقود · ${r.source_file || "(لا مسار مسجَّل)"}`).join("")}`);
  }
  process.stdout.write(`${lines.join("\n")}\nlast_scan      ${last ?? "—"}\n`);
  store.close();
}

/**
 * `sila audit [--days 60] [--pending-days 7] [--break-lock]` — see runAudit.
 *
 * The findings go into `_inbox/audit.md`; stdout gets the counts, so a
 * scheduled run leaves one legible line in the log and the reading itself
 * waits in the vault. Nothing is fixed, and the exit code stays zero: a
 * finding is a question for the user, not a failure.
 */
function cmdAudit(): void {
  const days = Number(flag("days") ?? 60);
  const pendingDays = Number(flag("pending-days") ?? 7);
  if (!Number.isFinite(days) || days < 1 || !Number.isFinite(pendingDays) || pendingDays < 1) {
    return void process.stderr.write("--days و--pending-days عددان موجبان بالأيام\n");
  }
  let r: ReturnType<typeof runAudit>;
  try {
    r = runAudit(loadConfig(vault), { days, pendingDays, breakLock: bool("break-lock") });
  } catch (err) {
    if (err instanceof LockHeldError) {
      return void process.stdout.write(`${err.message}. لم يُفحَص شيء — الفهرس في منتصف تحديثه. أعِد المحاولة، أو --break-lock إن كان القفل معلّقاً.\n`);
    }
    throw err;
  }
  const guard = r.rejected.length + r.undefinedTools.length;
  const total = r.orphans.length + r.near.length + guard + r.stale.length + r.pending.length + r.gone.length;
  process.stdout.write(
    `فُحص ${r.scanned.facts} حقيقة حيّة في ${r.scanned.subjects} موضوعاً من ${r.scanned.notes} ملاحظة\n` +
      `  بلا ملاحظة ${r.orphans.length} · مفاتيح متقاربة ${r.near.length} · لا يراها مستخلص ${guard} · قديمة ${r.stale.length} · جلسات معلّقة ${r.pending.length} · نصّها مفقود ${r.gone.length}\n` +
      `${total ? `${total} بنداً للمراجعة` : "لا شيء للمراجعة ✓"} · ${path.relative(vault, r.file).replace(/\\/g, "/")}` +
      (r.commit ? ` · commit ${r.commit}` : "") +
      "\n",
  );
}

/**
 * `sila infer-digests [--dry-run] [--break-lock]` — see inferDigests. The dry
 * run names every note it would leave without one, and why.
 */
async function cmdInferDigests(): Promise<void> {
  const dryRun = bool("dry-run");
  let r: Awaited<ReturnType<typeof inferDigests>>;
  try {
    r = await inferDigests(loadConfig(vault), { dryRun, breakLock: bool("break-lock") });
  } catch (err) {
    if (err instanceof LockHeldError) {
      return void process.stdout.write(`${err.message}. لم يُكتب شيء. أعِد المحاولة، أو --break-lock إن كان القفل معلّقاً.\n`);
    }
    throw err;
  }
  const why = new Map<string, number>();
  for (const s of r.skipped) {
    const kind = s.why.replace(/ \(.*\)$/, "");
    why.set(kind, (why.get(kind) ?? 0) + 1);
  }
  process.stdout.write(
    `ملاحظات نموذج بلا بصمة ${r.candidates} · ${dryRun ? "ستُستنتَج" : "استُنتجت"} ${r.inferred.length} · تُركت ${r.skipped.length}` +
      (r.commit ? ` · commit ${r.commit}` : "") +
      "\n" +
      [...why].map(([k, n]) => `  ${n} — ${k}\n`).join("") +
      (dryRun ? r.skipped.map((s) => `    ${s.note}: ${s.why}\n`).join("") : ""),
  );
}

/**
 * Who reads a session that may leave the machine, for doctor. Same-provider
 * is the default for every wall, an unlisted folder and an unknown cwd, so
 * the first line is the agents' own CLIs, each with whether it is installed
 * and the model it is called with; the configured provider is said only for
 * the walls that opted out of same-provider, the one place it is used.
 */
function extractorLines(cfg: ReturnType<typeof loadConfig>): string[] {
  if (cfg.extractor.provider === "local") return ["الاستخلاص  محلي — لا نداء شبكة من أي نوع، ولا حقائق"];
  const clis = Object.entries(cfg.sources)
    .filter(([, root]) => root)
    .map(([k]) => CLI_FOR_AGENT[(k === "claudeCode" ? "claude-code" : k) as AgentId])
    .filter(Boolean);
  const lines = [
    `الاستخلاص  ما يغادر الجهاز يذهب إلى CLI وكيله: ${clis.map((n) => `${n} ${cliAvailable(n) ? "✓" : "— (جلساته تنتظر حتى يُثبَّت)"}`).join(" · ")}`,
    `           ${clis.map((n) => `${n}: ${cliModel(n, cfg) ?? "نموذجه الافتراضي"}`).join(" · ")}`,
  ];
  const open = cfg.walls.filter((w) => !w.localOnly && !w.sameProvider).map((w) => w.name);
  if (open.length) {
    const who =
      cfg.extractor.provider === "cli"
        ? `أول من يجيب من ${cfg.extractor.cliOrder.map((n) => `${n} ${cliAvailable(n) ? "✓" : "—"}`).join(" ← ")}`
        : `API Anthropic بـ${cfg.extractor.model} · ${process.env.ANTHROPIC_API_KEY ? "المفتاح ✓" : "بلا ANTHROPIC_API_KEY: تُكتب ملاحظتها محلياً، بلا حقائق"}`;
    lines.push(`           جدران بلا same-provider (${open.join("، ")}): ${who}`);
  }
  return lines;
}

async function cmdDoctor(): Promise<void> {
  announceMigration();
  const cfg = loadConfig(vault);
  process.stdout.write(`vault      ${vault}  ${fs.existsSync(vault) ? "✓" : "✗"}\n`);
  process.stdout.write(`git        ${fs.existsSync(path.join(vault, ".git")) ? "✓" : "✗"}\n`);
  // Where sessions go, as the scan sends them (destinationFor) — not the
  // config's provider and model, which on a fresh config named an API key
  // and a local fallback that no session would ever meet.
  for (const line of extractorLines(cfg)) process.stdout.write(`${line}\n`);
  for (const [k, root] of Object.entries(cfg.sources)) {
    if (!root) {
      process.stdout.write(`${k.padEnd(11)}— غير مهيأ\n`);
      continue;
    }
    const key = k === "claudeCode" ? "claude-code" : k;
    const adapter = ADAPTERS[key];
    const files = adapter ? await adapter.discover(root) : [];
    process.stdout.write(`${k.padEnd(11)}${files.length} ملف  ${root}\n`);
  }
  // The open-session rule skips silently; this is where it is seen working.
  const open = await openSessions(cfg);
  const perAgent = [...new Set(open.map((o) => o.agent))].map((a) => `${a} ${open.filter((o) => o.agent === a).length}`);
  process.stdout.write(`مفتوحة الآن ولا يقرؤها المسح: ${open.length ? `${open.length} — ${perAgent.join("، ")}` : "لا شيء"}\n`);
  const why = { mtime: "كُتب", busy: "دور يعمل، آخر سجل", quiet: "انتهى دوره" } as const;
  for (const o of open) {
    const ago = Math.round((Date.now() - o.lastMs) / 1000);
    process.stdout.write(`  ${o.agent.padEnd(12)}${why[o.why]} قبل ${ago < 120 ? `${ago} ث` : `${Math.round(ago / 60)} د`} · ${path.basename(o.file)}\n`);
  }
  // A session read again and again costs a call each time and looks fine
  // each time; only the count shows it.
  const rereads = frequentRereads(new Git(vault, cfg.git));
  if (rereads === null) {
    process.stdout.write(`أُعيد استخلاصها أكثر من ${REREAD_OVER} مرات في ${REREAD_DAYS} أيام: — بلا git\n`);
  } else if (!rereads.length) {
    process.stdout.write(`أُعيد استخلاصها أكثر من ${REREAD_OVER} مرات في ${REREAD_DAYS} أيام: لا شيء ✓\n`);
  } else {
    process.stdout.write(`\n⚠ أُعيد استخلاصها أكثر من ${REREAD_OVER} مرات في ${REREAD_DAYS} أيام: ${rereads.length}\n`);
    for (const r of rereads) process.stdout.write(`  ${String(r.count).padStart(3)} مرة · ${r.note}\n`);
  }
  if (!cfg.walls.length && cfg.extractor.provider !== "local") {
    process.stdout.write(
      `\n⚠ لا توجد "walls" معرّفة: كل جلسة يُعرف مجلدها ستُرسل إلى CLI وكيلها للتلخيص.\n  عرّف المجلدات الحسّاسة بـ localOnly: true قبل أول مسح كامل.\n`,
    );
  }
  // A live subject the guard now rejects is hidden from its project's
  // extractor, and no session can reach its facts again — said here, or it
  // goes silent. See rejectedLiveSubjects.
  if (fs.existsSync(path.join(vault, ".index", "memory.db"))) {
    const store = new Store(vault);
    const rejected = rejectedLiveSubjects(cfg, store);
    const undefinedTools = undefinedLiveTools(cfg, store);
    const gone = store.withoutTranscript();
    store.close();
    // A transcript that leaves the disk is never discovered again, so no scan
    // says a word about it; this is the one place that does.
    if (!gone.length) {
      process.stdout.write("جلسات ذهب نصّها من القرص: لا شيء ✓\n");
    } else {
      process.stdout.write(`\n⚠ جلسات ذهب نصّها من القرص: ${gone.length}\n`);
      const what: Record<string, string> = {
        ok: "ملاحظتها وحقائقها باقية",
        "pending-extraction": "كانت تنتظر الاستخلاص — لن تُقرأ",
        quarantined: "محجوبة — لن تُعاد",
      };
      for (const g of gone) {
        const when = (g.started_at ?? g.processed_at).slice(0, 10);
        process.stdout.write(`  ${when} · ${g.project} · ${g.id} · ${what[g.status] ?? g.status}\n      ${g.source_file || "(لا مسار مسجَّل)"}\n`);
      }
    }
    if (!rejected.length) {
      process.stdout.write("مواضيع حيّة يرفضها الحارس: لا شيء ✓\n");
    } else {
      process.stdout.write(`\n⚠ مواضيع حيّة يرفضها الحارس، ولا يراها مستخلص مشروعها: ${rejected.length}\n`);
      for (const r of rejected) process.stdout.write(`  ${r.subject} (${r.kind}) · ${r.facts} حقيقة · ${r.project} · ${r.why}\n`);
      process.stdout.write("  انقلها إلى موضوعها: sila move --plan <file.json>\n");
    }
    // A tool with no line saying what it admits is hidden the same way.
    if (!undefinedTools.length) {
      process.stdout.write("أدوات حيّة بلا تعريف: لا شيء ✓\n");
    } else {
      process.stdout.write(`\n⚠ أدوات حيّة بلا تعريف، لا يراها أي مستخلص: ${undefinedTools.length}\n`);
      for (const t of undefinedTools) process.stdout.write(`  ${t.subject} · ${t.facts} حقيقة · ${t.projects.join("، ")}\n`);
      process.stdout.write('  عرّفها في engine.config.json: "definitions": {"<الأداة>": "ما تقبله"} — أو انقلها: sila move --plan <file.json>\n');
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
