import fs from "node:fs";
import path from "node:path";
import { readJsonl } from "../adapters/base.js";

/**
 * The working directory of a session, read as cheaply as possible.
 *
 * A dry run has to answer one question honestly — "how many of these are
 * about to leave my machine?" — and that answer depends on the project cwd,
 * which only exists *inside* the transcript. Guessing from the transcript's
 * own folder path is worse than useless: it never matches a wall, so every
 * session reads as local and the user is reassured by a number that means
 * nothing.
 *
 * Parsing the whole file would make `--dry-run` as slow as a real scan, so
 * this reads only the opening records. All three formats put cwd at the top:
 * Claude Code repeats it on nearly every record, Codex puts it in the first
 * `session_meta`, and Gemini keeps it in a sibling file.
 */

const PROBE_RECORDS = 25;

export async function probeCwd(file: string, agent: string): Promise<string | null> {
  if (agent === "gemini") {
    const marker = path.join(path.dirname(path.dirname(file)), ".project_root");
    try {
      return fs.readFileSync(marker, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  let n = 0;
  for await (const rec of readJsonl(file)) {
    if (typeof rec["cwd"] === "string" && rec["cwd"]) return rec["cwd"] as string;
    const payload = rec["payload"];
    if (payload && typeof payload === "object") {
      const cwd = (payload as Record<string, unknown>)["cwd"];
      if (typeof cwd === "string" && cwd) return cwd;
    }
    if (++n >= PROBE_RECORDS) break;
  }
  return null;
}
