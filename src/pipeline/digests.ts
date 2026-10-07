import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { adapterFor } from "../adapters/index.js";
import { Store } from "../store/db.js";
import { Git } from "../store/git.js";
import type { InferredDigest } from "../store/vault.js";
import { noteExtractor, parseFactsTrailer, withInferredDigest } from "../store/vault.js";
import { readFileIfExists, sha256, writeFileAtomic } from "../util/fsatomic.js";
import { acquireLock } from "../util/lock.js";
import { distill } from "./distill.js";

export interface InferResult {
  /** Model notes with no digest of either kind. */
  candidates: number;
  inferred: Array<{ note: string; session: string; size: number; readAt: string }>;
  skipped: Array<{ note: string; why: string }>;
  commit: string | null;
}

/**
 * How long a scan may run between writing a session's row and committing its
 * note. The longest seen was a scan put to sleep with the machine, 7,614
 * seconds; a row written longer before its note's commit is not taken for
 * that reading's.
 */
const READING_SPAN_MS = 12 * 3_600_000;

/**
 * `sila infer-digests`: an inferred digest — «بصمة مُستنتَجة» — for every model
 * note written before the trailer carried the digest of its text, without a
 * call. It says the text is what it was at the last reading, as far as we
 * know; not that it was read now (see InferredDigest). The user's word,
 * 2026-09-30, in place of paying a reading each time an old transcript's
 * mtime is set back.
 *
 * "As far as we know" is three things, all required, each one's absence a
 * named skip:
 *   - the note's last commit that is a reading ("scan…") is the reading its
 *     index row remembers: the row was written before that commit and within
 *     a scan's span of it — a row rewritten later without the note, as by a
 *     local reading that left a model note standing, fails;
 *   - no revert touched the note after that reading, which would have put an
 *     older reading's note back under a newer row;
 *   - the transcript is as long now as the row says it was then: these files
 *     only grow, and the batches that move their mtime do not change a byte.
 * The digest is of what today's adapter distils from the file, which is what
 * the scan compares; the adapter may have changed since the reading, and the
 * digest does not claim otherwise.
 *
 * Only the trailer changes; the note is otherwise left byte for byte. Under
 * the scan's lock, and one commit.
 */
export async function inferDigests(
  cfg: Config,
  opts: { dryRun?: boolean; breakLock?: boolean; now?: string } = {},
): Promise<InferResult> {
  const git = new Git(cfg.vault, cfg.git);
  const history = git.noteHistory();
  if (history === null) throw new Error("بلا git لا دليل على القراءة التي كتبت كل ملاحظة — لا بصمة تُستنتَج");
  const release = acquireLock(cfg.vault, { breakLock: opts.breakLock === true });
  const store = new Store(cfg.vault);
  const out: InferResult = { candidates: 0, inferred: [], skipped: [], commit: null };
  const at = opts.now ?? new Date().toISOString();
  try {
    for (const row of store.notedSessions()) {
      if (row.status !== "ok" || !row.note_path) continue;
      const notePath = path.join(cfg.vault, row.note_path);
      const md = readFileIfExists(notePath);
      if (md === null || noteExtractor(md) !== "model") continue;
      const trailer = parseFactsTrailer(md);
      if (!trailer || trailer.distilled || trailer.distilledInferred) continue;
      out.candidates++;
      const note = row.note_path;
      const skip = (why: string) => void out.skipped.push({ note, why });

      const commits = history.get(note) ?? [];
      const lastReading = commits.findIndex((c) => /^scan\b/.test(c.subject));
      const reading = commits[lastReading];
      if (!reading) {
        skip("لا commit قراءة للملاحظة");
        continue;
      }
      if (commits.slice(0, lastReading).some((c) => /^revert\b/i.test(c.subject))) {
        skip("أُرجعت بعد آخر قراءة");
        continue;
      }
      const readAt = Date.parse(row.processed_at);
      const committed = Date.parse(reading.at);
      if (!(readAt <= committed + 60_000 && committed - readAt <= READING_SPAN_MS)) {
        skip(`صف الفهرس (${row.processed_at}) ليس من آخر قراءة (${reading.at})`);
        continue;
      }
      const recorded = /^(\d+):\d+$/.exec(row.content_hash)?.[1];
      if (!recorded) {
        skip(`بصمة الفهرس ليست من قراءة (${row.content_hash})`);
        continue;
      }
      let size: number;
      try {
        size = fs.statSync(row.source_file).size;
      } catch {
        skip("النص غير موجود");
        continue;
      }
      if (size !== Number(recorded)) {
        skip(`طول النص تغيّر منذ القراءة (${recorded} ← ${size})`);
        continue;
      }
      const adapter = adapterFor(row.agent);
      const session = adapter ? await adapter.parse(row.source_file) : null;
      if (!session || session.id !== row.id) {
        skip("النص لم يعد يُقرأ جلسةَ هذه الملاحظة");
        continue;
      }
      const inferred: InferredDigest = {
        sha256: sha256(distill(session, cfg.distillMaxChars).text),
        at,
        readAt: row.processed_at,
        size,
      };
      const next = withInferredDigest(md, inferred);
      if (next === null) {
        skip("الذيل لا يُعاد كما كُتب");
        continue;
      }
      if (!opts.dryRun) writeFileAtomic(notePath, next);
      out.inferred.push({ note, session: row.id, size, readAt: row.processed_at });
    }
    if (!opts.dryRun && out.inferred.length) {
      out.commit = git.commit(`infer-digests: ${out.inferred.length} ملاحظة — بصمة مُستنتَجة، بلا قراءة`);
    }
    return out;
  } finally {
    store.close();
    release();
  }
}
