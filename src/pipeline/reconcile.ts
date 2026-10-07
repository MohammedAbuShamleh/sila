import { Store } from "../store/db.js";
import type { FactRow, PendingRow } from "../store/db.js";
import { byDate, claimInSlot, noteTouches } from "../store/vault.js";
import type { Fact, Link, MoveRecord, NoteEvents, RetractRequest, RetractedFact, SessionNote, SubjectKind } from "../types.js";
import { normalizeArabic } from "../util/arabic.js";

/**
 * Where a memory system lives or dies.
 *
 * Naive engines append. After two months "the backend is Laravel 10" and "the
 * backend is Laravel 11" both sit in the file, the agent reads both, and the
 * memory is worse than none. So every fact declares the *slot* it occupies
 * (subject + key), and a new claim for an occupied slot must either supersede
 * the old one or go to a human. It may never sit beside it.
 *
 * The guard that matters: a low-confidence claim never overrides a
 * higher-confidence one. Something the user stated outright is not overwritten
 * by something the model inferred.
 */

export interface ReconcileOutcome {
  touchedSubjects: Array<{ subject: string; kind: string }>;
  added: number;
  superseded: number;
  queued: number;
  unchanged: number;
  /** Ids of the rows this call inserted, in order, so a caller can act on them. */
  insertedIds: number[];
}

const OVERRIDE_MARGIN = 0.1;

/** Whether a claim at `confidence` may take a slot held at `held`. The one guard, wherever a slot changes hands. */
function mayOverride(confidence: number, held: number, floor: number): boolean {
  return confidence >= floor && confidence >= held - OVERRIDE_MARGIN;
}

/**
 * `at` is the moment these claims were made — the note's date on a rebuild —
 * so `created_at` and `superseded_at` record when something was learned, not
 * when the index happened to be rebuilt. Omitted, the clock is used, which is
 * right for a live scan.
 */
export function reconcile(
  store: Store,
  note: SessionNote,
  sessionId: string,
  floor: number,
  at?: string,
): ReconcileOutcome {
  const now = at ?? new Date().toISOString();
  const touched = new Map<string, string>();
  const insertedIds: number[] = [];
  let added = 0;
  let superseded = 0;
  let queued = 0;
  let unchanged = 0;

  const apply = store.db.transaction((facts: Fact[]) => {
    for (const f of facts) {
      const subject = f.subject.trim();
      const key = f.key.trim();
      if (!subject || !key || !f.claim.trim()) continue;

      const current = store.currentFact(subject, key);

      if (!current) {
        // The model does not always file a claim under the same key twice.
        // A claim that already lives under another key of this subject is
        // the same fact, not a new slot: the old key stays, nothing is
        // inserted, and the queue is not asked about something already known.
        if (liveTwin(store, subject, f.claim)) {
          unchanged++;
          continue;
        }
        if (f.confidence < floor) {
          store.addPending({
            subject,
            subject_kind: f.subjectKind,
            key,
            claim: f.claim,
            confidence: f.confidence,
            reason: "below-confidence-floor",
            session_id: sessionId,
            created_at: now,
          });
          queued++;
          continue;
        }
        insertedIds.push(
          store.insertFact({
            subject,
            subject_kind: f.subjectKind,
            key,
            claim: f.claim,
            confidence: f.confidence,
            session_id: sessionId,
            created_at: now,
          }),
        );
        touched.set(subject, f.subjectKind);
        added++;
        continue;
      }

      if (equivalent(current.claim, f.claim)) {
        unchanged++;
        continue;
      }

      if (!mayOverride(f.confidence, current.confidence, floor)) {
        store.addPending({
          subject,
          subject_kind: f.subjectKind,
          key,
          claim: f.claim,
          confidence: f.confidence,
          reason: `conflicts-with:${current.claim.slice(0, 120)}`,
          session_id: sessionId,
          created_at: now,
        });
        queued++;
        continue;
      }

      const newId = store.insertFact({
        subject,
        subject_kind: f.subjectKind,
        key,
        claim: f.claim,
        confidence: f.confidence,
        session_id: sessionId,
        created_at: now,
      });
      store.supersede(current.id, newId, now);
      insertedIds.push(newId);
      touched.set(subject, f.subjectKind);
      superseded++;
      added++;
    }

    recordLinks(store, note.links, sessionId);
  });

  apply(note.facts);

  return {
    touchedSubjects: [...touched].map(([subject, kind]) => ({ subject, kind })),
    added,
    superseded,
    queued,
    unchanged,
    insertedIds,
  };
}

