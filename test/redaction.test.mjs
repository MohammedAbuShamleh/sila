import assert from "node:assert/strict";
import { redact, scrubNote } from "../test-build/pipeline/redact.js";

/**
 * The redactor is the only component whose bugs are permanent: a leak cannot
 * be recalled, and a false positive quarantines healthy sessions forever.
 * So both directions are tested — what must be caught, and what must be
 * left alone.
 */

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    process.stdout.write(`\n✗ ${name}\n  ${err.message.split("\n")[0]}\n`);
  }
}

/**
 * The secret must be gone, by the rule meant for it, and the session must
 * remain sendable. The rule is named because samples overlap: with
 * anthropic-key off, the openai rule still masked sk-ant-…; with npm-token or
 * aws-access-key off, the assigned-secret rule masked _authToken= and
 * aws_access_key_id =. Checking only that the text was masked let three rules
 * die without a case failing.
 */
function caught(name, input, marker, rule) {
  check(name, () => {
    const r = redact(input);
    assert.ok(!r.text.includes(marker), `لم يُحجب: ${marker}`);
    const kinds = r.findings.map((f) => f.kind);
    assert.ok(kinds.includes(rule), `لم تحجبه ${rule} بل ${kinds.join("، ") || "لا شيء"}`);
    assert.equal(r.safe, true, `أُبلغ عن فشل الحجب: ${JSON.stringify(r.findings)}`);
  });
}

/** Ordinary text must survive untouched. */
function untouched(name, input) {
  check(name, () => {
    const r = redact(input);
    assert.equal(r.text, input, "تغيّر نص سليم");
    assert.equal(r.safe, true, "أُبلغ عن نص سليم كغير آمن");
  });
}

// ---- must be caught (18) ---------------------------------------------------
// Every sample shaped like a real credential is two literals joined at run
// time, a prefix and a body, so a secret scanner reading this file never sees
// one whole: GitHub's refused a push over them. What reaches redact() is the
// same string, character for character. All of them are made up; the AWS one
// is the example key from Amazon's own documentation.

caught(
  "private key block",
  "config:\n-----BEGIN RSA PRIVATE" + " KEY-----\nMIIEow" + "IBAAKCAQEA3x\n-----END RSA PRIVATE" + " KEY-----\ndone",
  "MIIEow" + "IBAAKCAQEA3x",
  "private-key-block",
);
caught("anthropic key", "use sk-ant-" + "api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 now", "sk-ant-" + "api03-AbCdEf", "anthropic-key");
caught("openai key", "OPENAI=sk-" + "proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN12345", "sk-" + "proj-abcdefghij", "openai-key");
caught("aws access key", "aws_access_key_id = AKIA" + "IOSFODNN7EXAMPLE", "AKIA" + "IOSFODNN7EXAMPLE", "aws-access-key");
caught("github token", "token ghp_" + "1234567890abcdefghijklmnopqrstuvwx", "ghp_" + "1234567890abcdef", "github-token");
caught("google api key", "key=AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q", "AIza" + "SyA1b2C3d4E5f6", "google-api-key");
caught("slack token", "xoxb-" + "123456789012-abcdefghijklmnop", "xoxb-" + "123456789012", "slack-token");
caught("stripe key", "sk_live_" + "abcdefghijklmnopqrstuvwx", "sk_live_" + "abcdefghijkl", "stripe-key");
caught("sendgrid key", "SG." + "abcdefghijklmnopqrstuv.wxyzABCDEFGHIJKLMNOPQRS", "SG." + "abcdefghijklmnop", "sendgrid-key");
caught("npm token", "//registry.npmjs.org/:_authToken=npm_" + "abcdefghijklmnopqrstuvwxyz1234", "npm_" + "abcdefghijklmnop", "npm-token");
caught(
  "jwt",
  "Cookie: eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIi",
  "jwt",
);
caught("db url with password", "DATABASE=postgres://admin:" + "s3cr3tpass@db.internal:5432/app", "s3cr3tpass", "db-url");
caught("basic auth url", "curl https://user:" + "hunter2pass@api.example.com/v1", "hunter2pass", "basic-auth-url");
caught("bearer token", "Authorization: Bearer " + "abcdefghijklmnopqrstuvwxyz123456", "abcdefghijklmnopqrst", "bearer");
caught("assigned secret", 'DB_PASSWORD="' + 'correct-horse-battery"', "correct-horse-battery", "assigned-secret");
caught("ssh public key", `ssh-rsa ${"A".repeat(60)} me@host`, "A".repeat(60), "ssh-key");
caught("iban", "IBAN: PS92" + "PALS000000000400123456702", "PS92" + "PALS0000000004", "iban");
caught("credit card", "card 4111 1111" + " 1111 1111 exp", "4111 1111" + " 1111 1111", "credit-card");

