import type { RedactionResult } from "../types.js";

/**
 * The one component that is allowed to stop the pipeline.
 *
 * Contract: redact() runs on every byte before any network call. After
 * substitution it re-scans its own output. If a pattern still matches, the
 * session is marked unsafe and is never sent — it is quarantined for a human.
 *
 * Fail-closed, not fail-quiet. A bug here delays a note; it must not leak one.
 */

interface Rule {
  kind: string;
  re: RegExp;
  /** Replacement keeps a stable marker so the extractor still sees structure. */
  to: string;
}

const RULES: Rule[] = [
  { kind: "private-key-block", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, to: "[REDACTED-PRIVATE-KEY]" },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_\-]{20,}/g, to: "[REDACTED-ANTHROPIC-KEY]" },
  { kind: "openai-key", re: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{32,}/g, to: "[REDACTED-OPENAI-KEY]" },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA)[0-9A-Z]{16}\b/g, to: "[REDACTED-AWS-KEY]" },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, to: "[REDACTED-GITHUB-TOKEN]" },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_\-]{20,}/g, to: "[REDACTED-GOOGLE-KEY]" },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g, to: "[REDACTED-SLACK-TOKEN]" },
  { kind: "stripe-key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g, to: "[REDACTED-STRIPE-KEY]" },
  { kind: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/g, to: "[REDACTED-SENDGRID-KEY]" },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/g, to: "[REDACTED-NPM-TOKEN]" },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, to: "[REDACTED-JWT]" },
  { kind: "db-url", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@]+@[^\s"'`]+/gi, to: "[REDACTED-DB-URL]" },
  { kind: "basic-auth-url", re: /\bhttps?:\/\/[^\s:@/]+:[^\s@]{3,}@[^\s"'`]+/gi, to: "[REDACTED-AUTH-URL]" },
  { kind: "bearer", re: /\b(?:Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9._\-]{20,}/gi, to: "Bearer [REDACTED-TOKEN]" },
  { kind: "assigned-secret", re: /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'`,;]{6,})/gi, to: "$1=[REDACTED-SECRET]" },
  { kind: "ssh-key", re: /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{40,}/g, to: "[REDACTED-SSH-KEY]" },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9][ ]?){11,30}\b/g, to: "[REDACTED-IBAN]" },
  // Beneficiary and staff identifiers. Present in humanitarian case files and
  // never useful to an extractor, so they are removed unconditionally.
  { kind: "national-id", re: /(?<![\d.])\d{9}(?!\d)(?!\.\d)/g, to: "[REDACTED-ID]" },
  { kind: "credit-card", re: /\b(?:\d[ -]?){13,19}\b/g, to: "[REDACTED-CARD]" },
];

/** Patterns that must not survive redaction. Checked against the *output*. */
const VERIFY: Array<{ kind: string; re: RegExp }> = RULES.filter(
  (r) => !["national-id", "credit-card", "iban"].includes(r.kind),
).map((r) => ({ kind: r.kind, re: new RegExp(r.re.source, r.re.flags.replace("g", "") + "") }));

export function redact(input: string): RedactionResult {
  const findings: Array<{ kind: string; count: number }> = [];
  let text = input;

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    const matches = text.match(re);
    if (matches?.length) {
      findings.push({ kind: rule.kind, count: matches.length });
      text = text.replace(new RegExp(rule.re.source, rule.re.flags), rule.to);
    }
  }

  // Second pass: verify our own work rather than trusting it.
  // Markers are stripped first — otherwise "PASSWORD=[REDACTED-SECRET]" trips
  // the very rule that produced it, and a correct redaction reports unsafe.
  const probe = text.replace(/\[REDACTED-[A-Z-]+\]/g, "·");
  const survivors = VERIFY.filter((v) => v.re.test(probe)).map((v) => v.kind);
  const safe = survivors.length === 0;
  if (!safe) findings.push({ kind: `UNRESOLVED:${survivors.join("|")}`, count: survivors.length });

  return { text, findings, safe };
}

/** Cheap pre-check used to decide whether a session needs the full treatment. */
export function looksSecretive(input: string): boolean {
  return /sk-ant-|AKIA|ghp_|BEGIN [A-Z]*PRIVATE KEY|PASSWORD\s*=/.test(input);
}

/**
 * Defense in depth: the note itself is scrubbed before it touches the vault.
 *
 * The distilled text is redacted before it is sent, but a model can still echo
 * a secret it inferred, and the local extractor quotes the user directly. One
 * more pass here means no path into the vault bypasses the redactor.
 */
export function scrubNote<T>(note: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(note) as T;
}
