/**
 * Arabic normalization, used on both sides of every comparison.
 *
 * The hazard this file exists to prevent is asymmetry: if indexing normalizes
 * differently from querying, search fails silently and looks like "no results"
 * rather than a bug. So `indexable()` is the only function that ever touches
 * FTS content, and it is called from exactly two places — `indexNote` and
 * `search` in store/db.ts. Change one and you have changed both. The same
 * holds for the one other text search here: which facts the extractor sees
 * a claim for (`nearest` in pipeline/extract.ts) runs it on the session and
 * on each fact alike.
 *
 * Note that db.ts also asks SQLite for `remove_diacritics 2`. That is belt and
 * braces, not the mechanism: FTS5's unicode61 does not fold أ/إ/آ to ا, nor
 * ة to ه, so the folding below is what actually makes «استضافه» find
 * «الاستضافة».
 */

/** Harakat, tanwin, shadda, sukun, superscript alef, plus tatweel. */
const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

export function normalizeArabic(input: string): string {
  return (
    input
      .normalize("NFC")
      .replace(MARKS, "")
      // Every alef shape collapses to bare alef.
      .replace(/[آأإٱ]/g, "ا")
      // Alef maqsura → ya. Both spellings appear for the same word.
      .replace(/ى/g, "ي")
      // Ta marbuta → ha, the way it is typed when hurried.
      .replace(/ة/g, "ه")
      // Hamza on waw/ya → the bare letter.
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      // Arabic-Indic digits → ASCII, so "٢٠٢٦" and "2026" match.
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .toLowerCase()
  );
}

/**
 * What goes into the FTS column, and what a query is turned into.
 *
 * Beyond normalization it strips the definite article. Arabic attaches «ال»
 * to the word itself, so without this «استضافة» and «الاستضافة» are two
 * distinct tokens to any tokenizer — the single most common reason an Arabic
 * search returns nothing for a word the user can see in the file.
 *
 * The 4-character floor is deliberate: «الف» and «مال» start with those
 * letters without carrying an article, and stripping it there would corrupt
 * short words into different ones.
 */
export function indexable(input: string): string {
  const words = normalizeArabic(input)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 4 && w.startsWith("ال") ? w.slice(2) : w));
  return words.join(" ");
}
