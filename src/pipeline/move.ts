import fs from "node:fs";
import { z } from "zod";
import type { Config } from "../config.js";
import { writeBrief } from "../serve/brief.js";
import { Store } from "../store/db.js";
import { Git } from "../store/git.js";
import type { NoteRecord } from "../store/vault.js";
import { noteDate, noteProse, noteTouches, readAllNotes, readNote, restoreInNote, withFactsTail, writeSubject } from "../store/vault.js";
import type { Fact, MoveRecord, RetractedFact } from "../types.js";
import { writeFileAtomic } from "../util/fsatomic.js";
import { acquireLock } from "../util/lock.js";
import type { RebaseOutcome } from "./reconcile.js";
import { rebaseSubjects, replayNote } from "./reconcile.js";
import { writeInbox } from "./run.js";

/**
 * `sila move --plan <file>`: slots filed under the wrong subject, moved by hand.
 *
 * The first full scan filed facts under subjects the definition does not
 * admit — a folder of the repo (`<project>_server`), a class, a concept, another
 * spelling of the project — and no rule can tell a concept from an entity,
 * so the correction is a human's, written down as a plan and applied whole.
 *
 * A move is made where the claims live, in the notes. Every note that claims
 * the source slot files the claim under the target instead — its words, its
 * confidence and its date unchanged — and records the source slot among its
 * withdrawals, with the target in the reason. Without that record a rebuild
 * would not know the old row ever existed; with it, `reindex` rebuilds the
 * old row withdrawn and the new one where it now lives, as the rebase below
 * does. Nothing is deleted: the old subject keeps its history, and its file
 * says where each claim went.
 *
 * The whole plan is checked before anything is written, and one refused move
 * refuses the plan: a half-applied migration is the one outcome a reviewed
 * plan must not have. A target slot the vault has ever known is refused — a
 * move must not supersede a fact it was never compared with — unless all it
 * ever held is the moving session's own withdrawn wording (ownWithdrawnOnly).
 * Two moves into
 * one new target are allowed: the plan says they are one fact, and the
 * session dates decide which wording stands.
 *
 * Each move is also written into the note's ledger (MoveRecord), and the
 * scan applies the ledger to every later reading of the session before it
 * writes the note (applyMoves in reconcile): the move outlives the re-read
 * that would otherwise undo it.
 *
 * Links are left as the notes named them: their ends are free text, not slots.
 */

const SlotMove = z.object({
  subject: z.string().min(1),
  key: z.string().min(1),
  to: z.string().min(1),
  toKey: z.string().min(1),
  kind: z.enum(["person", "project", "org", "term", "tool"]),
});
export const MovePlanSchema = z.object({ reason: z.string().min(1), moves: z.array(SlotMove).min(1) });
export type SlotMove = z.infer<typeof SlotMove>;
export type MovePlan = z.infer<typeof MovePlanSchema>;

