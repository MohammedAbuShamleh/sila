import assert from "node:assert/strict";
import { ConfigSchema, destinationFor, sameProviderFor } from "../test-build/config.js";
import { allowedClis, cliAvailable, extractNote } from "../test-build/pipeline/extract.js";

/**
 * Constant 12: extraction must not widen the circle of who has seen the data.
 *
 * The runner seam replaces the real CLI spawn and records every provider the
 * extractor asks. That record is the proof: under a same-provider wall it
 * holds exactly the session's own agent, and when that one fails it still
 * holds nothing else.
 */

const cfg = ConfigSchema.parse({
  vault: "/tmp/policy-test",
  sources: {},
  walls: [
    // No sameProvider given: the default must be the strict one.
    { name: "acme", paths: ["D:/Acme/acme"], localOnly: false },
    { name: "open", paths: ["D:/open"], localOnly: false, sameProvider: false },
  ],
  extractor: { provider: "cli", cliOrder: ["claude", "gemini"] },
});

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    process.stdout.write(`\n✗ ${name}\n  ${err.message.split("\n")[0]}\n`);
  }
}

const session = (agent, cwd) => ({
  id: `${agent}:1`,
  agent,
  sourceFile: "x.jsonl",
  cwd,
  startedAt: null,
  endedAt: "2026-09-15T00:00:00.000Z",
  turns: [{ role: "user", text: "نص طويل بما يكفي ليكون جلسة حقيقية. ".repeat(12) }],
  contentHash: "1:1",
});
const distilled = { text: "…", userChars: 400, turnCount: 1, toolNames: [], truncated: false };
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, model: "x" };
const good = { text: JSON.stringify({ title: "عنوان", summary: "", facts: [] }), usage };

/** A runner that records who was asked and answers per name. */
function spy(answer) {
  const calls = [];
  const runner = async (name) => {
    calls.push(name);
    return answer(name);
  };
  return { calls, runner };
}

// ---- policy lookup -------------------------------------------------------

await check("same-provider is the default for a listed wall, an unlisted folder and no cwd", () => {
  assert.equal(sameProviderFor(cfg, "D:/Acme/acme/backend"), true, "جدار مدرج بلا الحقل ليس same-provider");
  assert.equal(sameProviderFor(cfg, "D:/somewhere/never/listed"), true, "مجلد غير مدرج ليس same-provider");
  assert.equal(sameProviderFor(cfg, null), true, "cwd مجهول ليس same-provider");
  assert.equal(sameProviderFor(cfg, "D:/open"), false, "false صريح لم يُحترم");
});

await check("allowedClis names exactly the session's own CLI under same-provider", () => {
  assert.deepEqual(allowedClis(cfg, "codex", true), ["codex"]);
  assert.deepEqual(allowedClis(cfg, "gemini", true), ["gemini"]);
  assert.deepEqual(allowedClis(cfg, "claude-code", true), ["claude"]);
  assert.deepEqual(allowedClis(cfg, "claude-code", false), ["claude", "gemini"], "بدون same-provider يجب أن يعود cliOrder");
});

// ---- the guarantee -------------------------------------------------------

await check("a same-provider codex session reaches codex and nothing else", async () => {
  const { calls, runner } = spy(() => good);
  const r = await extractNote({
    session: session("codex", "D:/Acme/acme"),
    distilled,
    redactedText: "…",
    cfg,
    useModel: true,
    sameProvider: true,
    runner,
  });
  assert.deepEqual(calls, ["codex"], `سُئل مزوّد آخر: ${calls}`);
  assert.equal(r.usedModel, true);
  assert.equal(r.pending, undefined, "عُلّقت جلسة نجحت");
  assert.equal(r.note.title, "عنوان");
});

await check("when the session's own CLI fails, nothing else is tried and the session is pending", async () => {
  const { calls, runner } = spy(() => {
    throw new Error("فشل مصطنع");
  });
  const r = await extractNote({
    session: session("codex", "D:/Acme/acme"),
    distilled,
    redactedText: "…",
    cfg,
    useModel: true,
    sameProvider: true,
    runner,
  });
  assert.deepEqual(calls, ["codex"], `بعد الفشل سُئل غيره: ${calls}`);
  assert.ok(r.pending, "لم تُعلَّق");
  assert.match(r.pending, /codex: فشل مصطنع/, "سبب التعليق لا يسمّي المزوّد والخطأ");
  assert.equal(r.usedModel, false);
  assert.equal(r.degradedReason, undefined, "عُوملت كتراجع محلي لا كتعليق");
});