/** Links have no order to get wrong: a set of pairs, whoever named them first. */
export function recordLinks(store: Store, links: Link[], sessionId: string): void {
  for (const l of links) {
    const a = l.from.trim();
    const b = l.to.trim();
    if (!a || !b || a === b) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    store.addLink(x, y, l.relation || "related", sessionId);
  }
}

const EMPTY_NOTE: Omit<SessionNote, "facts"> = {
  title: "",
  project: "",
  summary: "",
  did: [],
  decisions: [],
  rejected: [],
  open: [],
  links: [],
};

/**
 * One withdrawn claim of a note, replayed at the note's place in time.
 *
 * If the slot still holds the same claim, that is what was withdrawn, and it
 * is withdrawn here too — another session may have made it and this note is
 * what took it back. Otherwise the claim goes on record as it was: made, then
 * withdrawn. What it displaced when it was made stays displaced, as
 * retractUnconfirmed promises — but only a claim that could have displaced
 * it. The guard that keeps a weak claim off a strong one holds for a
 * withdrawn claim too; without it, replaying a withdrawal emptied whatever
 * slot it landed on, a human-confirmed one included.
 *
 * Returns the row that now stands withdrawn, so the note can file it as
 * replaced if its own claims fill the slot — see fileReplaced.
 */
function replayRetracted(store: Store, r: RetractedFact, sessionId: string, when: string | undefined, floor: number): number | undefined {
  const subject = r.subject.trim();
  const key = r.key.trim();
  if (!subject || !key || !r.claim.trim()) return undefined;
  const current = store.currentFact(subject, key);
  if (current && equivalent(current.claim, r.claim)) {
    store.retract(current.id, r.retractedAt);
    return current.id;
  }
  const at = r.createdAt || when || r.retractedAt;
  const id = store.insertFact({
    subject,
    subject_kind: r.subjectKind,
    key,
    claim: r.claim,
    confidence: r.confidence,
    session_id: sessionId,
    created_at: at,
    retracted_at: r.retractedAt,
  });
  if (current && mayOverride(r.confidence, current.confidence, floor)) store.supersede(current.id, id, at);
  return id;
}

/**
 * A withdrawn claim whose slot the same note filled was replaced, not
 * withdrawn: a re-read that says a claim under the same key in new words.
 *
 * The withdrawal is replayed first and the note's claim then takes the empty
 * slot, exactly as before — the guard that keeps a weaker claim off a
 * stronger one has nothing to say between two readings of one session, and
 * what ends up live does not change. Only the label does: the withdrawn row
 * points at its successor instead of carrying a withdrawal date. Several
 * withdrawn rows of one slot — each reading's wording — form a chain, oldest
 * first, as the trailer lists them.
 *
 * Only when the note's claim did take the slot. One queued below the floor,
 * or one already live under another key, left the slot empty: that is a
 * withdrawal, and stays one.
 */
function fileReplaced(store: Store, withdrawn: Array<{ subject: string; key: string; id: number }>, inserted: readonly number[]): void {
  const slots = new Map<string, Array<{ subject: string; key: string; id: number }>>();
  for (const w of withdrawn) {
    const k = `${w.subject}\u0000${w.key}`;
    slots.set(k, [...(slots.get(k) ?? []), w]);
  }
  for (const rows of slots.values()) {
    const first = rows[0];
    if (!first) continue;
    const successor = store.currentFact(first.subject, first.key);
    if (!successor || !inserted.includes(successor.id)) continue;
    rows.forEach((w, i) => store.replace(w.id, rows[i + 1]?.id ?? successor.id, successor.created_at));
  }
}

/**
 * Apply one note: its withdrawals, then its claims, both dated by the note.
 *
 * The single definition of what a note does to the facts table. `reindex`
 * calls it for every note in session-date order; a scan calls it through
 * `rebaseSubjects`, for the subjects it touched. Neither has its own path,
 * which is what makes a rebuild land on the slots the scan left.
 *
 * `only` narrows the note to one subject — a subject's slots depend on that
 * subject's claims alone, so replaying it in isolation gives the same result
 * as replaying everything.
 */
export function replayNote(store: Store, note: NoteEvents, floor: number, only?: string): void {
  const when = note.date || undefined;
  const mine = (subject: string) => only === undefined || subject.trim() === only;
  store.db.transaction(() => {
    const facts = note.facts.filter((f) => mine(f.subject));
    const withdrawn: Array<{ subject: string; key: string; id: number }> = [];
    for (const r of note.retracted) {
      if (!mine(r.subject)) continue;
      const id = replayRetracted(store, r, note.sessionId, when, floor);
      if (id !== undefined && claimInSlot(facts, r.subject, r.key)) withdrawn.push({ subject: r.subject.trim(), key: r.key.trim(), id });
    }
    const out = reconcile(store, { ...EMPTY_NOTE, facts, links: only === undefined ? note.links : [] }, note.sessionId, floor, when);
    fileReplaced(store, withdrawn, out.insertedIds);
  })();
}

