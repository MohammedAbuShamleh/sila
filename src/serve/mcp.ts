#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { defaultVault } from "../config.js";
import { Store } from "../store/db.js";
import { buildBrief } from "./brief.js";
import { readFileIfExists } from "../util/fsatomic.js";

/**
 * The single retrieval surface.
 * Read-only on purpose. An agent may consult the memory; only the scan
 * pipeline and the human may change it.
 */

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

async function main() {
  const vault = process.env.MEMORY_VAULT ?? defaultVault();
  const store = new Store(vault);

  const server = new McpServer({ name: "sila", version: "0.1.0" });

  // 1. memory_get_brief
  server.registerTool(
    "memory_get_brief",
    {
      title: "موجز المشروع",
      description:
        "اقرأ ذاكرة مشروع قبل بدء العمل: ما هو صحيح الآن، ما هو معلّق، وآخر القرارات. نادي هذه الأداة أولاً في أي جلسة جديدة قبل أن تسأل المستخدم عن سياق المشروع.",
      inputSchema: z.object({
        project: z.string().describe("اسم المشروع، أو اسم مجلد العمل"),
      }),
      annotations: READ_ONLY,
    },
    async ({ project }) => {
      const known = store.recentSessions(project, 1).length > 0;
      if (!known) {
        const names = store.subjects().slice(0, 20).map((s) => s.subject);
        return text(
          `لا ذاكرة لمشروع "${project}".\nالمعروف: ${names.join(", ") || "لا شيء"}\nجرّب memory_list_subjects أو memory_search.`,
        );
      }
      return text(buildBrief(store, vault, project, 6000));
    }
  );

  // 2. memory_search
  server.registerTool(
    "memory_search",
    {
      title: "بحث في الجلسات",
      description:
        "ابحث في كل الجلسات السابقة عبر كل الوكلاء (Claude Code، Codex، Gemini). يدعم العربية بلا تشكيل، ومع أو بدون أل التعريف. استخدمها حين يشير المستخدم لشيء سابق دون شرحه.",
      inputSchema: z.object({
        query: z.string().describe("كلمات مفتاحية، لا جملة كاملة"),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, project, limit }) => {
      const rows = store.search(query, limit, project);
      if (!rows.length) {
        return text(
          `لا نتائج لـ "${query}". جرّب كلمة أقصر، أو أزل قيد المشروع، أو memory_list_subjects.`,
        );
      }
      return text(
        rows
          .map((r) => `## ${r.title}\n${r.project} · ${r.session_id}\n${r.snippet.replace(/\s+/g, " ")}`)
          .join("\n\n"),
      );
    }
  );

  // 3. memory_get_subject
  server.registerTool(
    "memory_get_subject",
    {
      title: "ما يُعرف عن موضوع",
      description:
        "كل ما هو معروف عن شخص أو مشروع أو مصطلح، مع ما كان صحيحاً سابقاً ومتى تغيّر.",
      inputSchema: z.object({
        subject: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ subject }) => {
      const live = store.liveFacts(subject);
      if (!live.length) {
        const near = store.subjects().filter((s) => s.subject.includes(subject) || subject.includes(s.subject));
        return text(
          near.length
            ? `لا شيء باسم "${subject}". أقرب: ${near.map((n) => n.subject).join(", ")}`
            : `لا شيء باسم "${subject}". جرّب memory_list_subjects.`,
        );
      }
      const lines = [`# ${subject}`, "", ...live.map((f) => `- **${f.key}**: ${f.claim}  (${f.created_at.slice(0, 10)})`)];
      // Superseded and retracted are served together: to an agent both mean
      // "do not rely on this", and the distinction is only for the human
      // reading the subject file.
      const old = store.db
        .prepare(
          `SELECT key, claim, superseded_at, retracted_at FROM facts
             WHERE subject = ? AND (superseded_by IS NOT NULL OR retracted_at IS NOT NULL)
             ORDER BY COALESCE(superseded_at, retracted_at) DESC LIMIT 15`,
        )
        .all(subject) as Array<{ key: string; claim: string; superseded_at: string | null; retracted_at: string | null }>;
      if (old.length) {
        lines.push(
          "",
          "## كان صحيحاً سابقاً — لا تعتمد عليه",
          ...old.map((o) =>
            o.retracted_at
              ? `- ~~${o.key}: ${o.claim}~~ (سُحب ${o.retracted_at.slice(0, 10)})`
              : `- ~~${o.key}: ${o.claim}~~ (حتى ${(o.superseded_at ?? "").slice(0, 10)})`,
          ),
        );
      }
      return text(lines.join("\n"));
    }
  );

  // 4. memory_list_subjects
  server.registerTool(
    "memory_list_subjects",
    {
      title: "كل المواضيع",
      description: "اسرد كل الأشخاص والمشاريع والمصطلحات المعروفة.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      const rows = store.subjects().slice(0, limit);
      return text(
        rows.length
          ? rows.map((s) => `${s.subject} (${s.subject_kind}) — ${s.n}`).join("\n")
          : "المخزن فارغ. شغّل `sila scan` أولاً.",
      );
    }
  );

  // 5. memory_read_session
  server.registerTool(
    "memory_read_session",
    {
      title: "قراءة جلسة",
      description: "اقرأ ملاحظة جلسة كاملة بمعرّفها من memory_search.",
      inputSchema: z.object({
        session_id: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ session_id }) => {
      const row = store.db.prepare("SELECT note_path, status FROM sessions WHERE id = ?").get(session_id) as
        | { note_path: string | null; status: string }
        | undefined;
      if (!row) return text(`لا جلسة بالمعرّف "${session_id}".`);
      // Recorded so the scan does not read them again, never noted.
      if (row.status === "empty") return text(`الجلسة "${session_id}" أقصر من أن تُقرأ — لا ملاحظة لها.`);
      if (row.status === "skipped") return text(`الجلسة "${session_id}" من جلسات المستخلِص نفسه — لا ملاحظة لها.`);
      const md = row.note_path ? readFileIfExists(path.join(vault, row.note_path)) : null;
      return text(md ?? `الجلسة مسجّلة لكن ملاحظتها مفقودة.`);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server reads; it calls no model, so it names none — the extractor's
  // model here once read as the model answering.
  process.stderr.write(`sila MCP جاهز · ${vault} · للقراءة فقط\n`);
}

main().catch((err) => {
  console.error("Failed to run MCP server:", err);
  process.exit(1);
});