await check("a gemini session under same-provider never reaches claude even though cliOrder starts with it", async () => {
  const { calls, runner } = spy(() => good);
  await extractNote({
    session: session("gemini", "D:/Acme/acme"),
    distilled,
    redactedText: "…",
    cfg,
    useModel: true,
    sameProvider: true,
    runner,
  });
  assert.deepEqual(calls, ["gemini"], `cliOrder تجاوز الجدار: ${calls}`);
});

await check("without same-provider the configured order is walked, with fallback", async () => {
  const { calls, runner } = spy((name) => {
    if (name === "claude") throw new Error("مشغول");
    return good;
  });
  const r = await extractNote({
    session: session("gemini", "D:/open"),
    distilled,
    redactedText: "…",
    cfg,
    useModel: true,
    sameProvider: false,
    runner,
  });
  assert.deepEqual(calls, ["claude", "gemini"], "لم يتبع cliOrder");
  assert.equal(r.usedModel, true, "لم يكمل إلى البديل المسموح");
});

await check("a session that may not use the network asks no provider at all", async () => {
  const { calls, runner } = spy(() => good);
  const r = await extractNote({
    session: session("claude-code", "D:/Acme/acme"),
    distilled,
    redactedText: "…",
    cfg,
    useModel: false,
    sameProvider: true,
    runner,
  });
  assert.deepEqual(calls, [], "سُئل مزوّد لجلسة محلية");
  assert.equal(r.usedModel, false);
  assert.equal(r.pending, undefined);
});

// What doctor and the dry run say is destinationFor; a fresh config sends
// every session with a folder to its own agent's CLI, whatever the provider
// and model fields say — those are for a wall that opts out of same-provider.
await check("destinationFor says what the scan does: on a fresh config each session goes to its agent's CLI, never the API", () => {
  const fresh = ConfigSchema.parse({ vault: "/tmp/policy-fresh", sources: {} });
  assert.equal(fresh.extractor.provider, "anthropic", "الافتراضي تغيّر — راجع ما يقوله doctor");
  assert.deepEqual(destinationFor(fresh, "claude-code", "D:/somewhere"), { kind: "cli", clis: ["claude"] });
  assert.deepEqual(destinationFor(fresh, "codex", "D:/somewhere"), { kind: "cli", clis: ["codex"] });
  assert.deepEqual(destinationFor(fresh, "gemini", "D:/somewhere"), { kind: "cli", clis: ["gemini"] });
  assert.deepEqual(destinationFor(fresh, "codex", null), { kind: "local" }, "جلسة بلا مجلد غادرت");
  // The configured provider, only behind a wall that opted out.
  assert.deepEqual(destinationFor(cfg, "codex", "D:/open"), { kind: "cli", clis: ["claude", "gemini"] });
  assert.deepEqual(destinationFor(cfg, "codex", "D:/Acme/acme"), { kind: "cli", clis: ["codex"] });
  assert.deepEqual(destinationFor(cfg, "codex", "D:/never/listed"), { kind: "local" }, "مجلد خارج الجدران غادر");
  const api = ConfigSchema.parse({ vault: "/tmp/policy-api", sources: {}, walls: [{ name: "open", paths: ["D:/open"], localOnly: false, sameProvider: false }] });
  assert.deepEqual(destinationFor(api, "codex", "D:/open"), { kind: "api", model: api.extractor.model });
  const local = ConfigSchema.parse({ vault: "/tmp/policy-local", sources: {}, extractor: { provider: "local" } });
  assert.deepEqual(destinationFor(local, "claude-code", "D:/somewhere"), { kind: "local" });
});

await check("an absent CLI resolves as unavailable, never as something else", () => {
  assert.equal(cliAvailable("memory-engine-no-such-cli-xyz"), false);
});

process.stdout.write(`\npolicy: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
