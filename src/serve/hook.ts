import { readFileIfExists, writeFileAtomic } from "../util/fsatomic.js";

/**
 * The Claude Code session-end hook, written into the user's settings.json.
 *
 * Shape per the settings schema on this machine: `hooks.SessionEnd` is a list
 * of `{ hooks: [...] }` entries; a command hook with `args` runs in exec form
 * — the executable is spawned directly with that argv, no shell. That is the
 * only form that survives a home directory with a non-ASCII character in it,
 * and the reason the entry names node and the cli file by absolute path
 * instead of relying on `sila` being on PATH.
 *
 * Idempotent by marker: our entry is the one whose statusMessage is
 * HOOK_MARK. Install replaces it or adds it; uninstall removes exactly it.
 * Everything else in the file is preserved byte for byte in meaning — the
 * file is re-serialized, never rewritten from a template.
 */

// The engine's name before it was published as sila, kept on purpose: this
// mark is how install, uninstall and status find our entry in a
// settings.json that already has one. Renamed, every installed hook would
// be someone else's — install would add a second beside it, and uninstall
// would leave the first running.
export const HOOK_MARK = "memory-engine: scan";

export interface HookCommand {
  type: "command";
  command: string;
  args?: string[];
  timeout?: number;
  statusMessage?: string;
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

type Settings = Record<string, unknown>;

export function hookEntry(nodePath: string, cliPath: string): HookEntry {
  return {
    hooks: [
      {
        type: "command",
        command: nodePath,
        // --from-hook: the SessionEnd payload on stdin names the transcript
        // that just closed, and that is the file scanned; --limit 1 is the
        // fallback if the payload has no path. --detach: the hook must
        // return at once, or every `claude` exit waits for a scan. The scan
        // re-launches itself in the background and logs to
        // <vault>/.index/hook.log.
        args: [cliPath, "scan", "--agent", "claude-code", "--limit", "1", "--from-hook", "--detach"],
        timeout: 30,
        statusMessage: HOOK_MARK,
      },
    ],
  };
}

/**
 * Why the hook must not be installed from where this program runs, or null.
 *
 * The entry names this file by absolute path. Run through `npx`, that path
 * is inside npm's cache — `<cache>/_npx/<hash>/node_modules/…` — which npm
 * empties when it cleans the cache and replaces when it fetches the package
 * again, and the hook then fails at every session end with no one told. On
 * 2026-10-04, from the packed package: through npx the hook pointed into
 * npm-cache\_npx\…, through a global install at the install itself.
 */
export function npxInstall(cliPath: string, what: "hook" | "schedule" = "hook"): string | null {
  if (!/[\\/]_npx[\\/]/.test(cliPath)) return null;
  // The scheduled task carries the same absolute path, and fails the same way.
  const [holds, fails] =
    what === "hook"
      ? ["الـhook يكتب في settings.json مسار البرنامج الكامل", "فيفشل الـhook مع انتهاء كل جلسة دون أن يقول شيئاً."]
      : ["المهمة المجدولة تحمل مسار البرنامج الكامل", "فتفشل المهمة في كل دورة دون أن تقول شيئاً."];
  return [
    "رُفض التثبيت: البرنامج يعمل من ذاكرة npx المؤقتة:",
    `  ${cliPath}`,
    `${holds}، وهذا المجلد يُمسح حين ينظّف npm ذاكرته`,
    `ويُستبدل حين يجلب الحزمة من جديد، ${fails}`,
    "ثبّته تثبيتاً عاماً ثم أعد الأمر:",
    "  npm install -g sila-memory",
    `  sila ${what} install`,
  ].join("\n");
}

/**
 * The transcript a SessionEnd payload names.
 *
 * Every Claude Code hook receives `{ session_id, transcript_path, cwd,
 * hook_event_name, … }` on stdin. Only the path matters here, and anything
 * that is not that — an empty stdin, a payload from some other tool — is
 * null, so the scan falls back to `--limit 1` rather than failing the hook.
 */
export function transcriptFromHookPayload(raw: string): string | null {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown> | null;
    const t = payload && typeof payload === "object" ? payload["transcript_path"] : null;
    return typeof t === "string" && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

function isOurs(entry: unknown): entry is HookEntry {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as HookEntry).hooks;
  return Array.isArray(hooks) && hooks.some((h) => h && typeof h === "object" && h.statusMessage === HOOK_MARK);
}

function readSettings(file: string): Settings {
  const raw = readFileIfExists(file);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Settings;
  } catch {
    // A settings file Claude Code cannot parse silently disables everything
    // in it. Overwriting it would hide that; refusing makes the user look.
    throw new Error(`${file} ليس JSON صالحاً — لن أكتب فوقه`);
  }
}

function sessionEndList(settings: Settings): unknown[] {
  const hooks = (settings["hooks"] ??= {}) as Record<string, unknown>;
  if (!hooks || typeof hooks !== "object") throw new Error("حقل hooks ليس كائناً");
  const list = (hooks["SessionEnd"] ??= []);
  if (!Array.isArray(list)) throw new Error("hooks.SessionEnd ليس مصفوفة");
  return list;
}

export function installHook(settingsFile: string, nodePath: string, cliPath: string): { changed: boolean; entry: HookEntry } {
  const settings = readSettings(settingsFile);
  const list = sessionEndList(settings);
  const entry = hookEntry(nodePath, cliPath);
  const idx = list.findIndex(isOurs);
  if (idx >= 0) {
    if (JSON.stringify(list[idx]) === JSON.stringify(entry)) return { changed: false, entry };
    list[idx] = entry;
  } else {
    list.push(entry);
  }
  writeFileAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, entry };
}

export function uninstallHook(settingsFile: string): boolean {
  const settings = readSettings(settingsFile);
  const hooks = settings["hooks"];
  if (!hooks || typeof hooks !== "object") return false;
  const list = (hooks as Record<string, unknown>)["SessionEnd"];
  if (!Array.isArray(list)) return false;
  const kept = list.filter((e) => !isOurs(e));
  if (kept.length === list.length) return false;
  // Leave no empty husks behind; an empty hooks object reads as intent.
  if (kept.length) (hooks as Record<string, unknown>)["SessionEnd"] = kept;
  else delete (hooks as Record<string, unknown>)["SessionEnd"];
  if (!Object.keys(hooks as Record<string, unknown>).length) delete settings["hooks"];
  writeFileAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

export function hookStatus(settingsFile: string): HookEntry | null {
  const settings = readSettings(settingsFile);
  const hooks = settings["hooks"];
  if (!hooks || typeof hooks !== "object") return null;
  const list = (hooks as Record<string, unknown>)["SessionEnd"];
  if (!Array.isArray(list)) return null;
  return list.find(isOurs) ?? null;
}