export function readPlan(file: string): MovePlan {
  return MovePlanSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export interface MoveOutcome {
  /** Why the plan was not applied; empty when it was, or would be. */
  refused: string[];
  /** Each move with the notes that claim its source slot and the claim now live there, if any. */
  moves: Array<SlotMove & { notes: number; live: string | null }>;
  /** Live slots and subjects before and after — after from a replay of the moved notes, on a dry run too. */
  before: { facts: number; subjects: number };
  after: { facts: number; subjects: number };
  /** Source subjects left with no live fact. */
  emptied: string[];
  notesWritten: number;
  rebase: RebaseOutcome | null;
  commit: string | null;
}

const slotOf = (subject: string, key: string) => `${subject.trim()}\u0000${key.trim()}`;

/** Every key a subject has had, in the index or in any note — what a target must not collide with. */
function keysEver(store: Store, notes: readonly NoteRecord[], subject: string): Set<string> {
  const keys = new Set(store.keysOf(subject));
  for (const n of notes) for (const f of [...n.facts, ...n.retracted]) if (f.subject.trim() === subject) keys.add(f.key.trim());
  return keys;
}

/**
 * A known target slot that holds nothing but the moving sessions' own
 * withdrawn wording — no live row, no note that claims it, no row or
 * withdrawal from any other session.
 *
 * 4fb58e98's first reading filed a gotcha about an audit script under its project; its
 * re-read filed it under tooling and so withdrew the project's slot. Moving it
 * back puts the session's claim where its own earlier reading had it: there
 * is no other session's fact there to supersede uncompared, and the note then
 * files the old wording as replaced, as a re-read under the same key does.
 */
function ownWithdrawnOnly(store: Store, notes: readonly NoteRecord[], to: string, toKey: string, movers: ReadonlySet<string>): boolean {
  const target = slotOf(to, toKey);
  const rows = store.factsOf(to.trim()).filter((r) => r.key.trim() === toKey.trim());
  if (!rows.every((r) => movers.has(r.session_id) && (r.retracted_at !== null || r.superseded_by !== null))) return false;
  return notes.every(
    (n) =>
      !n.facts.some((f) => slotOf(f.subject, f.key) === target) &&
      (movers.has(n.sessionId) || !n.retracted.some((f) => slotOf(f.subject, f.key) === target)),
  );
}

function check(plan: MovePlan, store: Store, notes: readonly NoteRecord[]): string[] {
  const refused: string[] = [];
  const sources = new Set<string>();
  const targets = new Set(plan.moves.map((m) => slotOf(m.to, m.toKey)));
  // The sessions whose claims the plan puts into each target slot.
  const movers = new Map<string, Set<string>>();
  for (const m of plan.moves) {
    const t = slotOf(m.to, m.toKey);
    const ids = movers.get(t) ?? new Set<string>();
    for (const n of notes) if (n.facts.some((f) => slotOf(f.subject, f.key) === slotOf(m.subject, m.key))) ids.add(n.sessionId);
    movers.set(t, ids);
  }
  for (const m of plan.moves) {
    const name = `${m.subject}.${m.key} ← ${m.to}.${m.toKey}`;
    const src = slotOf(m.subject, m.key);
    if (src === slotOf(m.to, m.toKey)) refused.push(`${name}: الخانة نفسها`);
    if (sources.has(src)) refused.push(`${name}: المصدر مكرّر في الخطة`);
    sources.add(src);
    if (targets.has(src)) refused.push(`${name}: المصدر هدفُ نقلٍ آخر في الخطة`);
    if (!notes.some((n) => n.facts.some((f) => slotOf(f.subject, f.key) === src))) refused.push(`${name}: لا ملاحظة تدّعي المصدر`);
    if (
      keysEver(store, notes, m.to.trim()).has(m.toKey.trim()) &&
      !ownWithdrawnOnly(store, notes, m.to, m.toKey, movers.get(slotOf(m.to, m.toKey)) ?? new Set())
    ) {
      refused.push(`${name}: الهدف خانة يعرفها المخزن`);
    }
  }
  return refused;
}

/** A note's trailer with the plan applied: its moved claims, the withdrawals that record where they went, and the ledger a re-read follows. */
function moved(
  n: NoteRecord,
  bySlot: Map<string, SlotMove>,
  reason: string,
  at: string,
): { facts: Fact[]; retracted: RetractedFact[]; moves: MoveRecord[] } | null {
  const gone: RetractedFact[] = [];
  const moves: MoveRecord[] = [];
  const facts = n.facts.map((f) => {
    const m = bySlot.get(slotOf(f.subject, f.key));
    if (!m) return f;
    gone.push({ ...f, createdAt: noteDate(n.md) || at, retractedAt: at, reason: `نُقل إلى ${m.to}.${m.toKey} — ${reason}` });
    // One record per slot: a note that files two claims under one key moves both, and says so once.
    if (!moves.some((x) => slotOf(x.subject, x.key) === slotOf(f.subject, f.key))) {
      moves.push({ subject: f.subject.trim(), key: f.key.trim(), to: m.to.trim(), toKey: m.toKey.trim(), kind: m.kind, at, reason });
    }
    return { ...f, subject: m.to.trim(), key: m.toKey.trim(), subjectKind: m.kind };
  });
  return gone.length ? { facts, retracted: [...n.retracted, ...gone], moves: [...n.moves, ...moves] } : null;
}

/** Live facts and subjects the notes alone give — what reindex would build. */
function replayed(notes: readonly NoteRecord[], floor: number): { facts: number; subjects: number } {
  const scratch = new Store(null);
  try {
    for (const n of notes) replayNote(scratch, n, floor);
    const st = scratch.stats();
    return { facts: st["facts"] ?? 0, subjects: st["subjects"] ?? 0 };
  } finally {
    scratch.close();
  }
}

export function movePlan(cfg: Config, plan: MovePlan, opts: { dryRun?: boolean; breakLock?: boolean } = {}): MoveOutcome {
  const release = acquireLock(cfg.vault, { breakLock: opts.breakLock === true });
  const store = new Store(cfg.vault);
  try {
    const notes = readAllNotes(cfg.vault);
    const at = new Date().toISOString();
    const bySlot = new Map(plan.moves.map((m) => [slotOf(m.subject, m.key), m]));
    const out: MoveOutcome = {
      refused: check(plan, store, notes),
      moves: plan.moves.map((m) => ({
        ...m,
        notes: notes.filter((n) => n.facts.some((f) => slotOf(f.subject, f.key) === slotOf(m.subject, m.key))).length,
        live: store.currentFact(m.subject.trim(), m.key.trim())?.claim ?? null,
      })),
      before: replayed(notes, cfg.confidenceFloor),
      after: { facts: 0, subjects: 0 },
      emptied: [],
      notesWritten: 0,
      rebase: null,
      commit: null,
    };

    const next = notes.map((n) => {
      const t = moved(n, bySlot, plan.reason, at);
      return t ? { note: { ...n, facts: t.facts, retracted: t.retracted, moves: t.moves }, changed: true } : { note: n, changed: false };
    });
    out.after = replayed(
      next.map((x) => x.note),
      cfg.confidenceFloor,
    );
    const sources = [...new Set(plan.moves.map((m) => m.subject.trim()))];
    const targets = [...new Set(plan.moves.map((m) => m.to.trim()))];
    const stillClaimed = (s: string) => next.some((x) => x.note.facts.some((f) => f.subject.trim() === s));
    out.emptied = sources.filter((s) => !stillClaimed(s));
    if (out.refused.length || opts.dryRun) return out;

    // The notes first: they are what every derived thing below is rebuilt from.
    for (const x of next) {
      if (!x.changed || !x.note.trailer) continue;
      writeFileAtomic(x.note.file, withFactsTail(x.note.md, { ...x.note.trailer, facts: x.note.facts, moves: x.note.moves }, x.note.retracted));
      out.notesWritten++;
    }
    const written = readAllNotes(cfg.vault);
    out.rebase = rebaseSubjects(store, [...sources, ...targets], written, cfg.confidenceFloor, at);

    // Search indexes a note's prose, and a note's facts section is prose.
    const projects = new Set<string>();
    for (const x of next) {
      if (!x.changed) continue;
      const n = readNote(x.note.file);
      if (!n) continue;
      const project = n.trailer?.project ?? n.fm["project"] ?? "unsorted";
      store.indexNote(n.sessionId, project, /^# (.+)$/m.exec(n.md)?.[1] ?? "", noteProse(n.md));
      projects.add(project);
    }
    for (const s of [...sources, ...targets]) {
      writeSubject(cfg.vault, store, s, store.kindOf(s));
      for (const p of store.projectsOf(s)) projects.add(p);
    }
    for (const p of projects) writeBrief(store, cfg.vault, p, cfg.briefMaxChars);
    writeInbox(store, cfg.vault);
    out.commit = new Git(cfg.vault, cfg.git).commit(
      `move: ${plan.moves.length} خانة من ${sources.length} موضوعاً إلى ${targets.join("، ")} · ${out.notesWritten} ملاحظة — ${plan.reason}`,
    );
    return out;
  } finally {
    store.close();
    release();
  }
}

export interface RestoreOutcome {
  /** Why nothing was restored; null when the slot was. */
  refused: string | null;
  /** The sessions whose notes hold the slot withdrawn and do not claim it — the one restored, or the ones to choose from. */
  candidates: string[];
  session: string | null;
  fact: Fact | null;
  rebase: RebaseOutcome | null;
  commit: string | null;
}

/**
 * `sila restore <subject> <key> [--session <id>]`: a withdrawn claim put
 * back, the mirror of `sila retract` — see restoreInNote for what it does to
 * the note and what it does not promise.
 *
 * The slot is restored in one note. A slot several notes withdrew — one
 * `sila retract` emptied everywhere — is ambiguous, and the caller names
 * the session; a slot moved out of the note is refused with its target. The
 * subject is then re-derived from all its notes, as after a move. `confirm`
 * restores at 1.0 — see restoreInNote.
 */
export function restoreSlot(
  cfg: Config,
  subject: string,
  key: string,
  opts: { session?: string | undefined; breakLock?: boolean; confirm?: boolean } = {},
): RestoreOutcome {
  const release = acquireLock(cfg.vault, { breakLock: opts.breakLock === true });
  const store = new Store(cfg.vault);
  try {
    const inSlot = (f: { subject: string; key: string }) => slotOf(f.subject, f.key) === slotOf(subject, key);
    const notes = readAllNotes(cfg.vault);
    const holding = notes.filter((n) => n.retracted.some(inSlot) && !n.facts.some(inSlot));
    const wanted = opts.session ? holding.filter((n) => n.sessionId.includes(opts.session as string)) : holding;
    const out: RestoreOutcome = { refused: null, candidates: wanted.map((n) => n.sessionId), session: null, fact: null, rebase: null, commit: null };
    const name = `${subject}.${key}`;
    if (!wanted.length) {
      const live = notes.find((n) => n.facts.some(inSlot));
      out.refused = live
        ? `${name} حيّة في ملاحظة ${live.sessionId} — لا شيء يُستعاد`
        : opts.session
          ? `لا ملاحظة لجلسة تطابق «${opts.session}» سحبت ${name}`
          : `لا ملاحظة سحبت ${name}`;
      return out;
    }
    if (wanted.length > 1) {
      out.refused = `أكثر من ملاحظة سحبت ${name}: ${out.candidates.join("، ")} — حدّد --session`;
      return out;
    }
    const n = wanted[0]!;
    const r = restoreInNote(n.file, subject, key, { confirm: opts.confirm === true });
    if (!r) {
      out.refused = `${name} لم تُستعد من ${n.sessionId}`;
      return out;
    }
    if ("movedTo" in r) {
      out.refused = `${name} نُقلت إلى ${r.movedTo.to}.${r.movedTo.toKey} في ${n.sessionId} — استعد الهدف لا المصدر`;
      return out;
    }
    out.session = n.sessionId;
    out.fact = r.fact;

    const at = new Date().toISOString();
    const written = readAllNotes(cfg.vault);
    out.rebase = rebaseSubjects(store, [subject], written.filter((w) => noteTouches(w, subject.trim())), cfg.confidenceFloor, at);
    const back = readNote(n.file);
    const projects = new Set<string>();
    if (back) {
      const project = back.trailer?.project ?? back.fm["project"] ?? "unsorted";
      store.indexNote(back.sessionId, project, /^# (.+)$/m.exec(back.md)?.[1] ?? "", noteProse(back.md));
      projects.add(project);
    }
    writeSubject(cfg.vault, store, subject.trim(), store.kindOf(subject.trim()));
    for (const p of store.projectsOf(subject.trim())) projects.add(p);
    for (const p of projects) writeBrief(store, cfg.vault, p, cfg.briefMaxChars);
    writeInbox(store, cfg.vault);
    out.commit = new Git(cfg.vault, cfg.git).commit(`restore${opts.confirm ? " --confirm" : ""}: ${name} ← ${n.sessionId}`);
    return out;
  } finally {
    store.close();
    release();
  }
}