export interface RebaseOutcome {
  /** Rows the replay needed that the index did not have. */
  inserted: number;
  superseded: number;
  retracted: number;
  /** Rows the processing order had displaced or withdrawn that the session dates put back. */
  restored: number;
  queued: number;
  /** Subjects whose rows or queue this call changed — the ones whose files are now stale. */
  changed: string[];
}

/**
 * Re-derive subjects from their notes, in session-date order, and lay the
 * result onto the index.
 *
 * Supersession depends on order, and the order a scan meets sessions in is
 * not the order they happened in: a session whose CLI failed is read days
 * later, a `--force` re-read is read today, two sessions end in the reverse
 * of the order they began. Applying claims as they arrive let an older
 * session displace a newer one — and a claim that changed nothing when it
 * arrived (the same thing said again) left no row behind, so the index alone
 * could not have known better. The notes do know: every claim, every
 * withdrawal, and the session date. So each subject is replayed from them
 * with `replayNote`, exactly as `reindex` would, in a scratch store; then the
 * index is made to match it.
 *
 * Matching, not rebuilding: a replayed row is paired with the existing row of
 * the same session, key and claim (equivalent wording counts), its links and
 * dates are set to the replay's, and only a claim with no row gets one. No
 * row is ever deleted. A row no note supports any more — two scans reading
 * one session left one behind — is withdrawn. The queue follows the same
 * replay: what it no longer raises is marked obsolete, what it raises anew is
 * added, and a decision already taken on a claim is kept.
 *
 * One kind of row is outside the notes: `sila accept` writes none. An
 * accepted claim is replayed as what it was, a 1.0 claim made at the moment
 * of the accept; one accepted and later withdrawn by hand is left untouched.
 */
export function rebaseSubjects(
  store: Store,
  subjects: Iterable<string>,
  notes: readonly NoteEvents[],
  floor: number,
  now: string,
): RebaseOutcome {
  const out: RebaseOutcome = { inserted: 0, superseded: 0, retracted: 0, restored: 0, queued: 0, changed: [] };
  const sorted = [...notes].sort(byDate);
  store.db.transaction(() => {
    for (const subject of new Set([...subjects].map((s) => s.trim()).filter(Boolean))) {
      const scratch = new Store(null);
      try {
        replaySubject(scratch, store, subject, sorted, floor);
        if (layOnto(store, scratch, subject, now, out)) out.changed.push(subject);
      } finally {
        scratch.close();
      }
    }
  })();
  return out;
}

/**
 * The events a history is replayed from, in session-date order: each note,
 * and each claim a human accepted — `sila accept` writes no note, so the index
 * is its only record, and it is replayed as a 1.0 claim at the moment of the
 * accept. With a subject, only that subject's history; without, everything.
 */
function historyEvents(
  scratch: Store,
  store: Store,
  notes: readonly NoteEvents[],
  floor: number,
  subject?: string,
): Array<{ date: string; sessionId: string; apply: () => void }> {
  const mine = subject === undefined ? [...notes] : notes.filter((n) => noteTouches(n, subject));
  const noteOf = new Map(mine.map((n) => [n.sessionId, n]));
  const accepted = (subject === undefined ? store.acceptedFacts() : store.factsOf(subject)).filter(
    (r) =>
      r.confidence >= 1 &&
      r.retracted_at === null &&
      !noteOf
        .get(r.session_id)
        ?.facts.some((f) => f.subject.trim() === r.subject && f.key.trim() === r.key && f.confidence >= 1 && equivalent(f.claim, r.claim)),
  );
  const events = [
    ...mine.map((n) => ({ date: n.date, sessionId: n.sessionId, apply: () => replayNote(scratch, n, floor, subject) })),
    ...accepted.map((r) => ({
      date: r.created_at,
      sessionId: r.session_id,
      apply: () => {
        reconcile(
          scratch,
          {
            ...EMPTY_NOTE,
            facts: [{ subject: r.subject, subjectKind: r.subject_kind as SubjectKind, key: r.key, claim: r.claim, confidence: r.confidence }],
          },
          r.session_id,
          0,
          r.created_at,
        );
      },
    })),
  ];
  // Stable: at the same instant a note goes before an accept of its own claim.
  return events.sort(byDate);
}

function replaySubject(scratch: Store, store: Store, subject: string, notes: readonly NoteEvents[], floor: number): void {
  for (const e of historyEvents(scratch, store, notes, floor, subject)) e.apply();
}

