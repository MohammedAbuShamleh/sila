import type { Config, Destination } from "../config.js";
import { canonical, destinationFor, projectOf } from "../config.js";
import type { AgentId } from "../types.js";
import { probeCwd } from "./dryrun.js";
import { cliAvailable, cliModel, neutralCwd } from "./extract.js";

export interface DryRunCandidate {
  file: string;
  agent: string;
}

export interface DryRunFilter {
  project: string;
  /** Files the gate already set aside for belonging to another project. */
  skipped: number;
}

/**
 * One line per place the sessions would go, said as the scan sends them: an
 * agent's CLI with the model it is called with and whether it is installed
 * (a missing one leaves its sessions waiting — constant 12), or the API.
 */
function destinationLines(cfg: Config, sent: Map<string, { d: Destination; n: number }>): string[] {
  return [...sent.values()]
    .sort((a, b) => b.n - a.n)
    .map(({ d, n }) => {
      if (d.kind === "api") {
        const key = process.env["ANTHROPIC_API_KEY"] ? "المفتاح ✓" : "بلا ANTHROPIC_API_KEY: تُكتب ملاحظتها محلياً، بلا حقائق";
        return `  إلى API Anthropic ${n} — ${d.model} · ${key}`;
      }
      if (d.kind !== "cli") return "";
      if (d.clis.length > 1) {
        return `  إلى أول من يجيب من ${d.clis.map((c) => `${c} ${cliAvailable(c) ? "✓" : "—"}`).join(" ← ")} ${n}`;
      }
      const cli = d.clis[0]!;
      const model = cliModel(cli, cfg);
      const how = `${model ?? "نموذجه الافتراضي"}${cli === "claude" ? ` · effort ${cfg.extractor.effort}` : ""}`;
      return `  إلى ${cli} ${n} — ${how} · ${cliAvailable(cli) ? "مثبّت ✓" : "غير مثبّت: تنتظر حتى يُثبَّت"}`;
    });
}

/**
 * What a full run would do, without doing any of it.
 *
 * The network count is the number the user actually needs before a first full
 * scan, so it is computed from each session's real cwd rather than inferred.
 * It counts files, not sessions that will survive the minimum-length gate —
 * an over-estimate, which is the right direction for a number about egress,
 * and the line says "up to" because of it. The extractor's own sessions are
 * known from their cwd alone, so they are counted apart, never as sent.
 */
export async function reportDryRun(
  cfg: Config,
  all: number,
  todo: DryRunCandidate[],
  skippedUnchanged: number,
  filter: DryRunFilter | null = null,
  /** Transcripts still being written, left for the session-end hook — see OPEN_SESSION_MS in run. */
  skippedOpen = 0,
  /** The run's --limit, and how many changed transcripts it left past it — see leftAtLimit in run. */
  cap: { limit: number; left: number } = { limit: Infinity, left: 0 },
  /** Transcripts the gate knows to be too short, or the extractor's own, from their rows — see recordUnread in run. */
  known: { tiny: number; self: number } = { tiny: 0, self: 0 },
): Promise<void> {
  const byAgent = new Map<string, number>();
  const byProject = new Map<string, number>();
  const byCwd = new Map<string, { shown: string; n: number }>();
  const sent = new Map<string, { d: Destination; n: number }>();
  const self = canonical(neutralCwd());
  let network = 0;
  let local = 0;
  let selfNew = 0;
  let unknownProject = 0;

  for (const c of todo) {
    const cwd = await probeCwd(c.file, c.agent);
    // The scan reads none of these: they are its own extraction calls.
    if (cwd && canonical(cwd) === self) {
      selfNew++;
      continue;
    }
    byAgent.set(c.agent, (byAgent.get(c.agent) ?? 0) + 1);
    if (!cwd) unknownProject++;
    if (cwd) {
      // Grouped by canonical form so `C:\Users\X` and `c:/users/x` — which the
      // wall matcher already treats as one folder — count as one folder here.
      // The first spelling seen is the one displayed.
      const key = canonical(cwd);
      const entry = byCwd.get(key) ?? { shown: cwd, n: 0 };
      entry.n++;
      byCwd.set(key, entry);
    }
    const project = projectOf(cfg, cwd);
    byProject.set(project, (byProject.get(project) ?? 0) + 1);
    const d = destinationFor(cfg, c.agent as AgentId, cwd);
    if (d.kind === "local") {
      local++;
      continue;
    }
    network++;
    const label = d.kind === "api" ? "api" : d.clis.join(">");
    const entry = sent.get(label) ?? { d, n: 0 };
    entry.n++;
    sent.set(label, entry);
  }

  const lines = [
    `اكتُشف ${all} ملف · جديد أو متغيّر ${todo.length - selfNew} · دون تغيير ${skippedUnchanged}` +
      (known.tiny ? ` · قصيرة ${known.tiny}` : "") +
      (known.self + selfNew ? ` · ذاتية ${known.self + selfNew}` : "") +
      (skippedOpen ? ` · مفتوحة ${skippedOpen}` : "") +
      (cap.left ? ` · توقّف عند الحدّ ${cap.limit}، بقي ${cap.left}` : ""),
    ...(filter ? [`مرشّح: --project ${filter.project} · مستبعد بالمشروع ${filter.skipped}`] : []),
    "",
    ...[...byAgent].map(([agent, n]) => `  ${agent.padEnd(12)} ${n}`),
    "",
    `سيُلخَّص محلياً ${local} · سيُرسل حتى ${network}`,
    ...destinationLines(cfg, sent),
    ...(network ? [`  «حتى»: العدّ بالملفات، وما يقصر منها عن ${cfg.minUserChars} حرف من كلام المستخدم لا يُرسل.`] : []),
    cfg.walls.length ? `walls: ${cfg.walls.map((w) => w.name).join(", ")}` : "walls: غير معرّفة",
    "",
    "المشاريع:",
    ...[...byProject]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([p, n]) => `  ${p.padEnd(24)} ${n}`),
    "",
    // Every distinct working directory, in full and unabridged, because this
    // is the list the walls get written from. A project slug says nothing
    // about *where* a folder lives, and two folders can share a name.
    "المجلدات — كل cwd مميّز بعدد جلساته:",
    ...[...byCwd.values()]
      .sort((a, b) => b.n - a.n)
      .map((e) => `  ${String(e.n).padStart(4)}  ${e.shown}`),
  ];

  if (filter && !todo.length) {
    lines.push("", `لا جلسة جديدة تطابق --project ${filter.project}. جرّب --force لإعادة معالجة ما سبق.`);
  }
  if (unknownProject) {
    lines.push("", `${unknownProject} ملفاً بلا مجلد معروف — تُلخَّص محلياً وتذهب إلى "unsorted".`);
  }
  if (!cfg.walls.length && network) {
    lines.push(
      "",
      `⚠ لا walls معرّفة: كل جلسة يُعرف مجلدها تُرسل إلى CLI وكيلها — حتى ${network} في هذا التشغيل.`,
      "  عرّف المجلدات الحسّاسة بـ localOnly: true قبل إزالة --dry-run.",
    );
  }
  lines.push("", "لا شيء كُتب. أزل --dry-run للتنفيذ.", "");

  process.stdout.write(lines.join("\n"));
}
