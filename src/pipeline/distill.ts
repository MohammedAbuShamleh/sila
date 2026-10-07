import type { RawSession, Turn } from "../types.js";

/**
 * Transcript → the part worth reading, under a hard character ceiling.
 *
 * The asymmetry here is the whole point: what the *user* typed is the scarce
 * signal, and what the assistant replied is mostly elaboration of it. A
 * session is remembered for "we're moving off Redis because of the eviction
 * bug", which the user said once, not for the four paragraphs that followed.
 * So user turns are kept whole and assistant turns are clipped hard.
 *
 * Trimming happens from the middle outward. The opening turns carry why the
 * work started and the closing turns carry where it ended up; the long middle
 * is iteration, which is exactly what a summary is allowed to lose.
 */

const ASSISTANT_CLIP = 1200;
const USER_CLIP = 6000;

export interface Distilled {
  text: string;
  userChars: number;
  turnCount: number;
  toolNames: string[];
  truncated: boolean;
}

export function distill(session: RawSession, maxChars: number): Distilled {
  const toolNames = new Set<string>();
  for (const t of session.turns) {
    if (t.tool) for (const name of t.tool.split(",")) if (name) toolNames.add(name);
  }

  const userChars = session.turns
    .filter((t) => t.role === "user")
    .reduce((n, t) => n + t.text.length, 0);

  const blocks = session.turns
    .filter((t): t is Turn => t.role === "user" || t.role === "assistant")
    .map((t) => {
      const label = t.role === "user" ? "المستخدم" : "الوكيل";
      const limit = t.role === "user" ? USER_CLIP : ASSISTANT_CLIP;
      return `### ${label}\n${clip(t.text, limit)}`;
    });

  const header = [
    `# جلسة ${session.agent}`,
    session.cwd ? `المجلد: ${session.cwd}` : "المجلد: غير معروف",
    session.startedAt ? `البداية: ${session.startedAt}` : "",
    toolNames.size ? `أدوات: ${[...toolNames].sort().join(", ")}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const budget = Math.max(0, maxChars - header.length);
  const { kept, truncated } = fitFromEnds(blocks, budget);

  return {
    text: `${header}${kept.join("\n\n")}`,
    userChars,
    turnCount: blocks.length,
    toolNames: [...toolNames].sort(),
    truncated,
  };
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\n{3,}/g, "\n\n").trim();
  if (flat.length <= limit) return flat;
  // Keep both ends of an over-long turn: a request often states the goal
  // first and the constraint last.
  const half = Math.floor((limit - 24) / 2);
  return `${flat.slice(0, half)}\n[…قُصّ…]\n${flat.slice(-half)}`;
}

/**
 * Fill the budget from the outside in, alternating front and back, so the
 * surviving text is a prefix plus a suffix with the middle elided.
 */
function fitFromEnds(blocks: string[], budget: number): { kept: string[]; truncated: boolean } {
  const total = blocks.reduce((n, b) => n + b.length + 2, 0);
  if (total <= budget) return { kept: blocks, truncated: false };

  const front: string[] = [];
  const back: string[] = [];
  let used = 0;
  let lo = 0;
  let hi = blocks.length - 1;
  let takeFront = true;

  while (lo <= hi) {
    const idx = takeFront ? lo : hi;
    const block = blocks[idx];
    if (block === undefined) break;
    const cost = block.length + 2;
    if (used + cost > budget) break;
    used += cost;
    if (takeFront) {
      front.push(block);
      lo++;
    } else {
      back.unshift(block);
      hi--;
    }
    takeFront = !takeFront;
  }

  const dropped = blocks.length - front.length - back.length;
  const marker = dropped > 0 ? [`### […حُذف ${dropped} دوراً من المنتصف…]`] : [];
  return { kept: [...front, ...marker, ...back], truncated: dropped > 0 };
}