/**
 * What memory held just before `date`: every earlier session's note, and
 * every accept made before then, replayed as reindex would. `keep` narrows
 * the live facts to the sessions whose facts are wanted — a project's.
 *
 * This is what the extractor is shown, not today's memory. The prompt tells
 * the model not to repeat what memory already holds, so a session re-read
 * against memory that later sessions had filled gave up its own facts: on
 * 2026-09-18 a --force re-read of cbe087c0 (18 July) came back with none of
 * its three, among them a gotcha no other session holds and the fact whose
 * key the root rule had merged — the one the re-read was meant to restore.
 * Against the memory of its own day a session is read as it would have been
 * read then. For a new session, the latest, this is simply today's memory.
 *
 * Strictly before: a session's own earlier reading is not memory it had.
 */
export function liveFactsAsOf(
  store: Store,
  notes: readonly NoteEvents[],
  date: string,
  floor: number,
  keep: (sessionId: string) => boolean,
): FactRow[] {
  const scratch = new Store(null);
  try {
    const earlier = notes.filter((n) => n.date < date);
    for (const e of historyEvents(scratch, store, earlier, floor)) if (e.date < date) e.apply();
    return scratch.allLiveFacts().filter((f) => keep(f.session_id));
  } finally {
    scratch.close();
  }
}

const verbatim = (a: string, b: string): boolean => a === b;

/**
 * Pair each replayed row with an existing one of the same session and key,
 * trying each notion of "same claim" in turn. `alike` narrows a pair further
 * than the claim does — the facts require the same confidence, see layOnto.
 */
function pair<T extends { id: number; session_id: string; key: string; claim: string }>(
  replayed: T[],
  existing: T[],
  sameness: Array<(a: string, b: string) => boolean>,
  alike: (existing: T, replayed: T) => boolean = () => true,
): Map<number, number> {
  const paired = new Map<number, number>();
  const taken = new Set<number>();
  for (const same of sameness) {
    for (const s of replayed) {
      if (paired.has(s.id)) continue;
      const hit = existing.find(
        (e) => !taken.has(e.id) && e.session_id === s.session_id && e.key === s.key && same(e.claim, s.claim) && alike(e, s),
      );
      if (!hit) continue;
      paired.set(s.id, hit.id);
      taken.add(hit.id);
    }
  }
  return paired;
}

