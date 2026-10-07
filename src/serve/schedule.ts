import os from "node:os";

/**
 * The periodic scan, as the operating system's own scheduler runs it.
 *
 * The session-end hook covers Claude Code and nothing else: Codex and Gemini
 * have no hook we can install, so their sessions sit unread until something
 * starts a scan. `sila watch` does that but needs a terminal left open. This
 * is the same job handed to the machine.
 *
 * Windows gets a real Scheduled Task, written as XML rather than assembled
 * from `schtasks` flags — `/RI` is rejected for a logon trigger, so "at
 * logon, then every fifteen minutes" is not expressible on the command line
 * at all. The XML says it directly, and also carries `Hidden`, which no flag
 * offers. Everywhere else the equivalent is printed for the user to install,
 * because writing into a user's launchd or crontab behind their back is not
 * ours to do.
 *
 * Collision with the hook is already handled: both take the vault lock, and
 * the loser says so and exits.
 */

// The engine's name before it was published as sila, kept on purpose: the
// task is found by this name to replace, query and delete it. Renamed, a
// task already registered would be orphaned — install would register a
// second one beside it, and uninstall would leave the first running.
export const TASK_NAME = "memory-engine scan";

/** Minutes between runs. Fifteen is short enough that a finished session is read while it still matters. */
export const DEFAULT_INTERVAL = 15;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The scan the scheduler runs.
 *
 * `--detach` so the task process returns at once and the work continues in
 * the background writing to `<vault>/.index/hook.log` — a scheduled task has
 * nowhere else to put its output, and a silent failing scan is worse than no
 * scan. The vault is named explicitly because a scheduled task does not
 * inherit the environment a terminal has, so `MEMORY_VAULT` would be unset.
 */
export function scanArgs(cliPath: string, vault: string): string[] {
  return [cliPath, "scan", "--vault", vault, "--detach"];
}

/**
 * What the scheduler starts on Windows: node inside a console host that draws
 * no window.
 *
 * `Hidden` hides the task from Task Scheduler's list, not its window. node is
 * a console program, the scheduler gives it a console, and Windows 11 shows
 * that console as a Windows Terminal window — every fifteen minutes. A window
 * monitor saw it the second the task first ran, 2026-09-24; the earlier check
 * had covered what the scan starts (windowsHide), not what starts the scan.
 * `conhost.exe --headless` hosts the console and shows nothing: a task running
 * node through it wrote its proof file and no window appeared, where the same
 * task running node directly opened WindowsTerminal and node.
 */
export function conhostPath(): string {
  return `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\conhost.exe`;
}

/** Local wall-clock time as Task Scheduler reads a StartBoundary with no offset. */
function localBoundary(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * A Task Scheduler definition: repeated indefinitely, hidden, and never
 * starting a second copy while one is still running.
 *
 * Two triggers, both learned from the first real registration on Windows 11.
 *
 * The logon trigger names its user. Without `<UserId>` it means "at logon of
 * any user", which only an administrator may register — a standard token got
 * "Access is denied" and nothing in the message pointed at the trigger.
 *
 * And the repetition cannot hang off the logon trigger alone: that registered
 * cleanly and then reported "Next Run Time: N/A", because a logon-bound
 * repetition starts at the *next* logon. Sessions left pending tonight would
 * wait for a reboot. The time trigger starts the cycle one interval after
 * install — not at once, so installing does not launch a scan over whatever
 * the user is about to run by hand — and, being calendar-based, it keeps
 * repeating across reboots. The logon trigger stays for the catch-up run
 * right after a logon.
 */
export function taskXml(
  nodePath: string,
  cliPath: string,
  vault: string,
  minutes = DEFAULT_INTERVAL,
  start: Date = new Date(Date.now() + minutes * 60_000),
): string {
  // `Arguments` is one string the scheduler re-splits on spaces, so anything
  // holding one is quoted — a vault under "OneDrive/My Documents" would
  // otherwise arrive as two arguments and the scan would run on the wrong
  // path, or on none.
  const args = ["--headless", nodePath, ...scanArgs(cliPath, vault)]
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ");
  const user = `${os.userInfo().username}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(TASK_NAME)} — يقرأ جلسات الوكلاء الجديدة ويحدّث الذاكرة</Description>
    <URI>\\${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localBoundary(start)}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT${minutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
      <Repetition>
        <Interval>PT${minutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(conhostPath())}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Task Scheduler reads the XML as Unicode; a UTF-8 file comes back as "the
 * task XML is malformed" with nothing to say which line. So the bytes are
 * UTF-16LE with a BOM, which is also why this does not go through
 * `writeFileAtomic` — that writes UTF-8, and this file never lives in the
 * vault anyway.
 */
export function taskXmlBytes(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

/** launchd and cron, for the platforms where we print rather than install. */
export function posixInstructions(nodePath: string, cliPath: string, vault: string, minutes = DEFAULT_INTERVAL): string {
  const cmd = [nodePath, ...scanArgs(cliPath, vault)].map((a) => (/\s/.test(a) ? `"${a}"` : a));
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sila-memory.scan</string>
  <key>ProgramArguments</key>
  <array>
${[nodePath, ...scanArgs(cliPath, vault).slice(1)].map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>StartInterval</key><integer>${minutes * 60}</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>`;

  return [
    "لا تثبيت تلقائي خارج ويندوز — لن أكتب في launchd أو crontab نيابةً عنك.",
    "",
    `## macOS — احفظه في ~/Library/LaunchAgents/com.sila-memory.scan.plist`,
    "",
    plist,
    "",
    "ثم:",
    "",
    "  launchctl load -w ~/Library/LaunchAgents/com.sila-memory.scan.plist",
    "  launchctl list | grep sila-memory     # للتحقق",
    "  launchctl unload -w ~/Library/LaunchAgents/com.sila-memory.scan.plist   # للإزالة",
    "",
    `## Linux — أضِفه بـ crontab -e`,
    "",
    `  */${minutes} * * * * ${cmd.join(" ")}`,
    "",
    "السجل في <vault>/.index/hook.log لأن الأمر يعمل بـ--detach.",
    "القفل يمنع التصادم مع hook أو مع sila watch: الثاني يُخبَر ويخرج.",
  ].join("\n");
}
