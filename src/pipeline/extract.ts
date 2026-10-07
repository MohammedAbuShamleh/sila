import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Distilled } from "./distill.js";
import type { AgentId, CliName, RawSession, SessionNote, Usage } from "../types.js";
import { CLI_FOR_AGENT } from "../types.js";
import { indexable } from "../util/arabic.js";
import { ensureDir } from "../util/fsatomic.js";
import { partOfProject } from "./reconcile.js";
import { redact } from "./redact.js";

/**
 * Distilled text → a note worth reading in six months.
 *
 * Three paths, one output type. The API path calls Anthropic with a key. The
 * CLI path runs an installed agent CLI in print mode as a bare model call —
 * the user's own login, no key. The local path never touches the network and
 * is the one a `localOnly` wall gets forever, so it has to produce something
 * honestly useful: it keeps the user's own sentences rather than inventing
 * structure it cannot infer.
 *
 * Which path runs is decided by the walls in config.ts, never here — this
 * module is told, not asked. Under a same-provider wall it is told exactly
 * one CLI, and when that one cannot answer it reports *pending* rather than
 * trying anything else: constant 12.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The schema rescues, it does not reject.
 *
 * A model reply is one JSON object for a whole session, and a single odd
 * value in it — a port number where a sentence was expected — used to fail
 * the entire note, which under a same-provider wall meant the session was
 * retried on every scan and never landed. So a string field takes a number
 * and keeps it as text, and a list drops the one item that does not parse,
 * says so on stderr, and keeps the rest. What is still fatal is a reply with
 * no JSON object in it at all.
 */

/** A string the model may hand back as a number or a boolean. */
const Str = z.preprocess((v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v), z.string());
const NonEmpty = Str.pipe(z.string().trim().min(1));

/** Items dropped by the parse in progress; drained by parseNote. */
const dropped: string[] = [];

/** A list that loses its broken items, never the note around it. */
function lenient<T extends z.ZodTypeAny>(item: T, field: string): z.ZodEffects<z.ZodDefault<z.ZodArray<z.ZodUnknown>>, z.infer<T>[]> {
  return z
    .array(z.unknown())
    .default([])
    .transform((arr) => {
      const out: z.infer<T>[] = [];
      for (const raw of arr) {
        const r = item.safeParse(raw);
        if (r.success) out.push(r.data as z.infer<T>);
        else dropped.push(`${field}: ${JSON.stringify(raw)?.slice(0, 120)} — ${r.error.issues[0]?.message ?? "?"}`);
      }
      return out;
    });
}

const FactSchema = z.object({
  subject: NonEmpty,
  subjectKind: z.enum(["person", "project", "org", "term", "tool"]).catch("term"),
  key: NonEmpty,
  claim: NonEmpty,
  confidence: z.coerce.number().min(0).max(1),
});

const DecisionSchema = z.object({ what: NonEmpty, why: Str.optional() });