// ---- must NOT be caught (3) ------------------------------------------------
// The regression these guard: a version number is not a card, an issue number
// is not a national id, and a sentence about a password is not a password.

untouched("version numbers", "رفعنا Laravel 11.2.3 وأصلحنا PHP 8.3.11 معه");
untouched("issue and port numbers", "راجع القضية #1234 على المنفذ 5432 في الإصدار 2.10.4");
untouched("prose about secrets", "المستخدم يجب أن يغيّر PASSWORD من لوحة التحكم، لا من الملف");

// ---- an accepted cost, pinned so it stays deliberate ----------------------

check("any bare 9-digit number is masked, including harmless ones", () => {
  // The national-id rule cannot distinguish a beneficiary id from a 9-digit
  // issue number, and the file says it removes them unconditionally. That is
  // the right trade for humanitarian case files, but it is a real cost: the
  // session still goes through — only the digits are masked, and `safe` stays
  // true — so nothing is lost except the number itself. Pinned here so the
  // behaviour has to be changed on purpose rather than by accident.
  const r = redact("راجع القضية #123456789 اليوم");
  assert.ok(!r.text.includes("123456789"), "لم يُحجب رقم من تسع خانات");
  assert.equal(r.safe, true, "حجب سليم أدّى إلى حجر الجلسة");
  assert.ok(r.text.includes("راجع القضية"), "أتلف النص المحيط");
});

// ---- the three defects the README records ---------------------------------

check("national id followed by a full stop is still caught", () => {
  // The lookahead used to be broken by sentence punctuation, so an id at the
  // end of a sentence slipped into the vault.
  const r = redact("رقم هويته 407123456. تم التحقق.");
  assert.ok(!r.text.includes("407123456"), "تسلّل رقم هوية قبل نقطة");
});

check("google key one char longer than the old fixed length is caught", () => {
  // The rule was {35} exactly; a 40-char key failed silently.
  const long = `AIza${"b".repeat(40)}`;
  const r = redact(`key=${long}`);
  assert.ok(!r.text.includes(long), "مفتاح Google أطول من المتوقع لم يُحجب");
});

check("a correct redaction is not reported as failed", () => {
  // The verify pass used to match its own replacement: PASSWORD=[REDACTED…]
  // re-triggered the rule that produced it, so healthy sessions were
  // quarantined forever. This is the single most costly of the three.
  const r = redact('PASSWORD="' + 'correct-horse-battery"\nAPI_KEY=' + "abcdef123456");
  assert.equal(r.safe, true, `فحص التحقق طابق بديله: ${JSON.stringify(r.findings)}`);
  assert.ok(!r.findings.some((f) => f.kind.startsWith("UNRESOLVED")), "أُبلغ عن UNRESOLVED زائف");
});

// ---- scrubNote walks the whole structure ----------------------------------

check("scrubNote redacts nested strings and arrays", () => {
  const note = {
    title: "مفتاح sk-ant-" + "api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ في الملف",
    did: ["شغّلنا AKIA" + "IOSFODNN7EXAMPLE"],
    facts: [{ subject: "x", key: "k", claim: 'TOKEN="' + 'abcdef1234567890"', confidence: 0.9 }],
    open: [],
  };
  const out = scrubNote(note);
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes("sk-ant-" + "api03-ZZZ"), "لم يُحجب في title");
  assert.ok(!flat.includes("AKIA" + "IOSFODNN7EXAMPLE"), "لم يُحجب داخل مصفوفة");
  assert.ok(!flat.includes("abcdef1234567890"), "لم يُحجب داخل كائن متداخل");
  assert.equal(out.facts[0].confidence, 0.9, "غيّر قيمة غير نصية");
});

process.stdout.write(`\nredaction: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
