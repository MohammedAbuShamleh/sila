import type { Adapter } from "./base.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";

/**
 * The registry, and the only place that knows how many agents exist.
 *
 * Adding a fourth agent means one new file here and no change anywhere
 * downstream. If a change to `serve/` or `pipeline/` is ever needed to
 * support a new agent, the boundary has been broken somewhere.
 */
export const ADAPTERS: Record<string, Adapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};

/** Config keys are camelCase; adapter ids are kebab-case. */
export function adapterFor(sourceKey: string): Adapter | undefined {
  return ADAPTERS[sourceKey === "claudeCode" ? "claude-code" : sourceKey];
}