const NoteSchema = z.object({
  title: Str.default(""),
  project: Str.default(""),
  summary: Str.default(""),
  did: lenient(NonEmpty, "did"),
  decisions: lenient(DecisionSchema, "decisions"),
  rejected: lenient(DecisionSchema, "rejected"),
  open: lenient(NonEmpty, "open"),
  facts: lenient(FactSchema, "facts"),
  links: lenient(z.object({ from: NonEmpty, to: NonEmpty, relation: Str.default("related") }), "links"),
  // What memory holds and this session proved false. A *changed* fact needs
  // no entry here — restating it under the same key supersedes it. This is
  // only for a claim with no successor.
  retract: lenient(z.object({ subject: NonEmpty, key: NonEmpty, reason: Str.default("") }), "retract"),
  // The model owns only the two fields a transcript cannot state about
  // itself. Files and the resume command are filled in by the pipeline from
  // what the adapter saw.
  resume: z.preprocess(
    (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
    z.object({ where: Str.default(""), next: Str.default("") }),
  ),
});

/**
 * What a tool subject admits, by name — said beside it wherever the model is
 * offered it.
 *
 * A tool's name does not say where it ends. `tooling` was offered by name
 * alone and read as "anything general-shaped": 4fb58e98 filed under it a
 * gotcha about a script the session itself had written for one project's audit.
 * That was the second concept handed to the model without a definition —
 * the subject was the first — so the definition is a condition here, not a
 * habit: a tool subject with none is not offered at all (factsContext), and
 * `sila doctor` names it. These are the engine's own; a vault adds or
 * overrides in `definitions` of engine.config.json (definitionsFor).
 *
 * tooling's line goes by where a gotcha shows up, not by who made the tool.
 * The first line went by the maker — "tools the session did not write" —
 * and named Laravel among them, so 476578b4 filed under tooling that a full
 * test run wipes the project's local database for want of a .env.testing: an external tool,
 * and a fact about one project's files. The user's rule, 2026-09-24,
 * replacing that one rather than adding an exception to it.
 *
 * The two examples at the end mark the edge the rule itself does not
 * settle — a common setting against a project's own thing. The daily log
 * driver writing dated files was filed under tooling by fd8840ef, and the
 * user kept it there on 2026-09-25: any Laravel project on `daily` falls
 * into it, a common setting, not a trait of the project. The test wipe
 * names a database and a file of this project, and that is the difference.
 */
const TOOLING =
  "لمطبّ يظهر مع الأداة في أي مشروع. مطبّ يظهر في هذا المشروع وحده بسبب ملفاته أو قاعدته أو إعداده ← المشروع، ولو كانت الأداة خارجية. «git diff -- path يفشل صامتاً» ← tooling. «سائق سجلات daily يكتب ملفات مؤرخة لا laravel.log» ← tooling: إعداد شائع يقع فيه أي مشروع. «php artisan test يمسح acme_local لغياب .env.testing» ← acme: يسمّي شيئاً من المشروع نفسه.";

export const DEFINITIONS: Readonly<Record<string, string>> = { tooling: TOOLING };

/** Said right above the slots the extractor is shown — see factsContext. */
export const SLOTS_LINE = "هذه الخانات موجودة. إن كان ادعاؤك يخص إحداها، استخدم مفتاحها حرفياً ولا تشتق منه مفتاحاً جديداً.";

export function definitionsFor(cfg: Pick<Config, "definitions">): Record<string, string> {
  return { ...DEFINITIONS, ...cfg.definitions };
}

/**
 * What memory already holds about this project, as the extractor sees it.
 *
 * Without this the model cannot tell "the code has no lock" from "the code
 * had no lock and this session built one" — it reports the problem it read
 * about, and the vault fills with solved problems recorded as current state.
 * Keys are shown so a change lands on the existing slot instead of opening a
 * near-duplicate beside it.
 *
 * Every key is shown; the claim, only for the `max` slots nearest the
 * session. The cap used to fall on slots — the first 40 by subject and key —
 * so a reading in the largest project saw 40 of 223, all `<project>.arch.*`, and never a
 * `decision.*` or a `tooling` key: the old key behind each of the five drifts
 * counted by 2026-09-24 was live and not shown. The rule since (the user's,
 * 2026-09-24): keys are never cut; if the context grows too long, claims are.
 * Nearness is `indexable()` on both sides, as `sila search` does it (see
 * nearest).
 *
 * The project's name and every live subject come first, uncapped — they are
 * what a new fact should be filed under. With no word of them, a session
 * read against an empty memory named a subject after each file, class or
 * audit item it touched.
 *
 * A live subject the guard would reject as new — named like a file, a class,
 * a ticket or a folder of the project (partOfProject, with the project
 * root's `folders`) — is not shown at all: not on that list, and not in the
 * facts. It is history, not an example; shown, it taught its name back to
 * every later reading, which is how a repository's server folder grew to 23 facts. The cost:
 * a session cannot supersede or withdraw what it is not shown, so such a
 * subject is for `sila move`, not for the next reading. A tool or a person
 * keeps a class-like, dotted or folder-like spelling, a path never.
 *
 * A tool is offered with the line that says what it admits (DEFINITIONS), or
 * not at all — the same way, name and facts: its name alone is what taught
 * `tooling` a script of the project's own.
 */
export function factsContext(
  facts: Array<{ subject: string; key: string; claim: string; subject_kind?: string }>,
  project = "",
  max = 40,
  folders: readonly string[] = [],
  definitions: Readonly<Record<string, string>> = DEFINITIONS,
  sessionText = "",
): string {
  if (!facts.length && !project) return "";
  const tools = new Set(facts.filter((f) => f.subject_kind === "tool").map((f) => f.subject));
  const definedOrNotTool = (s: string) => !tools.has(s) || !!definitions[s]?.trim();
  const entity = (f: { subject: string; subject_kind?: string }) =>
    f.subject === project || (partOfProject(f.subject, f.subject_kind, folders) === null && definedOrNotTool(f.subject));
  const offered = facts.filter(entity);
  const subjects = [...new Set(offered.map((f) => f.subject))].slice(0, 60);
  const definedTools = subjects.filter((s) => s !== project && tools.has(s));
  const near = new Set(nearest(offered, sessionText, max));
  const lines = offered.filter((f) => near.has(f)).map((f) => `- ${f.subject}.${f.key}: ${f.claim}`);
  const keysOnly = offered.filter((f) => !near.has(f)).map((f) => `- ${f.subject}.${f.key}`);
  return [
    "## ما تعرفه الذاكرة الآن",
    "",
    ...(project ? [`المشروع: ${project}`] : []),
    ...(subjects.length ? [`المواضيع الحيّة: ${subjects.join("، ")}`] : []),
    ...(definedTools.length
      ? ["ما تقبله كل أداة منها، ولا يدخلها غيره:", ...definedTools.map((t) => `- ${t}: ${definitions[t]?.trim()}`)]
      : []),
    "أعد استخدام أحد هذه المواضيع؛ لا تنشئ موضوعاً جديداً إن كان القائم يفي. حقيقة عن جزء من المشروع — ملف أو كلاس أو بند — تذهب إلى المشروع بمفتاح يصف الجزء.",
    ...(offered.length
      ? [
          "",
          "إن غيّرت الجلسة واحدة منها فأخرج الجديد بنفس المفتاح؛ وإن أبطلتها بلا بديل فأخرجها في retract؛ وما لم تمسّه الجلسة لا تذكره.",
          "أعد استخدام مفاتيح الموضوع الموجودة أدناه؛ لا تنشئ مفتاحاً يشبه مفتاحاً حيّاً — `arch.reconciliation` بجوار `arch.reconcile` خانتان لشيء واحد.",
          "",
          // Directly above the slots. No guard in the code — the user's call,
          // 2026-09-24: the line's effect is measured first, now that every
          // key it speaks of is on the list below it.
          SLOTS_LINE,
          ...lines,
          ...(keysOnly.length ? ["", "وبقية الخانات الحيّة، بمفاتيحها دون ادعاءاتها:", ...keysOnly] : []),
        ]
      : []),
  ].join("\n");
}

/**
 * The `n` facts whose key and claim share the most with the session's text,
 * weighted by how rare each shared word is among the facts — so a word every
 * claim of one project carries says nothing, and `pathspec` says a lot. `indexable()`
 * on both sides, as `sila search` does: normalized, and «ال» stripped, so
 * «الاستضافة» in a session finds «استضافه» in a claim. Ties keep the given
 * order, so an empty session text gives the first `n`.
 */
function nearest<T extends { key: string; claim: string }>(facts: readonly T[], text: string, n: number): T[] {
  if (facts.length <= n) return [...facts];
  const words = (s: string) => new Set(indexable(s).split(" ").filter((w) => w.length >= 3));
  const session = words(text);
  const bags = facts.map((f) => words(`${f.key} ${f.claim}`));
  const df = new Map<string, number>();
  for (const b of bags) for (const w of b) df.set(w, (df.get(w) ?? 0) + 1);
  const score = (b: Set<string>) => {
    let s = 0;
    for (const w of b) if (session.has(w)) s += Math.log(1 + facts.length / (df.get(w) ?? 1));
    return s;
  };
  return facts
    .map((f, i) => ({ f, i, s: score(bags[i] ?? new Set<string>()) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .map((x) => x.f);
}

/** A validated reply → the note shape the rest of the pipeline speaks. */
function toNote(parsed: z.infer<typeof NoteSchema>): SessionNote {
  const { resume, ...rest } = parsed;
  return {
    ...rest,
    // A note needs a line to be listed by; the summary's first sentence is
    // the next best thing the model gave.
    title: parsed.title.trim() || firstSentence(parsed.summary) || "جلسة بلا عنوان",
    project: parsed.project || "",
    resume: { where: resume.where, next: resume.next, files: [], resumeCommand: null },
  };
}

/**
 * Reply text → note. Throws only when there is no JSON object to read;
 * everything short of that is rescued, and what was dropped is reported
 * under `label` so a bad reply is visible in the scan output, not silent.
 */
export function parseNote(text: string, label: string): SessionNote {
  dropped.length = 0;
  const parsed = NoteSchema.parse(firstJsonObject(text));
  for (const d of dropped.splice(0)) process.stderr.write(`${label}: أُسقط عنصر تالف من ${d}\n`);
  return toNote(parsed);
}

/**
 * The prompt is the product here.
 *
 * Everything else in this repo is mechanism; this text decides whether the
 * vault is worth opening. Three rules in it do most of the work:
 *
 *   - A subject is a lasting entity people know by name: a project, a
 *     person, a general tool. The prompt never said so until 2026-09-18,
 *     when re-reading 35 sessions scattered their facts from 14 subjects
 *     over 86 — audit item ids, class names, file names — each a subject
 *     file of its own and a heading of its own in the brief.
 *   - A fact must occupy a single-valued slot, and the slot's name comes from
 *     a closed lexicon. "stack" is not a key, because two true answers can
 *     share it and the reconciler would then treat two truths as a
 *     contradiction. "stack.backend" is a key. The lexicon exists because the
 *     first live run filed one fact under three names (storage,
 *     storage-backend, arch.storage) and the reconciler saw three facts.
 *   - 1.0 is not available to the model. It marks what a human confirmed via
 *     `sila accept`, and reserving it is what keeps a confident-sounding
 *     inference from overwriting something the user actually said.
 */
export const SYSTEM = `أنت مستخلص ذاكرة. تقرأ جلسة عمل واحدة بين مستخدم ووكيل برمجي، وتُخرج ما يستحق أن يُتذكَّر بعد ستة أشهر.

اكتب بالعربية. أسماء الملفات والدوال والتقنيات تبقى بالإنجليزية كما هي.

## ما يستحق التذكّر
- قرار وسببه. «اخترنا X لأن Y» أغلى من «اخترنا X».
- ما رُفض ولماذا — يمنع إعادة اقتراحه.
- تفضيل دائم للمستخدم في طريقة العمل.
- حقيقة ثابتة عن مشروع أو شخص أو مصطلح.
- ما بقي معلّقاً في نهاية الجلسة.

## ما لا يستحق
- خطوات التنفيذ ومخرجات الأدوات ونتائج الأوامر.
- ما هو مقروء من الكود نفسه أو من git.
- أحداث الجلسة الجارية («قرأنا الملف»، «شغّلنا الاختبار»).
- المجاملات والمقدّمات.

## الحقائق
الحقيقة ما لا يعرفه الوكيل بقراءة الكود: قرار وسببه، مرفوض وسببه، شخص ودوره، قيد، عُرف. وصف ما يفعله الكود ليس حقيقة — «يستخدم SQLite مع FTS5» يقرؤه الوكيل من الملف بنفسه، فلا تكتبه. رأي أو نقد ليس حقيقة — «التوفيق هشّ لأنه يطابق المفتاح حرفياً» نقد، لا حقيقة؛ إن تطلّب فعلاً يذهب إلى \`open\`، وإلا يُهمَل.

حالة عابرة ليست حقيقة — تسجيل دخول، فرع لم يُدمج، اختبار معلّق، نداء فشل. الحقيقة ما يبقى صحيحاً بعد أسبوع. «\`claude.exe\` غير مسجَّل الدخول فتعذّر التشغيل الحي» حالة جلسة، لا قيد؛ وإن اختلطت بحقيقة باقية في جملة واحدة فاكتب الباقية وحدها — «\`claude -p\` يُستدعى من مجلد محايد بلا أدوات». وإن كانت الحالة تتطلّب فعلاً في نهاية الجلسة فمكانها \`resume.next\` أو \`open\`.

ما هو مكتوب في \`engine.config.json\` أو أي ملف إعداد (\`package.json\`، \`settings.json\`، \`.env.example\`، \`tsconfig\`) ليس حقيقة — الوكيل يقرؤه من الملف. الحقيقة هي *لماذا* ضُبط هكذا، إن قيل.

أثمن أنواع الحقائق: \`gotcha.<noun>\` — حلّ التفافي وسبب فشل الطريق الواضح. مثال: \`gotcha.claude-cli\` ← «\`--safe-mode\` لا \`--bare\`، لأن \`--bare\` يطلب مفتاح API ويُبطل تسجيل دخول المستخدم». كل مرة تعثّر فيها الوكيل ثم وجد المخرج، هذه حقيقة تستحق 0.85 على الأقل لأنها ظهرت في مخرج فعلي.

كل حقيقة تحتل خانة واحدة: subject + key. الشرط الحاسم أن الخانة **أحادية القيمة** — لا يصح أن يكون لها جوابان صحيحان في وقت واحد، لأن أي جواب ثانٍ يُعتبر تعارضاً ويستبدل الأول. وخانة واحدة تحمل قيمة واحدة: شيئان مختلفان = مفتاحان. «القاعدة SQLite والبحث FTS5» ليست حقيقة واحدة بل \`stack.db\` و\`stack.search\`.

المفتاح من هذا المعجم المغلق حرفياً، لا من عندك — مفتاح مختلف لنفس المعنى يفتح خانة ثانية والنظام يراهما حقيقتين:
- \`stack.backend\`، \`stack.frontend\`، \`stack.db\`، \`stack.search\`
- \`deploy.host\`، \`deploy.ci\`
- \`arch.<noun>\` — قرار معماري باسم واحد، مثل \`arch.storage\`، \`arch.auth\`
- \`convention.<noun>\` — عُرف في العمل، مثل \`convention.commits\`، \`convention.language\`
- \`decision.<noun>\` — قرار غير معماري، مثل \`decision.pricing\`
- \`person.<name>.role\` — دور شخص، مثل \`person.sara.role\`
- \`constraint.<noun>\` — قيد ثابت، مثل \`constraint.budget\`، \`constraint.offline\`
- وإن لم يناسب شيء مما سبق: \`misc.<noun>\` باسم واحد، مثل \`misc.timezone\`.

\`<noun>\` كلمة إنجليزية واحدة بأحرف صغيرة. لا تخترع مفاتيح مثل \`stack\` أو \`tools\` أو \`notes\` — تحتمل عدة قيم صحيحة معاً وليست خانة.

**الموضوع** كيان دائم له اسم يعرفه البشر: مشروع، شخص، أو أداة خارجية. ليس موضوعاً: اسم ملف أو كلاس أو دالة، رقم بند أو تذكرة، مفهوم داخل المشروع. حقيقة عن جزء من مشروع تنتمي للمشروع بمفتاح يصف الجزء — لا لموضوع جديد باسم ذلك الجزء.

الموضوع \`tooling\` (subjectKind: tool): ${TOOLING}

مثال: \`BillingService\` و\`X9-42\` و\`CLAUDE.md\` ليست مواضيع؛ الصواب \`acme.arch.billing-service\`.

subjectKind واحد من: project، person، tool.

confidence تُحدَّد بالدليل داخل الجلسة، لا بشعورك. ثلاث مراسٍ فقط:
- 0.95 — قاله المستخدم نصاً. مثال: كتب المستخدم «القاعدة عندنا Postgres 16» ← \`stack.db\` بثقة 0.95.
- 0.85 — ظهر في كود أو مخرج أداة داخل الجلسة، لا في كلام المستخدم. مثال: \`package.json\` المعروض فيه \`"next": "15.1"\` ← \`stack.frontend\` بثقة 0.85.
- 0.6 — استنتاج من سياق الجلسة دون نص صريح. مثال: الوكيل كتب migrations بصيغة Laravel ولم يعلّق المستخدم ← \`stack.backend\` بثقة 0.6.
- لا تستخدم 1.0 أبداً. هي محفوظة لما يؤكّده الإنسان بنفسه عبر \`sila accept\`.
- لا قيم بين المراسي. إن تردّدت بين مرساتين فاختر الأدنى.

الحقيقة تصف الحالة في نهاية الجلسة لا ما ذُكر فيها. مشكلة طُرحت وحُلّت في الجلسة نفسها ← الحل هو الحقيقة أو لا شيء، والمشكلة لا تُسجَّل أبداً. طُرحت ولم تُحل ← \`open\` لا حقيقة. مثال: النقد قال «لا قفل على المسح» وبُني القفل في الجلسة ← \`arch.concurrency\`: «قفل ملف على المسح، واحد لكل مخزن»، لا «لا يوجد قفل». ومثال معاكس: النقد قال «لا بحث دلالي» ولم يُبنَ ولم يُقرَّر شيء ← لا حقيقة، وإن كان مطلوباً فـ\`open\`.

المصفوفة الفارغة جواب صحيح ومتوقع، لا فشل. أغلب الجلسات لا تحمل حقيقة واحدة تستحق، و\`facts: []\` و\`decisions: []\` و\`rejected: []\` هي الجواب الطبيعي لها. وصف الكود لا يملأ خانة حقيقة حتى لو لم يوجد غيره — لا تملأ الحقول لأنها موجودة. مثال: جلسة يعرض فيها المستخدم نقداً لتصميم مشروع ولا يُتّخذ فيها قرار ← \`facts: []\`، والنقد إن احتاج فعلاً يذهب إلى \`open\`. قائمة فارغة أفضل من حقيقة مخترعة.

## الاستئناف
- where: أين توقفت الجلسة بالضبط — آخر شيء كان يجري حين انتهت، لا ملخص الجلسة.
- next: الخطوة التالية بالضبط، جملة واحدة يستطيع من يفتح الجلسة غداً تنفيذها فوراً.
إن كانت الجلسة مكتملة بلا خطوة تالية، اكتب next: "لا شيء — اكتملت".

## ما تعرفه الذاكرة الآن
قد تُعطى قبل نص الجلسة قائمة بما تحمله الذاكرة عن هذا المشروع، ومعها اسم المشروع ومواضيع المخزن الحيّة. أعد استخدام هذه المواضيع — لا تنشئ موضوعاً جديداً إن كان القائم يفي. كل أداة منها معروضة مع ما تقبله؛ ما لا يطابقه لا يدخلها ولو شابهها. وعامل الحقائق هكذا:
- غيّرت الجلسة قيمة خانة ← أخرج الحقيقة الجديدة **بنفس المفتاح** حرفياً. لا تخترع مفتاحاً جديداً لشيء له مفتاح.
- أبطلت الجلسة خانة بلا بديل (حُلّت المشكلة، أو زال القيد، أو تبيّن أن الادعاء خطأ) ← أخرجها في \`retract\` بمفتاحها وسببها. لا تُخرجها في \`facts\`.
- لم تمسّ الجلسة خانة ← لا تذكرها إطلاقاً. إعادة ذكر ما هو معروف ضجيج.

\`retract\` للإبطال بلا بديل فقط. ما له بديل يُخرج في \`facts\` بنفس المفتاح، والاستبدال يحدث تلقائياً.

## الصيغة
أرجع كائن JSON واحداً فقط، بلا أي نص قبله أو بعده، وبلا علامات كود:

{
  "title": "سطر واحد يميّز الجلسة",
  "summary": "جملتان على الأكثر",
  "did": ["ما أُنجز فعلاً"],
  "decisions": [{"what": "القرار", "why": "السبب"}],
  "rejected": [{"what": "ما رُفض", "why": "السبب"}],
  "open": ["ما بقي معلّقاً"],
  "resume": {"where": "أين وقفت الجلسة", "next": "الخطوة التالية بالضبط"},
  "facts": [{"subject": "...", "subjectKind": "project", "key": "...", "claim": "...", "confidence": 0.9}],
  "retract": [{"subject": "...", "key": "...", "reason": "لماذا لم تعد صحيحة"}],
  "links": [{"from": "...", "to": "...", "relation": "..."}]
}`;

export interface CliReply {
  text: string;
  usage: Usage;
}

/**
 * Test seam. When supplied it replaces the real CLI spawn for every name, so
 * a test can record which providers were asked and prove that a same-provider
 * session never reaches a different one.
 */
export type CliRunner = (name: CliName, input: string, cfg: Config) => Promise<CliReply>;

export interface ExtractResult {
  note: SessionNote;
  usedModel: boolean;
  usage: Usage | null;
  /** Set when the model was permitted but could not be used and a local note stands in. */
  degradedReason?: string;
  /**
   * Set when the session's own CLI could not answer under a same-provider
   * wall. Nothing stands in: the session must be tried again later, and the
   * note returned alongside must not be written.
   */
  pending?: string;
  /** Model calls this reading took: two when a garbled reply was asked for again. */
  calls?: number;
  /** Both replies, when neither could be read — for the scan to keep, not to parse. */
  garbled?: string[];
}

/**
 * A reply whose JSON began but cannot be read — cut off, or garbled. The one
 * failure worth asking again. After the second, it carries both replies, so
 * the scan can keep them where a person can see what broke.
 */
export class UnreadableReply extends Error {
  replies: string[] = [];
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    model: b.model,
    ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
    ...(b.cli ?? a.cli ? { cli: b.cli ?? a.cli } : {}),
  };
}

/**
 * One extraction call, read as a note. A reply whose JSON was cut off or
 * garbled is asked for once more: 3 of the first full scan's 173 calls came
 * back so, and 2952933d on 2026-09-23, and the second call answered whole —
 * the call failed, not the session. Said on stderr so a retried reading is
 * visible, and both calls are counted and paid for. A second garbled reply
 * fails as the first would have; a reply with no JSON at all, or with JSON
 * of the wrong shape, is not asked again.
 */
async function readReply(call: () => Promise<CliReply>, label: string): Promise<{ note: SessionNote; usage: Usage; calls: number }> {
  const first = await call();
  try {
    return { note: parseNote(first.text, label), usage: first.usage, calls: 1 };
  } catch (err) {
    if (!(err instanceof UnreadableReply)) throw err;
    process.stderr.write(`${label}: ${err.message} — أُعيد النداء مرة واحدة\n`);
  }
  const second = await call();
  try {
    return { note: parseNote(second.text, label), usage: addUsage(first.usage, second.usage), calls: 2 };
  } catch (err) {
    if (!(err instanceof UnreadableReply)) throw err;
    const twice = new UnreadableReply(`${err.message} مرتين`);
    twice.replies = [first.text, second.text];
    throw twice;
  }
}

/**
 * A failure as its provider worded it, whole. Cut at 160 characters, codex's
 * limit notice of 2026-09-26 lost its last clause, "try again at 8:43 PM" —
 * the one part of it worth reading. It is kept in the session's row and in
 * `_inbox/pending.md`, so it passes the redactor, as everything bound for the
 * vault does; and onto one line, since it is printed as one.
 */
function failureText(err: unknown): string {
  return redact(String(err instanceof Error ? err.message : err).replace(/\s+/g, " ").trim()).text;
}

/**
 * The CLIs a session may be sent to, in order.
 *
 * Same-provider means exactly one — the CLI of the vendor that has already
 * seen this session. Otherwise the configured order, first to last.
 */
export function allowedClis(cfg: Config, agent: AgentId, sameProvider: boolean): CliName[] {
  return sameProvider ? [CLI_FOR_AGENT[agent]] : [...cfg.extractor.cliOrder];
}

export async function extractNote(args: {
  session: RawSession;
  distilled: Distilled;
  redactedText: string;
  cfg: Config;
  useModel: boolean;
  sameProvider: boolean;
  /** What memory already holds, from `factsContext`. Empty for a first session. */
  context?: string;
  runner?: CliRunner;
}): Promise<ExtractResult> {
  const { session, distilled, cfg, useModel, sameProvider, runner } = args;

  if (!useModel) return { note: localNote(session, distilled), usedModel: false, usage: null };

  // The context is vault content, already scrubbed on its way in; it is run
  // through the redactor again because nothing reaches a provider unredacted,
  // and it cannot quarantine the session — a finding here would be in a note
  // the user already has.
  const redactedText = args.context
    ? `${redact(args.context).text}\n\n---\n\n## نص الجلسة\n\n${args.redactedText}`
    : args.redactedText;

  if (sameProvider) {
    // One provider, no second choice, no local stand-in. A failure here is
    // not a degraded note — it is a session that has not been read yet.
    try {
      const reply = await readReply(() => callCli(redactedText, cfg, allowedClis(cfg, session.agent, true), runner), session.id);
      return { note: reply.note, usedModel: true, usage: reply.usage, calls: reply.calls };
    } catch (err) {
      return {
        note: localNote(session, distilled),
        usedModel: false,
        usage: null,
        pending: failureText(err),
        ...(err instanceof UnreadableReply && err.replies.length ? { garbled: err.replies } : {}),
      };
    }
  }

  try {
    const reply = await readReply(
      () =>
        cfg.extractor.provider === "cli"
          ? callCli(redactedText, cfg, allowedClis(cfg, session.agent, false), runner)
          : callModel(redactedText, cfg),
      session.id,
    );
    return { note: reply.note, usedModel: true, usage: reply.usage, calls: reply.calls };
  } catch (err) {
    // A failed extraction must not lose the session. It falls back to the
    // local note, which still records what the user said, and the reason is
    // surfaced in the scan summary rather than swallowed.
    return {
      note: localNote(session, distilled),
      usedModel: false,
      usage: null,
      degradedReason: failureText(err),
      ...(err instanceof UnreadableReply && err.replies.length ? { garbled: err.replies } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// API path
// ---------------------------------------------------------------------------

async function callModel(input: string, cfg: Config): Promise<CliReply> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY غير موجود");

  const body = {
    model: cfg.extractor.model,
    max_tokens: 16000,
    // The system prompt is byte-identical on every call, so it is the one
    // thing here worth caching. Note that a prefix under the model's minimum
    // cacheable size simply won't cache — silently, by design; check
    // cache_read_input_tokens if you want to know whether it took.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: cfg.extractor.effort },
    messages: [{ role: "user", content: input }],
  };

  const res = await fetchWithRetry(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as Record<string, unknown>;

  // Check why generation stopped before trusting what it produced.
  if (json["stop_reason"] === "refusal") {
    throw new Error("رفض النموذج المعالجة (stop_reason: refusal)");
  }

  const content = Array.isArray(json["content"]) ? (json["content"] as unknown[]) : [];
  const text = content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .filter((b) => b["type"] === "text")
    .map((b) => String(b["text"] ?? ""))
    .join("\n")
    .trim();
  if (!text) throw new Error("رد فارغ من النموذج");

  return { text, usage: usageFrom(json["usage"], typeof json["model"] === "string" ? (json["model"] as string) : cfg.extractor.model) };
}

/** Retries only what is worth retrying: rate limits, 5xx, and dropped sockets. */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      const detail = (await res.text()).slice(0, 300);
      if (!retryable || i === attempts - 1) {
        throw new Error(`HTTP ${res.status}: ${detail}`);
      }
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** i * 1000);
      continue;
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      await sleep(2 ** i * 1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// CLI path
// ---------------------------------------------------------------------------

/**
 * Where a CLI call runs from: an empty directory of its own.
 *
 * Every agent CLI reads context from its working directory — CLAUDE.md,
 * GEMINI.md, AGENTS.md, project settings, hooks. Running from the vault or
 * from a project would silently feed that context into every extraction. An
 * empty temp directory has none of it.
 */
// The engine's name before it was published as sila, kept on purpose: a
// session whose cwd is this folder is the extractor's own, and is never
// read. Renamed, every call made before would sit in a folder no longer
// recognised — and after a reindex, which keeps no row for them, those
// sessions would be read and sent as if a person had had them.
const NEUTRAL_DIR = path.join(os.tmpdir(), "memory-engine-cli");

export function neutralCwd(): string {
  ensureDir(NEUTRAL_DIR);
  return NEUTRAL_DIR;
}

const exeCache = new Map<string, string | null>();

/** Whether a CLI can be run on this machine. */
export function cliAvailable(name: string): boolean {
  return resolveExe(name) !== null;
}

/**
 * What to hand spawn(): the bare name, never the path `where` printed.
 *
 * `where.exe` writes in the console code page, not UTF-8, so a home directory
 * with a non-ASCII character in it comes back mangled and the "resolved" path
 * does not exist. The OS resolves a bare name through PATH with the correct
 * encoding, so `where` is consulted only for two facts that survive the
 * mangling: that the command exists, and what extension it has — a native
 * .exe takes an argv array with no shell, which is what keeps a multi-line
 * Arabic system prompt intact; an npm .cmd shim needs the shell.
 */
function resolveExe(name: string): string | null {
  const cached = exeCache.get(name);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  try {
    const out = execFileSync(process.platform === "win32" ? "where.exe" : "which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (out.some((p) => /\.exe$/i.test(p))) found = name;
    else if (out.some((p) => /\.(cmd|bat)$/i.test(p))) found = `${name}.cmd`;
    else if (out.length) found = name;
  } catch {
    found = null;
  }
  exeCache.set(name, found);
  return found;
}

/**
 * Try the given CLIs in order; the first that answers wins.
 *
 * A CLI that is not installed is skipped silently; one that is installed and
 * fails is skipped with its reason kept, so that when every one of them fails
 * the caller sees why for each rather than "cli failed". Under a same-provider
 * wall the list has one entry, so "in order" means "this one or nothing".
 */
async function callCli(input: string, cfg: Config, order: CliName[], runner?: CliRunner): Promise<CliReply> {
  const reasons: string[] = [];
  for (const name of order) {
    const exe = runner ? name : resolveExe(name);
    if (!exe) {
      reasons.push(`${name}: غير مثبّت`);
      continue;
    }
    try {
      const reply = runner ? await runner(name, input, cfg) : await runOne(name, exe, input, cfg);
      return { ...reply, usage: { ...reply.usage, cli: name } };
    } catch (err) {
      reasons.push(`${name}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
  throw new Error(reasons.join(" | ") || "لا مزوّد cli مضبوط");
}

async function runOne(name: CliName, exe: string, input: string, cfg: Config): Promise<CliReply> {
  const model = cliModel(name, cfg);
  const shell = /\.cmd$|\.bat$/i.test(exe);
  const { args, stdin } = cliCall(name, input, cfg);

  const { stdout, stderr, code } = await runProcess(exe, args, stdin, shell);
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`خرج بالرمز ${code}: ${stderr.trim()}`);
  }
  return parseCliOutput(name, stdout, model ?? name);
}

/** The model a CLI is called with; none means its own default. Exported so doctor and the dry run name the same one. */
export function cliModel(name: CliName, cfg: Config): string | undefined {
  return cfg.extractor.cliModels[name] ?? (name === "claude" ? cfg.extractor.model : undefined);
}

/**
 * The command line and stdin of one extraction call. Exported so a test pins
 * the flags that keep a call from becoming a session on disk — one the next
 * scan would find, and the agent's own app would list.
 */
export function cliCall(name: CliName, input: string, cfg: Config): { args: string[]; stdin: string } {
  const model = cliModel(name, cfg);
  let args: string[];
  let stdin: string;

  switch (name) {
    case "claude":
      // A bare model call, per `claude --help` on this machine (2.1.251):
      //   --safe-mode        no CLAUDE.md, skills, plugins, hooks, MCP; auth
      //                      still works — unlike --bare, which would demand
      //                      an API key and defeat the point of this path
      //   --tools ""         no tools at all
      //   --system-prompt    *replaces* the default prompt with ours
      //   --no-session-persistence
      //                      these calls must not become sessions on disk,
      //                      or the next scan would discover and read them
      args = [
        "-p",
        "--output-format",
        "json",
        "--safe-mode",
        "--strict-mcp-config",
        "--tools",
        "",
        "--no-session-persistence",
        "--system-prompt",
        SYSTEM,
        "--effort",
        cfg.extractor.effort,
        ...(model ? ["--model", model] : []),
      ];
      stdin = input;
      break;

    case "gemini":
      // `gemini --help` (0.59.0): -p runs headless and is *appended* to stdin,
      // -o json for a single object, --approval-mode plan for read-only. No
      // system-prompt flag exists, so ours goes first on stdin. Arguments are
      // kept space-free because the npm shim needs a shell on Windows.
      //
      // --skip-trust ("Trust the current workspace for this session"): the
      // neutral temp directory is not in ~/.gemini/trustedFolders.json, and
      // an untrusted folder makes gemini override --approval-mode and exit
      // 55 before reading stdin. Trusting it for the call only — rather than
      // writing the temp path into the user's trust file — keeps this
      // process from editing a security list it does not own.
      args = ["-p", "JSON-only.", "-o", "json", "--approval-mode", "plan", "--skip-trust", ...(model ? ["-m", model] : [])];
      stdin = `${SYSTEM}\n\n---\n\n${input}`;
      break;

    case "codex":
      // Per `codex exec --help` on this machine (0.157.1), and run live:
      //   --skip-git-repo-check  the neutral temp directory is no repository
      //   --sandbox read-only    the call has nothing to write
      //   --ephemeral            "Run without persisting session files to
      //                          disk". Without it each call left a rollout
      //                          in ~/.codex/sessions and a thread in the
      //                          app's list — six on 2026-09-26. One call
      //                          with it the same day: no rollout, no thread.
      //   --json                 events as JSONL, the last of them the turn's
      //                          token usage — without it the reply is bare
      //                          text and a codex call counted zero tokens
      // No prompt argument, so exec reads the prompt from stdin.
      args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--json", ...(model ? ["-m", model] : [])];
      stdin = `${SYSTEM}\n\n---\n\n${input}`;
      break;
  }

  return { args, stdin };
}

export function parseCliOutput(name: CliName, stdout: string, model: string): CliReply {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("مخرج فارغ");

  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    try {
      obj = firstJsonObject(trimmed) as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }

  if (name === "claude" && obj) {
    // `--output-format json` → one result object: result, is_error, usage,
    // total_cost_usd. An error still comes back as JSON, with the message in
    // `result`, so check before reading it as an answer.
    // Observed live: an auth failure arrives as subtype "success" with
    // is_error true, so the subtype is not what names the failure.
    const subtype = String(obj["subtype"] ?? "");
    if (obj["is_error"] === true || subtype.startsWith("error")) {
      const label = subtype.startsWith("error") ? subtype : "خطأ";
      throw new Error(`${label}: ${String(obj["result"] ?? "")}`);
    }
    const result = obj["result"];
    const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
    const usage = usageFrom(obj["usage"], model);
    if (typeof obj["total_cost_usd"] === "number") usage.costUsd = obj["total_cost_usd"] as number;
    return { text, usage };
  }

  if (name === "gemini" && obj) {
    // `-o json` → { response, stats }. Token accounting differs by version, so
    // only the text is trusted; usage stays zero rather than guessed.
    const text = typeof obj["response"] === "string" ? (obj["response"] as string) : trimmed;
    return { text, usage: usageFrom(null, model) };
  }

  if (name === "codex") {
    const events = codexEvents(trimmed);
    if (events) return codexReply(events, model);
  }

  // Any unrecognised shape: the note JSON is somewhere in the text.
  return { text: trimmed, usage: usageFrom(null, model) };
}

/** `codex exec --json` output as its events, or null when it is not that — an older CLI's bare text. */
function codexEvents(stdout: string): Array<Record<string, unknown>> | null {
  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const e: unknown = JSON.parse(line);
      if (e && typeof e === "object" && !Array.isArray(e) && typeof (e as Record<string, unknown>)["type"] === "string") {
        events.push(e as Record<string, unknown>);
      }
    } catch {
      /* not an event line */
    }
  }
  return events.some((e) => e["type"] === "thread.started" || e["type"] === "turn.completed") ? events : null;
}

/**
 * The reply and its cost out of `codex exec --json` — 0.157.1, seen live:
 *
 *   {"type":"thread.started","thread_id":…}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":…}}
 *   {"type":"turn.completed","usage":{"input_tokens":18196,"cached_input_tokens":8192,
 *     "cache_write_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":0}}
 *
 * `input_tokens` counts the cached ones too; Usage keeps them apart, as the
 * claude CLI reports them, so input means the same thing whoever answered.
 * Reasoning is inside `output_tokens` (the rollouts' total is input plus
 * output). No price: the CLI names none, and none is guessed. A failed turn
 * (`turn.failed`, or an `error` event — shapes not yet seen live) is thrown
 * with its message, as a failed claude reply is.
 */
function codexReply(events: Array<Record<string, unknown>>, model: string): CliReply {
  const failed = events.find((e) => e["type"] === "turn.failed" || e["type"] === "error");
  if (failed) {
    const err = failed["error"] && typeof failed["error"] === "object" ? (failed["error"] as Record<string, unknown>) : failed;
    throw new Error(`${String(failed["type"])}: ${String(err["message"] ?? JSON.stringify(failed))}`);
  }
  const said = events
    .filter((e) => e["type"] === "item.completed")
    .map((e) => (e["item"] && typeof e["item"] === "object" ? (e["item"] as Record<string, unknown>) : {}))
    .filter((item) => item["type"] === "agent_message" && typeof item["text"] === "string")
    .pop();
  if (!said) throw new Error("لا رسالة من الوكيل في مخرج codex");
  const done = events.filter((e) => e["type"] === "turn.completed").pop();
  const u = (done?.["usage"] && typeof done["usage"] === "object" ? done["usage"] : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const cached = num(u["cached_input_tokens"]);
  return {
    text: said["text"] as string,
    usage: {
      inputTokens: Math.max(0, num(u["input_tokens"]) - cached),
      outputTokens: num(u["output_tokens"]),
      cacheReadTokens: cached,
      cacheWriteTokens: num(u["cache_write_input_tokens"]),
      model,
    },
  };
}

function runProcess(
  exe: string,
  args: string[],
  stdin: string,
  shell: boolean,
  timeoutMs = 240_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // The child must be a clean model call: no API key, so the user's login
    // is what gets billed, and none of the variables a parent Claude Code
    // session sets — a nested launch is refused otherwise.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];
    for (const k of Object.keys(env)) if (k.startsWith("CLAUDECODE") || k.startsWith("CLAUDE_CODE_")) delete env[k];

    // windowsHide: a scan started by the hook or the scheduler runs detached,
    // with no console of its own, and every console program it starts would
    // otherwise open a window of its own on the user's screen.
    const child = spawn(exe, args, { cwd: neutralCwd(), env, shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`مهلة ${timeoutMs / 1000}s انتهت`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? -1,
      });
    });
    child.stdin.on("error", () => {
      /* the child may exit before reading everything; its exit code speaks */
    });
    child.stdin.end(Buffer.from(stdin, "utf8"));
  });
}

function usageFrom(raw: unknown, model: string): Usage {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    inputTokens: num(u["input_tokens"]),
    outputTokens: num(u["output_tokens"]),
    cacheReadTokens: num(u["cache_read_input_tokens"]),
    cacheWriteTokens: num(u["cache_creation_input_tokens"]),
    model,
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Pull the first balanced JSON object out of a reply.
 *
 * Assistant prefill is not available on current models, so the reply cannot be
 * forced to begin mid-JSON; it may arrive fenced or with a sentence in front.
 * Brace counting is used rather than a regex because braces nest, and it is
 * string-aware because a claim can legitimately contain `{`.
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("لا JSON في الرد");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (err) {
          throw new UnreadableReply(`JSON تالف في الرد: ${String(err instanceof Error ? err.message : err).slice(0, 80)}`);
        }
      }
    }
  }
  throw new UnreadableReply("JSON غير مكتمل في الرد");
}

/**
 * The offline note.
 *
 * It claims nothing it cannot see. Facts are not extracted at all, because
 * inferring a slot from raw text without a model is guesswork, and a wrong
 * fact is worse than a missing one — it would occupy the slot and have to be
 * argued out later. What it does preserve is the user's own words, which is
 * what `sila search` needs to find the session again.
 */
export function localNote(session: RawSession, distilled: Distilled): SessionNote {
  const userTurns = session.turns.filter((t) => t.role === "user" && t.text.trim());
  const first = userTurns[0]?.text.trim() ?? "";
  const title = firstSentence(first) || `جلسة ${session.agent}`;

  const asks = userTurns
    .map((t) => firstSentence(t.text.trim()))
    .filter((s) => s.length > 12)
    .slice(0, 12);

  const summary = [
    `جلسة ${session.agent}`,
    session.cwd ? `في ${session.cwd}` : "",
    `· ${distilled.turnCount} دوراً`,
    distilled.toolNames.length ? `· أدوات: ${distilled.toolNames.slice(0, 8).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    title: title.slice(0, 120),
    project: "",
    summary,
    did: asks,
    decisions: [],
    rejected: [],
    open: [],
    facts: [],
    links: [],
    // Where and next need a reader; without a model, the last thing the user
    // typed is the most honest "where" there is.
    resume: {
      where: userTurns.length ? firstSentence(userTurns[userTurns.length - 1]?.text ?? "") : "",
      next: "",
      files: [],
      resumeCommand: null,
    },
  };
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.search(/[.!?؟۔]\s|\n/);
  return (cut > 0 ? flat.slice(0, cut) : flat).slice(0, 160).trim();
}