/** Make the index's rows and queue for `subject` match the replay. Returns whether anything changed. */
function layOnto(store: Store, scratch: Store, subject: string, now: string, out: RebaseOutcome): boolean {
  let changed = false;
  const replayed = scratch.factsOf(subject);
  // Accepted, then withdrawn by hand: no note records either act, so the
  // replay has nothing to say about this row and must not touch it.
  const existing = store.factsOf(subject).filter((r) => !(r.confidence >= 1 && r.retracted_at !== null));
  const before = new Map(existing.map((r) => [r.id, r]));
  // Verbatim only. `equivalent` counts a claim that contains another as the
  // same claim, so pairing by it kept the index's shorter wording while the
  // note — and every rebuild — carried the longer one with more in it. And
  // the same confidence: a claim put back at 1.0 (`sila restore --confirm`)
  // over its withdrawn 0.85 row is a new row, not that row revived — paired,
  // the index said 0.85 under a note and every rebuild saying 1.0, and
  // retractUnconfirmed reads the index. The 0.85 row stays, withdrawn.
  const ids = pair(replayed, existing, [verbatim], (e, s) => e.confidence === s.confidence);

  for (const s of replayed) {
    if (ids.has(s.id)) continue;
    const id = store.insertFact({
      subject,
      subject_kind: s.subject_kind,
      key: s.key,
      claim: s.claim,
      confidence: s.confidence,
      session_id: s.session_id,
      created_at: s.created_at,
    });
    ids.set(s.id, id);
    before.set(id, { ...s, id, superseded_by: null, superseded_at: null, retracted_at: null });
    out.inserted++;
    changed = true;
  }

  for (const s of replayed) {
    const id = ids.get(s.id);
    const was = id === undefined ? undefined : before.get(id);
    if (id === undefined || !was) continue;
    const next = {
      superseded_by: s.superseded_by === null ? null : (ids.get(s.superseded_by) ?? null),
      superseded_at: s.superseded_at,
      retracted_at: s.retracted_at,
      created_at: s.created_at,
    };
    if (
      was.superseded_by === next.superseded_by &&
      was.superseded_at === next.superseded_at &&
      was.retracted_at === next.retracted_at &&
      was.created_at === next.created_at
    ) {
      continue;
    }
    store.setHistory(id, next);
    changed = true;
    if (was.superseded_by === null && next.superseded_by !== null) out.superseded++;
    if (was.retracted_at === null && next.retracted_at !== null) out.retracted++;
    if ((was.superseded_by !== null && next.superseded_by === null) || (was.retracted_at !== null && next.retracted_at === null)) {
      out.restored++;
    }
  }

  // Rows no note supports any more. One whose session's note now says the
  // same thing in other words — a re-read that refined it — is superseded by
  // that wording; anything else — two scans reading one session left one
  // behind — is withdrawn.
  const kept = new Set(ids.values());
  const liveNow = replayed.filter((s) => s.superseded_by === null && s.retracted_at === null);
  for (const r of existing) {
    if (kept.has(r.id) || r.superseded_by !== null || r.retracted_at !== null) continue;
    const refined = liveNow.find((s) => s.session_id === r.session_id && s.key === r.key && equivalent(s.claim, r.claim));
    const successor = refined ? ids.get(refined.id) : undefined;
    changed = true;
    if (refined && successor !== undefined) {
      store.supersede(r.id, successor, refined.created_at);
      out.superseded++;
    } else {
      store.retract(r.id, now);
      out.retracted++;
    }
  }

  // The queue keeps a decision taken on a claim however the claim is worded
  // now: a re-read must not raise again what the user already answered. An
  // item set aside as obsolete that the notes raise again — a re-read
  // reverted — waits again: obsolete was the replay's word, not the user's.
  const queue = store.pendingOf(subject);
  const raised = scratch.pendingOf(subject);
  const decided = pair<PendingRow>(raised, queue, [verbatim, equivalent]);
  const byId = new Map(queue.map((q) => [q.id, q]));
  for (const p of raised) {
    const existing = decided.get(p.id);
    if (existing !== undefined) {
      if (byId.get(existing)?.status === "obsolete") {
        store.setPendingStatus(existing, "waiting");
        out.queued++;
        changed = true;
      }
      continue;
    }
    store.addPending({
      subject,
      subject_kind: p.subject_kind,
      key: p.key,
      claim: p.claim,
      confidence: p.confidence,
      reason: p.reason,
      session_id: p.session_id,
      created_at: p.created_at,
    });
    out.queued++;
    changed = true;
  }
  const still = new Set(decided.values());
  for (const q of queue) {
    if (q.status !== "waiting" || still.has(q.id)) continue;
    store.setPendingStatus(q.id, "obsolete");
    changed = true;
  }
  return changed;
}

/** A key as its spelling may vary: lower case, split into segments at the dots and into words at dashes and underscores. */
function keyWords(key: string): string[][] {
  return key
    .trim()
    .toLowerCase()
    .split(".")
    .map((segment) => segment.split(/[-_\s]+/).filter(Boolean));
}

/** A word and what it would be without a plural ending. */
function wordForms(word: string): string[] {
  const forms = [word];
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) forms.push(word.slice(0, -1));
  if (word.length > 4 && word.endsWith("ies")) forms.push(`${word.slice(0, -3)}y`);
  return forms;
}

/**
 * Whether two keys name one slot: equal once letter case, dash against
 * underscore, and a plural ending are set aside — and in nothing else.
 *
 * Deliberately not a guess at meaning. `bundle-scale`, `bundle-write` and
 * `bundle-duplicate` are three slots however much they share, and so are
 * `tender-delete` and `tender-items`: the six-character root this
 * replaced merged exactly those, and a merged slot hides one fact behind
 * another as "superseded". Two spellings of one key left apart cost a
 * duplicate line; two facts in one slot cost a fact. The claim itself is the
 * other way two keys become one slot — see liveTwin in reconcile.
 *
 * The plural rule is the one inexact part: a word that ends in s without
 * being a plural (`https`) meets its s-less twin (`http`) as the same word,
 * if a subject ever holds both under one prefix. None of the 596 keys in the
 * vault on 2026-09-18 does.
 */
export function sameKey(a: string, b: string): boolean {
  const x = keyWords(a);
  const y = keyWords(b);
  return (
    x.length === y.length &&
    x.every((seg, i) => {
      const other = y[i];
      return (
        !!other &&
        seg.length === other.length &&
        seg.every((w, j) => {
          const v = other[j];
          return v !== undefined && wordForms(w).some((f) => wordForms(v).includes(f));
        })
      );
    })
  );
}

/**
 * The key a new claim should be filed under, given the keys already known.
 *
 * The same key the vault already has, spelled the vault's way; otherwise the
 * key as given. `known` is ordered oldest first and the first match wins:
 * the vault already knows the slot by that name.
 */
