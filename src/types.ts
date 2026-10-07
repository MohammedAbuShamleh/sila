/**
 * The shared vocabulary. Everything past `adapters/` speaks only this.
 *
 * The whole architecture rests on one boundary: an adapter's job ends the
 * moment it produces a `RawSession`. Nothing downstream may ask which vendor
 * a session came from, and nothing upstream may know what a `Fact` is. That
 * is what makes "adapters are written once per agent, retrieval once" true
 * rather than aspirational.
 */

export type AgentId = "claude-code" | "codex" | "gemini";

export type CliName = "claude" | "gemini" | "codex";

/**
 * The CLI that belongs to the vendor a session's data has already been sent
 * to. A same-provider wall allows exactly this one and nothing else — see
 * constant 12: extraction must not widen the circle of who has seen the data.
 */
export const CLI_FOR_AGENT: Record<AgentId, CliName> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
};

export type Role = "user" | "assistant" | "tool";

export interface Turn {
  role: Role;
  text: string;
  /** ISO timestamp when the source carries one. */
  ts?: string;
  /** Comma-joined tool names. Only set on `role: "tool"` markers. */
  tool?: string;
}

/**
 * One session as it exists on disk, vendor shape already stripped away.
 *
 * `cwd` is nullable on purpose: Codex sessions whose meta line is missing and
 * Gemini sessions without a `.project_root` genuinely have no project. They
 * land in "unsorted" rather than being guessed into the wrong project.
 */
export interface RawSession {
  id: string;
  agent: AgentId;
  sourceFile: string;
  cwd: string | null;
  startedAt: string | null;
  endedAt: string;
  turns: Turn[];
  contentHash: string;
  /**
   * Paths the session's tools read or edited, in first-seen order. Paths
   * only — the contents went out with the tool results, on purpose.
   */
  files: string[];
}

/**
 * How to pick a session back up.
 *
 * `where` and `next` are the model's — the one thing a transcript cannot
 * say about itself is what its last step *meant*. `files` come from the
 * adapters, `resumeCommand` from the agent that owns the transcript.
 */
export interface Resume {
  where: string;
  next: string;
  files: string[];
  resumeCommand: string | null;
}

export type SubjectKind = "person" | "project" | "org" | "term" | "tool";

/**
 * A claim about one slot.
 *
 * `subject` + `key` together name the slot. Two facts sharing a slot are a
 * contradiction by definition, never two truths — that is the premise the
 * whole reconciler is built on, so keys must be narrow enough to be single
 * valued ("backend-framework", not "stack").
 */
export interface Fact {
  subject: string;
  subjectKind: SubjectKind;
  key: string;
  claim: string;
  /** 1.0 only for what a human stated outright. See reconcile.ts. */
  confidence: number;
}

/**
 * A fact that a later extraction of the same session no longer stood behind.
 *
 * Distinct from superseded: superseded means the world changed and a newer
 * claim replaced this one; retracted means *we were wrong* — the session was
 * read again and this claim was not there. Carried in the note's trailer so
 * `reindex` can replay the retraction rather than lose it.
 *
 * One exception, read off the note rather than stored: when the same note
 * fills the slot again, the claim was worded anew, not withdrawn, and is
 * filed as superseded by the new wording (claimInSlot, fileReplaced).
 */
export interface RetractedFact extends Fact {
  createdAt: string;
  retractedAt: string;
  /** Why it was withdrawn, when a human or the model said. Shown in the note. */
  reason?: string;
}

/**
 * A slot a human moved out of a session's note — `sila move`.
 *
 * Recorded in the note it was moved from, so a re-read of the session lands
 * the same claim where the move put it rather than where the model files it
 * again: the reading's claim under `subject.key` is filed under `to.toKey`
 * before the note is written (applyMoves in reconcile). The record rides
 * from one rewrite of the note to the next, as the retractions do. A move
 * that lived only in the note's facts was undone by the first re-read: the
 * six facts of b26a6056, on 2026-09-24.
 */
export interface MoveRecord {
  subject: string;
  key: string;
  to: string;
  toKey: string;
  kind: SubjectKind;
  at: string;
  reason: string;
}

/**
 * A claim the model no longer stands behind, named rather than repeated.
 *
 * The extractor is shown what memory currently holds; this is how it says
 * "that one is no longer true and nothing replaces it". A changed fact needs
 * no retraction — re-stating it under the same key supersedes it.
 */
export interface RetractRequest {
  subject: string;
  key: string;
  reason: string;
}

export interface Link {
  from: string;
  to: string;
  relation: string;
}

export interface Decision {
  what: string;
  why?: string;
}

/**
 * What one session is worth remembering as.
 *
 * Adding a field here is a schema change with a hard obligation attached: it
 * must be written into the `<!-- engine:facts -->` trailer and read back in
 * `cmdReindex`, or `sila reindex` silently stops being lossless. The trailer
 * currently carries the fields the database is derived from — facts, links,
 * project, and the retractions a re-extraction produced.
 */
export interface SessionNote {
  title: string;
  project: string;
  summary: string;
  did: string[];
  decisions: Decision[];
  rejected: Decision[];
  open: string[];
  facts: Fact[];
  links: Link[];
  /** Slots this session proved false with nothing to put in their place. */
  retract?: RetractRequest[];
  /** Written to the trailer and restored by reindex like everything else here. */
  resume?: Resume;
}

/**
 * One note as the replay reads it: whose it is, when the session happened,
 * and what its trailer holds. Everything the facts table is derived from.
 *
 * `date` is the session's date, not when the note was written or processed.
 * It is the one order both `scan` and `reindex` apply claims in: a session
 * processed late still lands where its date puts it, so an older session
 * never displaces what a newer one said.
 */
export interface NoteEvents {
  sessionId: string;
  date: string;
  facts: Fact[];
  retracted: RetractedFact[];
  links: Link[];
}

export interface RedactionResult {
  text: string;
  findings: Array<{ kind: string; count: number }>;
  /** false means: never send this anywhere. Quarantine it. */
  safe: boolean;
}

/** What one model call cost. Recorded per session so spend is auditable. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  /** Dollars, when the provider reports them (the claude CLI does). */
  costUsd?: number;
  /**
   * The CLI that answered; unset on the API path. What a scan tallies by:
   * one sum across providers would put priced and unpriced tokens together.
   */
  cli?: CliName;
}