export function canonicalKey(key: string, known: readonly string[]): string {
  if (known.includes(key)) return key;
  return known.find((k) => sameKey(k, key)) ?? key;
}

/**
 * A note's facts with each key spelled the way the vault already spells it.
 *
 * Every key the subject has ever had counts, live or not: a slot emptied by
 * a withdrawal is still that slot, and the next claim in it should land
 * there rather than open a second spelling beside its history.
 *
 * Applied in the scan *before* the note is rendered, so the trailer records
 * the canonical key and `reindex` replays exactly what the scan applied.
 * Deliberately not inside the replay: the keys known when a session is read
 * are not the keys known at its place in a rebuild, so a remap decided
 * during a replay could pick a different target than the scan did — and a
 * withdrawal replayed onto a remapped key would empty a slot nobody
 * retracted.
 *
 * Keys named earlier in the same note count as known too, so one reply that
 * uses both spellings still opens only one slot.
 */
export function canonicalizeFacts(store: Store, facts: Fact[]): { facts: Fact[]; remapped: Array<{ subject: string; from: string; to: string }> } {
  const known = new Map<string, string[]>();
  const remapped: Array<{ subject: string; from: string; to: string }> = [];
  const out = facts.map((f) => {
    const subject = f.subject.trim();
    const key = f.key.trim();
    let keys = known.get(subject);
    if (!keys) {
      keys = store.keysOf(subject);
      known.set(subject, keys);
    }
    const canon = canonicalKey(key, keys);
    if (!keys.includes(canon)) keys.push(canon);
    if (canon === key) return f;
    remapped.push({ subject, from: key, to: canon });
    return { ...f, key: canon };
  });
  return { facts: out, remapped };
}

/**
 * A re-read's claims filed where a human moved them.
 *
 * `sila move` moves a slot in the notes, and a note is derived from the
 * transcript: when the transcript changes, the session is read again, and
 * the model — which never sees its own earlier reading — files the claim
 * where it first did. Without this, the move was undone by the next re-read:
 * b26a6056's six facts went back to tooling on 2026-09-24. So every
 * move a note recorded is applied to the reading before the note is written,
 * the same place canonicalizeFacts spells the keys — a move applied in the
 * replay instead would leave the note claiming one slot and the index another.
 *
 * A move is matched as a slot is: the subject as spelled either way, the key
 * by sameKey, and in nothing else. A claim the model files under a third
 * key or subject is not caught — the ledger protects where a claim lands,
 * not whether the reading produces it. Moves chain: a slot moved twice
 * follows both.
 */
export function applyMoves(
  moves: readonly MoveRecord[],
  facts: Fact[],
): { facts: Fact[]; moved: Array<{ from: string; to: string }> } {
  const moved: Array<{ from: string; to: string }> = [];
  if (!moves.length) return { facts, moved };
  const out = facts.map((f) => {
    let cur = f;
    // A chain is at most as long as the ledger; past that it is a cycle.
    for (let hop = 0; hop < moves.length; hop++) {
      const m = moves.find((x) => subjectForm(x.subject) === subjectForm(cur.subject) && sameKey(x.key, cur.key));
      if (!m) break;
      cur = { ...cur, subject: m.to.trim(), key: m.toKey.trim(), subjectKind: m.kind };
    }
    if (cur !== f) moved.push({ from: `${f.subject.trim()}.${f.key.trim()}`, to: `${cur.subject}.${cur.key}` });
    return cur;
  });
  return { facts: out, moved };
}

/**
 * What a human confirmed at 1.0 in this session's earlier note, kept by a
 * reading that does not say it again.
 *
 * Constant 5 in the note as well as in the index: retractUnconfirmed never
 * withdraws a 1.0 row, but the note is rewritten from the reading, and a
 * rebuild from the notes would lose what the index kept — the accept defect
 * in a second form, for `sila restore --confirm`. Carried first, so a weaker
 * claim the reading makes for the same slot meets it in the replay and is
 * queued, as it would be against the index.
 */
export function carryConfirmed(previous: readonly Fact[], facts: readonly Fact[]): Fact[] {
  return previous.filter(
    (p) => p.confidence >= 1 && !facts.some((f) => f.subject.trim() === p.subject.trim() && equivalent(f.claim, p.claim)),
  );
}

/** Why a new subject was put back on its project. */
export type AnchorReason = "spelling" | "file" | "class" | "ticket" | "folder";

export interface Anchored {
  from: string;
  key: string;
  to: string;
  toKey: string;
  why: AnchorReason;
}

/** A subject with case and separators set aside — `ACME`, `acme` and `Acme ` are one name. */
function subjectForm(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * What a new subject's name says it is, when it names a part of a project
 * rather than a lasting entity: an item or ticket number, a file or a
 * dotted name, a class. Null for anything else — the prompt, not this, is
 * what keeps a concept from becoming a subject.
 *
 * Also what keeps such a name out of what the extractor is shown — the list
 * of subjects to reuse and the facts memory holds (factsContext): a subject
 * this rejects when new is not shown when live, or the context teaches back
 * the error the guard exists to catch. A repository's server folder did exactly that.
 *
 * A folder at the root of the project is a part of it too, spelled any way:
 * `acme_server` and `acme_client` against `acme_server/` and
 * `acme-client/`. No shape tells a folder from an entity, so the folders
 * themselves are asked; the first full scan filed 33 facts under those two,
 * and the list of live subjects taught the name back to every later reading.
 *
 * A tool or a person is a subject by the definition, and many tools are
 * spelled like a class (PowerShell), with a dot (Node.js), with a number
 * (gpt-4) or like a folder of the repo (`docker/`) — so the kind the model
 * gave excuses those four. A path is excused for nothing: `PowerShell/git
 * stash` names a use, not a tool.
 */
export function partOfProject(subject: string, kind?: string, folders: readonly string[] = []): AnchorReason | null {
  if (/[/\\]/.test(subject)) return "file";
  if (kind === "tool" || kind === "person") return null;
  if (/\b[A-Za-z]{1,6}\d{0,3}-\d{1,5}\b/.test(subject) || /(^|\s)#\d+\b/.test(subject)) return "ticket";
  if (/\./.test(subject)) return "file";
  if (/^[A-Z][A-Za-z0-9]*$/.test(subject) && /[a-z]/.test(subject) && /^.[^A-Z]*[A-Z]/.test(subject)) return "class";
  if (folders.some((d) => subjectForm(d) === subjectForm(subject))) return "folder";
  return null;
}

/** Lower-case words of a name, split at case humps and at anything that is not a letter or digit. */
function nameWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter(Boolean);
}

/**
 * The project key a part's fact moves to: the key's prefix, then the part's
 * words and the key's own words. Both are kept so two facts about one part
 * never meet in one slot; the project's own name is dropped from the part.
 */
function partKey(key: string, part: string, project: string): string {
  const dot = key.indexOf(".");
  const prefix = dot > 0 ? key.slice(0, dot).toLowerCase() : "misc";
  const noun = dot > 0 ? key.slice(dot + 1) : key;
  // The project's own name, and the prefix a model sometimes writes into the
  // subject (`acme.convention` · `convention.commits`), say nothing new.
  const own = new Set([...nameWords(project), prefix]);
  const words = [...new Set([...nameWords(part).filter((w) => !own.has(w)), ...nameWords(noun)])];
  return `${prefix}.${words.join("-") || "part"}`;
}

/**
 * A new subject put back on the project it belongs to.
 *
 * The prompt defines a subject as a lasting entity people know by name; this
 * is the backstop for the names that plainly are not one. A subject already
 * live in the vault, or the project itself, passes as it is — history is not
 * this guard's to rewrite. A new one that is another spelling of a live
 * subject takes the vault's spelling. A new one named like a file, a class
 * or a ticket moves to the project under a key that names the part:
 * `BillingService` · `arch.status` ← `acme` · `arch.billing-service-status`.
 *
 * A subject the model called a tool or a person keeps its class-like,
 * dotted, numbered or folder-like spelling (PowerShell, Node.js, gpt-4) —
 * see partOfProject — but not a path. `folders` are the project root's.
 */
export function anchorSubjects(
  facts: Fact[],
  project: string,
  known: ReadonlySet<string>,
  folders: readonly string[] = [],
): { facts: Fact[]; anchored: Anchored[] } {
  const anchored: Anchored[] = [];
  const names = [project, ...known];
  const out = facts.map((f) => {
    const subject = f.subject.trim();
    if (subject === project || known.has(subject)) return f;
    const same = names.find((n) => subjectForm(n) === subjectForm(subject));
    if (same !== undefined) {
      anchored.push({ from: subject, key: f.key, to: same, toKey: f.key, why: "spelling" });
      return { ...f, subject: same };
    }
    const why = partOfProject(subject, f.subjectKind, folders);
    if (!why || !project) return f;
    const toKey = partKey(f.key, subject, project);
    anchored.push({ from: subject, key: f.key, to: project, toKey, why });
    return { ...f, subject: project, subjectKind: "project" as const, key: toKey };
  });
  return { facts: out, anchored };
}

/**
 * The live fact of `subject` that already says `claim`, whatever key it sits
 * under. Keys are model output and drift between readings; the claim is what
 * the slot is really about.
 */
export function liveTwin(store: Store, subject: string, claim: string): FactRow | undefined {
  return store.liveFacts(subject).find((f) => equivalent(f.claim, claim));
}

/** Same claim said differently is not a change. Prevents churn in git history. */
export function equivalent(a: string, b: string): boolean {
  const na = normalizeArabic(a).replace(/\s+/g, " ").trim();
  const nb = normalizeArabic(b).replace(/\s+/g, " ").trim();
  if (na === nb) return true;
  if (na.length > 12 && nb.length > 12 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

/**
 * Withdraw the claims the model named in `retract`.
 *
 * Distinct from `retractUnconfirmed`, which infers a withdrawal from silence
 * in a re-reading of the same session: this is a session saying outright that
 * something memory holds is no longer true — the shape a "problem, then fix"
 * session needs, since the fix supersedes by key and only a claim with no
 * successor has to be named.
 *
 * Three guards. A fact a human confirmed at 1.0 is never withdrawn by a
 * model. A session may only withdraw what is *live*: an already-retracted or
 * superseded row is not touched, so replaying a note is idempotent. And, when
 * `when` gives the dates, an older session does not take back what a newer
 * one said: the model was shown today's memory, not the memory of its own
 * session's day, and a transcript cannot disprove a claim made after it.
 *
 * A named slot the session's own `facts` fill again is recorded but left
 * live, like a rewording in retractUnconfirmed: the rebase files it as
 * replaced by the new claim, which is what re-stating a key means.
 */
export function applyRetractions(
  store: Store,
  requests: RetractRequest[],
  sessionId: string,
  now: string,
  when?: { date: string; dateOf: (sessionId: string) => string | undefined },
  facts: readonly Fact[] = [],
): RetractedFact[] {
  const out: RetractedFact[] = [];
  const run = store.db.transaction(() => {
    for (const r of requests) {
      const subject = r.subject.trim();
      const key = r.key.trim();
      if (!subject || !key) continue;
      const current = store.currentFact(subject, key);
      if (!current || current.confidence >= 1) continue;
      const theirs = when?.dateOf(current.session_id);
      if (when && theirs && theirs > when.date) continue;
      if (!claimInSlot(facts, subject, key)) store.retract(current.id, now);
      out.push({
        subject: current.subject,
        subjectKind: current.subject_kind as SubjectKind,
        key: current.key,
        claim: current.claim,
        confidence: current.confidence,
        createdAt: current.created_at,
        retractedAt: now,
        reason: r.reason?.trim() || `سحبته جلسة ${sessionId}`,
      });
    }
  });
  run();
  return out;
}

/**
 * Withdraw what an earlier extraction of this session claimed and this one
 * does not.
 *
 * Re-reading a session is the one case where a missing claim is evidence:
 * the same source, read again with a better prompt, no longer yields it, so
 * the earlier extraction was wrong about it. That is not supersession — the
 * world did not change — so the row is marked retracted instead, and stays.
 *
 * Two deliberate limits. "Confirmed" is measured with the same `equivalent`
 * the reconciler uses — and, like the reconciler, on the claim alone within
 * the subject, so neither a rephrasing nor a re-keying retracts and re-adds.
 * And a claim at confidence 1.0 is never retracted: a human said so, and a
 * model re-reading the transcript does not get to unsay it.
 *
 * A claim the new reading says again under the same key, in words that are
 * not equivalent, is not missing: the reading replaced it. It is returned
 * like a withdrawal — the note records every wording an earlier reading had,
 * or reindex could not rebuild its row — but left live here, for the rebase
 * to file as replaced by the new wording (see fileReplaced). Withdrawn here,
 * it read as "we were wrong" in the history, beside the new wording of the
 * same slot.
 *
 * Whatever a withdrawn fact had superseded does not come back. The slot is
 * simply empty until something claims it again.
 */
export function retractUnconfirmed(
  store: Store,
  sessionId: string,
  note: SessionNote,
  now: string,
): RetractedFact[] {
  const out: RetractedFact[] = [];
  const run = store.db.transaction(() => {
    for (const f of store.liveFactsFromSession(sessionId)) {
      if (f.confidence >= 1) continue;
      const confirmed = note.facts.some((n) => n.subject.trim() === f.subject && equivalent(n.claim, f.claim));
      if (confirmed) continue;
      if (!claimInSlot(note.facts, f.subject, f.key)) store.retract(f.id, now);
      out.push({
        subject: f.subject,
        subjectKind: f.subject_kind as SubjectKind,
        key: f.key,
        claim: f.claim,
        confidence: f.confidence,
        createdAt: f.created_at,
        retractedAt: now,
      });
    }
  });
  run();
  return out;
}
