# القرارات · Decisions

رسائل الـcommits التي بُني بها المشروع، بترتيبها الزمني. هذا توثيق لا تاريخ: المستودع العام بدأ بلا تاريخ، وهذه رسائل المستودع الخاص الذي سبقه، كما كُتبت — وفيها لماذا كُتب كل سطر، وما الذي انكسر قبله، وما قرّره المستخدم.

The commit messages this project was built with, oldest first. Documentation, not history: the public repository starts with none, and these are the messages of the private one before it, as written — why each change was made, what broke before it, and what the user decided.

- **الأسماء.** نُظّفت بالقاعدة التي تتبعها الاختبارات: لا اسم مشروع أو كلاس أو ملف أو مسار أو شخص من عمل المؤلف الحي. كل اسم حقيقي صار اسماً مصطنعاً بالشكل نفسه، ثابتاً في الملف كله وفي الاختبارات: `acme` و`beta` و`gamma` و`delta` و`epsilon` و`dojo` مشاريع، و`BillingService` و`CheckTeam` و`OrderDraft` كلاسات، و`X9-42` تذكرة. رسالتان كانتا قائمة الاستبدال نفسها، فرُويتا بلا أسمائها.
- **الإشارات.** الـhash المختصر في رأس كل رسالة هو ما تشير به الرسائل بعضها إلى بعض («أُصلح في `c060230`»)؛ لا وجود له في هذا المستودع.
- **`CLAUDE.md`** المذكور كثيراً هو عقد المشروع الداخلي، ولا يُنشر. و`mem` هو اسم الأمر قبل `sila`.
- **معرّفات الجلسات** (`b46e21ae`…) و**commits المخزن** («commit المخزن `4d4180f`») تخصّ مخزن المؤلف وجلساته، وتُركت لأنها لا تدلّ على شيء خارجه.

180 commit، من 2026-09-14 إلى 2026-10-07. الأوقات بتوقيت المؤلف (+03:00).

## 2026-09-14

### `cb44b11` · 23:04 · baseline: reconstructed tree, 32 tests passing

### `11d44ce` · 23:05 · chore: pin LF line endings so autocrlf does not rewrite the tree

### `e860848` · 23:06 · dry-run: list every distinct cwd with its session count

The walls are written from folder paths, and a project slug says nothing
about where a folder lives. Grouped by canonical path so a folder spelled
two ways by two agents counts once; unabridged, sorted by count.

### `dc0be89` · 23:20 · scan: --project \<slug\> filters one project, composes with --force

The filter sits in the fingerprint gate, before --limit is consumed, using
the cheap cwd probe; it skips only on a positive mismatch and prepare()
decides from the full parse. Fingerprints are untouched: reprocessing a
project after a prompt change is --project X --force. The vault commit
message now records the scope (--project/--agent/--force) so a partial
scan is legible in git log.

### `094ba6c` · 23:23 · vault: note path from date, agent and short id — never the title

A re-extraction may change the title; with it in the filename the old
note stayed beside the new one and reindex replayed both. Now the path
is stable per session and the note is rewritten in place. No migration;
the vault is experimental. Adds CLAUDE.md with the constant-1
clarification: derived artifacts are regenerable, git keeps what was.

### `da93303` · 23:35 · facts: retracted state — a re-reading withdraws what it no longer claims

A fact whose session is extracted again and no longer yields it gets
retracted\_at, leaves liveFacts, and appears under «سُحب» in the subject
file. Distinct from superseded: the world did not change, the earlier
reading was wrong. What it had superseded does not come back. Facts at
confidence 1.0 are never retracted, and a local (fact-less) re-extraction
retracts nothing. Retractions ride in the note trailer and reindex
replays them in order, so the rebuild is still lossless. Four new
reconcile tests.

### `f8ae958` · 23:38 · walls: a session with no cwd is local-only by construction

Unknown is not unclassified. A folder the user never listed was at least
seen; a session with no cwd could have come from anywhere. wallFor now
returns a synthetic local-only wall for it, so it fails closed the way
the redactor does, and files under "unsorted".

### `7013935` · 23:42 · init: keep an existing engine.config.json — never erase the walls

Re-running init used to rewrite the config with walls: \[\], which would
silently turn every local-only folder back into a network one. Existing
configuration is preserved; only sources never detected are filled in.

### `a4bc338` · 23:47 · three fixes: codex noise, index prose only, briefs on accept/reject/reindex

codex: \<turn\_aborted\> notices are dropped and the desktop app's
PLEASE IMPLEMENT THIS PLAN banner is stripped from the plan it prefixes.
index: scan and reindex both index noteProse(md) — frontmatter and
trailer excluded — so snippets no longer show session: lines and the
two paths cannot disagree. briefs: accept and reject regenerate the
affected project's BRIEF.md, and reindex writes every project's.

### `56db7f0` · 23:48 · config: default extractor model is claude-sonnet-5

A bulk extractor over hundreds of sessions; the current Sonnet at
$2/$10 per million tokens is the deliberate default, one config field
away from Opus when a project proves to need it. README example updated.

## 2026-09-15

### `771af9b` · 00:04 · reindex: stamp facts with the note's date, not the rebuild's clock

reconcile takes an optional 'at'; reindex passes the note date (and a
retracted fact's own createdAt). created\_at and superseded\_at now say
when something was learned. Two tests.

### `8d32856` · 00:04 · CLAUDE.md: the two retraction guards become constants

Constant 5 gains: a fact a human confirmed at 1.0 is never retracted.
Constant 11: the local extractor neither retracts nor supersedes — its
silence is not evidence.

### `14b292d` · 00:06 · CLAUDE.md: current state and next tasks after today's commits

Status reflects what was actually run: three adapters on real files,
26 + 12 tests, --project, retraction, walls, briefs everywhere. The
model path stays listed as never run. Task list trimmed to what is
left: first live run (with permission), cost tracking, Gemini re-check
on CLI updates, Cursor adapter.

### `9fb4086` · 00:14 · extractor: cli provider — the installed agent CLIs as bare model calls

provider "cli" runs claude / gemini / codex in print mode from an empty
temp directory, in the order cliOrder gives (default gemini, codex,
claude; a missing one is skipped, a failing one is skipped with its
reason). claude: --safe-mode --tools "" --system-prompt --no-session-
persistence --output-format json, flags read from claude --help 2.1.251;
--bare was rejected because it demands an API key. gemini: -p appended
to stdin, -o json, --approval-mode plan, from gemini --help 0.59.0.
codex: unverified, not installed here. The child gets no ANTHROPIC\_API\_KEY
and no CLAUDECODE\_\* variables. Sessions a persisting CLI leaves in the
neutral directory are skipped as self. doctor shows which CLIs exist;
the scan summary shows calls, tokens and reported cost.

### `2711fea` · 00:16 · scan: an unplaceable file is parsed at the gate, not passed through

With --project, a file whose cwd the probe cannot read used to take a
--limit slot on the promise that prepare() would decide. The unplaceable
files are the oldest, empty transcripts; --limit 3 spent all three slots
on them and never reached the project.

### `9bce648` · 00:18 · cli: spawn the bare command name, never the path where.exe printed

where.exe writes in the console code page; a non-ASCII home directory
came back mangled and spawn hit ENOENT. The OS resolves a bare name
through PATH correctly; where is consulted only for existence and the
extension (.exe → argv, .cmd → shell).

### `225366f` · 00:20 · cli: name a failed call 'error', not the CLI's subtype

Observed live: an authentication failure arrives as subtype "success"
with is\_error true, so the message read 'success: Failed to
authenticate'.

### `0a3ef57` · 13:51 · walls: same-provider mode — extraction never widens who has seen the data

sameProvider (default true for every wall, unlisted folders and unknown
cwd) confines a session to the CLI of the agent that produced it: codex
to codex, gemini to gemini, claude-code to claude. No fallback to another
CLI, to the API, or to a local note: a missing or failing CLI leaves the
session pending-extraction (row status + detail, listed in
\_inbox/pending.md and mem stats) and the fingerprint gate retries it on
the next scan. Old config files are migrated in place and the migration
is printed. Constant 12. test/policy.test.mjs proves the confinement
through a runner seam.

### `56440d0` · 13:52 · project = repository root, not the cwd

projectRootOf walks up to the first .git; projectOf names a session after
that root when no wall claims it, and projectDirOf gives the directory a
brief belongs in (wall path, else root, else cwd). Codex started in a
subfolder now files under the same project Claude Code sees at the top.
Five tests.

### `710f2b0` · 14:12 · resume: where the session stopped, the next step, touched files, and the command that reopens it

SessionNote.resume = { where, next, files, resumeCommand }. where/next
come from the model (SYSTEM gained an «الاستئناف» section; the local
note uses the last user sentence for where). files come from the
adapters — paths named in tool\_use inputs, Codex apply\_patch bodies and
Gemini functionCall args; never contents. resumeCommand comes from each
adapter: claude --resume \<id\>, codex resume \<id\> (unverified), and
gemini --list-sessions since 0.59 cannot resume by id. Written to the
note and its trailer, restored by reindex into sessions.resume\_json, and
rendered as the first section of BRIEF.md and memory\_get\_brief from the
latest session only. Eight adapter tests.

### `eb6e8c7` · 21:12 · hook: Claude Code SessionEnd hook, scan lock, brief auto-inject, freshness stamp

mem hook install|uninstall|status writes one SessionEnd entry into
~/.claude/settings.json (or --file) in exec form — node and dist/cli.js
by absolute path, no shell — running scan --agent claude-code --limit 1
--detach; idempotent by marker, removable alone, refuses a settings file
it cannot parse. --detach re-launches the scan detached and logs to
\<vault\>/.index/hook.log so a session's exit never waits. Three safeties:
a scan lock per vault (util/lock.ts; stale locks from dead pids are
taken over), BRIEF.md injected after every scan into the agent files of
each touched project's folder (briefSync), and a freshness stamp with
an instruction as the brief's first line. Codex and Gemini: mem watch
--interval 60, documented. Nine tests.

### `ad0ec82` · 21:14 · CLAUDE.md: state after same-provider, root project, resume and hook

Status lists what was actually run — 68 tests in six files, the lock
proven with a live Windows pid, watch cycling, --detach logging, hook
install exercised on a settings copy and not on the real file. The
model path and the codex branch stay marked never run / unverified.

### `44ea7ae` · 21:28 · extract: confidence anchored to evidence — 0.95 said, 0.85 shown, 0.6 inferred; 1.0 stays reserved

### `95753d4` · 21:29 · keys: closed lexicon in the prompt; a claim re-filed under a new key is the same slot, in reconcile and in retraction

### `b512b29` · 21:30 · extract: a fact is what the agent cannot read off the code — descriptions and critique are not facts

### `c648125` · 21:32 · extract: the reply schema rescues — numbers become text, a broken list item is dropped alone and reported, a missing title falls back

### `23af72a` · 21:33 · scan: a local note never overwrites a model note — the DB kept facts the Markdown had lost, which reindex cannot rebuild

### `4f3af45` · 21:36 · hook: scan --file \<transcript\> and --from-hook — the session that ended is the one scanned, not the oldest changed file

### `d1e8f02` · 21:41 · inject: CLAUDE.local.md in git repositories, per-project inject:false, a one-time warning before writing into a file the repository will carry, README on not publishing the brief

### `f996350` · 21:49 · CLAUDE.md: the model path has run live — mechanism proven, extraction quality not yet

### `d0a1f8a` · 21:49 · extract: empty arrays are the expected answer; a code description never fills a fact slot, even when nothing else would

### `ba1195c` · 21:51 · gemini: --skip-trust — the neutral temp cwd is untrusted, which overrode --approval-mode and exited 55 before stdin was read

### `a42e469` · 21:59 · extract: config files are not facts, gotcha.\<noun\> is the most valuable kind, one slot holds one value

### `b4d3ea8` · 22:01 · brief: the pending section comes from the latest session only, like the resume block

### `4b73e57` · 22:01 · resume: temp, scratchpad and memory paths are not resume files; past fifteen, the most recently modified win

### `00e78d1` · 22:10 · extract: a fact is the state at the session's end — a problem solved in the same session is recorded as its solution, never as the problem

### `d05f407` · 22:15 · retract: mem retract \<subject\> \<key\> --reason — the slot is emptied in every note that claims it, or reindex brings it back

### `fb3328b` · 22:17 · extract: show the model what memory holds, and let it name what the session made false — retract goes through reconcile as a withdrawal

### `6fc8d25` · 22:26 · schedule: mem schedule install|uninstall|status — a hidden Task Scheduler job every fifteen minutes on Windows, printed launchd/cron elsewhere

### `b7bc805` · 22:27 · CLAUDE.md: retract, the scheduled task, and extraction with context

## 2026-09-16

### `2a3bcb2` · 23:47 · extract: a transient state is not a fact — what is still true in a week is

Third exception class beside code descriptions and critique: a login, an
unmerged branch, a pending test, a failed call. The example is the live
fact that prompted it (constraint.claudecli), which mixed a lasting rule
with a session state; the prompt now says to keep only the lasting part,
and to put a state that needs action in resume.next or open.

### `bfb77fa` · 23:59 · keys: a drifted key lands on the live slot it drifted from

factsContext now tells the model to reuse the subject's live keys and
not coin one that resembles a live key. The code guard: same subject,
same prefix, same first six characters of the noun -\> the existing key,
oldest first; a noun under six characters is compared whole, so
stack.db and stack.dbx stay apart. It runs in the scan before the note
is rendered, so the trailer records the canonical key and reindex
replays exactly what the scan applied. Not inside reconcile: reindex
feeds retracted entries back through it, and a remap there would
supersede the live slot and then withdraw the successor. Retraction keys
stay exact. Four tests, one pinning reconcile itself as exact.

## 2026-09-17

### `e6e8c2b` · 00:42 · schedule: scope the logon trigger to the user and start the cycle without waiting for a logon

The first real registration failed with Access is denied: a LogonTrigger
with no UserId means "at logon of any user", which only an administrator
may register. Scoped to the installing user, it registered — and then
reported Next Run Time: N/A, because a repetition hung on a logon
trigger starts at the next logon. A TimeTrigger now starts the cycle one
interval after install (not at once, so installing does not launch a
scan over one the user is about to run) and repeats indefinitely across
reboots; the logon trigger stays for the catch-up run. Installed for
real: hook in ~/.claude/settings.json, task registered, next run set.
Two tests; CLAUDE.md records both installs.

### `fdaa236` · 12:40 · CLAUDE.md: the first full scan — what ran, and three defects it exposed

The lock is taken from a live scan once it is thirty minutes old, and a
machine that sleeps mid-scan makes that certain. The six-character root
merges distinct facts, because real keys are hyphenated compounds whose
first six characters name the entity, not the slot. And a scan applies in
processing order while reindex applies in session date, so a pending
session retried late becomes current over newer ones and constant 3 does
not hold: a reindex of a copy changed 34 of 300 live slots.

## 2026-09-18

### `e5f7fc0` · 15:52 · inject: a file git would publish stops the injection and writes inject:false — a warning in a detached scan's log protected nothing

Before any write into a project folder, git is asked about CLAUDE.local.md
(or CLAUDE.md), AGENTS.md and GEMINI.md. One that is tracked, untracked and
not ignored, or in a repository git cannot be asked about, stops the
injection for that project: nothing in the folder is touched, and
"inject": {"\<project\>": false} is written into engine.config.json so the
stop outlasts the run. Only the user lifts it — by removing the entry once
the files are ignored, or by setting it to true, which is the explicit
approval to write even into a file git carries.

The once-per-file warning and its .index/inject-warned.json ledger are gone:
the first full scan spent all eighteen warnings in hook.log while fifteen
digests sat untracked in five repositories.

### `c98d937` · 16:30 · order: the session date decides, in scan and reindex alike — an older session no longer displaces a newer one

A scan used to apply each session's claims the moment it read them, so the
processing order decided which claim held a slot: a session whose CLI failed
and was read later, a --force re-read, or two sessions ending in the
reverse of the order they began, let an older claim supersede a newer one.
reindex replayed by session date and disagreed with the index it rebuilt —
34 of 300 live slots on the real vault. The index could not have known
better: a claim that only restated the live one left no row behind.

Now the scan writes the note, then re-derives every subject the note — or
the reading it replaced — mentions from all the notes that mention it, in
session-date order, with replayNote: the one function reindex applies every
note with. The replay runs in a scratch store and is laid onto the index by
pairing rows verbatim on session, key and claim; links and dates follow the
replay, a claim with no row gets one, a row no note supports is withdrawn,
and one its own session's note now words differently is superseded by that
wording. No row is deleted. The queue follows the same replay, keeping a
decision already taken. `mem accept` writes no note, so an accepted claim is
replayed as a 1.0 claim at the moment of the accept.

A named retraction no longer reaches a claim from a newer session, and a
replayed withdrawal no longer knocks a stronger claim off its slot — the
old reindex path retracted the live claim whenever the guard queued the
withdrawn one. reindex refuses to replay onto a database it could not delete
instead of doubling every claim, and moves to pipeline/reindex.ts.

test/order.test.mjs drives the real scan (runner seam, no model) over four
sessions read as 3, 1, 4, 2 September, then a --force re-read, and checks the
rebuild from the notes alone gives exactly the scan's slots after each.
Making byDate return 0 fails it the way the old code failed.

On a copy of the real vault: a full rebase of the index the old code built
gives 306 of 306 live slots identical to reindex — claim, key and session.

### `0e85cbc` · 16:36 · keys: one slot only when two keys differ in case, dash or plural — the six-character root merged different facts

The root rule mapped a key onto a known one sharing its prefix and the first
six characters of its noun. Compound keys start with the entity, not the
slot, so it filed tender-delete as tender-items and bundle-duplicate as
bundle-write: 71 remaps in the first full scan's logs, and a merged slot
hides one fact behind another as "superseded".

sameKey now compares keys segment by segment and word by word, equal once
letter case, dash against underscore, and a plural ending are set aside —
nothing else. The other way two keys become one slot stays what it was:
liveTwin, when the claim itself is already live under another key. Every key
the subject ever had counts as known, live or not, so a claim in an emptied
slot lands on its history instead of a second spelling.

On the 596 keys in the vault and the logs' original keys, the rule merges
three pairs — gate/gates, calculated-beneficiaries/\_beneficiaries,
ticket-exposure/tickets-exposure — and keeps 70 of the 71 root remaps apart.
Reinstating the root in dist fails four of the new cases.

### `190cbd8` · 16:45 · lock: a live holder keeps the lock however old it is; --break-lock for the rare case

On 2026-09-17 a scan slept eleven hours mid-run. The first hook after waking
found a lock older than STALE\_MS, took it although its pid was alive, and
on finishing deleted the lock file while the first scan still ran; the
scheduled scan then found the vault unlocked and ran alongside it for
seventeen minutes. Age says nothing about a machine that slept.

The lock is now taken over only when its holder's process is gone. A lock
that cannot be read counts as held — it is what another scan sees between a
holder creating the file and writing into it. The holder writes a token,
and release deletes the file only while it still holds that token, so a
scan whose lock was broken no longer unlocks the vault under the scan that
broke it.

--break-lock takes the lock from a live holder and says so on stderr: for a
hung scan, or a pid the system has handed to another program. scan and
reindex take it; watch refuses it, since every cycle would break someone
else's lock. reindex now takes the lock at all — it deletes the index a
running scan is writing into.

### `50c549d` · 16:51 · spawn: windowsHide on every child process — a detached scan flashed a window for each CLI and git call

A scan started by the hook or the scheduler runs detached, with no console
of its own, so every console program it starts gets a new console window:
the agent CLI, where.exe, each git call, schtasks. --detach already hid the
scan itself; now claude/gemini/codex, where.exe, git (commit and the
publication check) and schtasks are started hidden too.

Checked by running it. A fake claude.exe, compiled from C#, records its own
console window and answers like `claude -p --output-format json`; PATH for
the run drops ~/.local/bin, so the real CLI could not be reached.
- Control, from a detached node like --detach: without windowsHide the fake
  got a visible window and a watcher enumerating top-level windows saw a
  new Windows Terminal window; with it, no console window at all (0).
- The real `mem scan --vault <temp> --detach`: the fake reported console
  window 0, the vault got its commit through git, the publication check ran
  git three times and stopped the injection, and the watcher saw no new
  visible console window in 299 polls over the whole run.

### `7f9c3f7` · 16:52 · inject: the stop is said once, with the folder once — the detached run printed it twice into hook.log

syncProjects wrote the report to stderr and returned it for mem scan to
print on stdout; a detached scan sends both into hook.log, so every stop
appeared twice, each line carrying the folder's full path three times. The
report now comes back with the result only, naming the folder once and the
files by name.

### `35940d6` · 17:05 · CLAUDE.md: the four fixes, their constants, and what is left in the real vault

Constants 13–16 record today's decisions: the session date orders claims in
scan and reindex alike, two keys are one slot only after case, dash or
plural, a file git would carry stops the injection and writes inject:false,
and a live holder keeps the lock. Constant 1 states its extension: links are
derived from the notes and re-laid by the rebase; no row is deleted.

The real vault is untouched: its index is still the one the old code built
(38 slots off reindex), and 35 sessions' notes still carry keys the root
rule merged — counted from the two .index logs, with the cost of repairing
them. The scheduler and the hook are uninstalled and stay that way.

### `c3eff74` · 17:20 · rebase: mem rebase — the index brought into line with its notes in place, without what reindex costs

reindex deletes the database: pending ids renumber, decisions on queued
claims are lost, and every session's fingerprint becomes REINDEXED, so the
next scan re-reads every transcript through the model. mem rebase replays
every subject from the notes in session-date order onto the index as it
stands, with rebaseSubjects — rows, queue ids and fingerprints kept, nothing
deleted — and rewrites only the subject files and briefs whose facts moved,
then commits. It is how an index built before the session date decided the
order is aligned.

rebaseSubjects now reports which subjects it changed. Tested on an index
built the old way (the older session applied last, over the newer): the
rebase restores the newer claim, keeps both fingerprints and the row count,
a rebuild of a copy lands on the same slots, and a second run changes
nothing. Emptying the subject list in dist fails it.

### `84a6da0` · 20:11 · extract: a session is shown the memory of its own day — a late or re-read session gave its facts up to what newer sessions knew

The extractor was shown today's live facts, and the prompt tells it not to
repeat what memory holds. A session read late — a --force re-read above all —
was judged against memory that newer sessions had filled, and gave up what
they had learned or restated: on 2026-09-18 the re-read of cbe087c0 (18 July)
came back with none of its three facts, among them a gotcha no other session
holds and the fact whose key the root rule had merged, the one the re-read
was meant to restore.

The context is now liveFactsAsOf: every note of an earlier session, and
every accept made before then, replayed as reindex would, strictly before
the session's date, narrowed to the project's sessions. For a new session —
the latest — that is today's memory, as before; for a late one it is the
memory of its own day. Constant 13 applied to what the model reads.

The order test now records what each session was shown: 1 September, read
after 3 September, sees nothing; 2 September sees 1 September and nothing
later; its --force re-read sees neither its own earlier reading nor anything
after it. Showing today's memory in dist fails both.

### `ba199d9` · 20:46 · CLAUDE.md: the real vault aligned and its 35 sessions re-read — and the subjects that scattered doing it

The alignment (mem rebase, after a verified full backup) and the --force
re-reading of the 35 sessions ran with the user's permission; reindex on a
copy matched the vault after each. The re-read fixed what it was for — no
note holds two facts under one key — and exposed what the prompt never
said: what a subject is. Facts of the 35 sessions spread from 14 subjects
to 86, audit item ids and class names among them. Keeping, reverting, or a
subject rule and another pass is the user's call.

### `9f81cdb` · 20:55 · rebase: an item set aside as obsolete waits again when its note raises it again

A rebase marks a queued claim obsolete when no note raises it any more, and
pairing kept whatever status the row had. So once a re-read dropped a claim,
reverting the re-read brought the claim back to its note but left it out of
the inbox for good. obsolete is the replay's word, not the user's: a raised
claim paired with an obsolete row waits again; accepted and rejected stay.

### `a1524dc` · 20:59 · rebase: a note put back by hand brings back its resume block and its search text too

The brief's resume block and mem search both read the index, not the note.
After a reverted re-read, mem rebase restored the facts and the queue while
the brief kept quoting the undone reading's resume and search still found
its prose. The rebase now refreshes each session's search row and resume
from its note, rewrites the briefs whose resume moved, and commits when
only a resume moved.

### `57dd4bc` · 21:02 · rebase: a queued claim no fact holds, and the links, follow the notes too

mem rebase visited the subjects of fact rows and notes. A claim below the
floor never gets a fact row, so once its note was reverted its subject was
visited by nothing and the item kept waiting — four such items from the
reverted re-reads were still in the inbox, under subjects like
'acme.convention.commits'. The queue's subjects are now rebased too. And
links, only ever added, kept the 23 pairs of the reverted readings: the
rebase now lays them again from the notes in session-date order, as
reindex does.

### `4180d04` · 21:05 · extract: define the subject — a lasting entity people know by name; a file, a class, a ticket or a concept inside the project is not one

The prompt told the model which keys a fact may take and never what its
subject may be. Re-reading 35 sessions spread their facts from 14 subjects
over 86: audit item ids (X9-42), classes (BillingService), files
(CLAUDE.md). The user's definition, word for word: a subject is a project, a
person or a general tool; a fact about part of a project belongs to the
project, under a key that names the part — the example given is
acme.arch.billing-service. subjectKind narrows to project, person,
tool. And the live subjects the context will carry are to be reused: no
new subject where an existing one serves.

### `edef841` · 21:23 · subjects: the context names the project and its live subjects; a new subject named like a file, a class or a ticket goes back to the project

The extractor was shown facts but never which subjects exist, and a session
read against an empty memory — the oldest, under the dated context — had no
name to file anything under. factsContext now opens with the project's name
and every live subject as of the session's date, uncapped by the forty-fact
limit, and says to reuse them. Only the project's own facts and subjects are
shown, so nothing crosses a wall.

The code backstop, anchorSubjects, runs on the model's facts before the note
is written. A subject already live anywhere in the vault as of the session's
date passes: history is not its to rewrite. A new one that is another
spelling of a live one — case, dash, underscore — takes the vault's
spelling. A new one named like a ticket (X9-42, #12), a file or dotted name
(CLAUDE.md, ACME.CheckTeam) or a class (BillingService) moves to the
project, kind project, under a key built from the key's prefix, the part's
words and the key's own words, so two facts about one part never meet in one
slot: BillingService · arch.status ← acme · arch.billing-service-status.
A subject the model called a tool or a person is left alone — a general
tool is a subject by definition, and many are PascalCase. A concept inside
the project matches no name pattern; the prompt is what catches that.

Every move is printed like a key remap and counted in the scan summary.
Turning the guard off, or dropping the subject list, fails the new tests.

### `5056731` · 21:32 · subjects: a live subject named like a file, a class or a ticket is not offered for reuse; a path is never excused

The first real context the new code built — for 97c97962, as of 6 September
— offered lib/handlers.rb, OrderDraft, acme.constraint.eslint and
PowerShell/git stash as subjects to reuse, left in the vault by readings
from before the definition, in the same breath as the definition saying a
file is not a subject. factsContext now offers only what anchorSubjects
would accept as new: one rule, partOfProject, for both. It takes the kind:
a tool or a person keeps a class-like, dotted or numbered spelling
(PowerShell, Node.js, gpt-4); a path is excused for nothing, since
PowerShell/git stash names a use, not a tool. The facts under those old
subjects still show: they are memory, just not examples.

### `017c6d0` · 21:36 · CLAUDE.md: the restoration reverted, the subject defined, and one session re-read under the definition

Constant 17 records the user's definition of a subject and the guard that
backs it. The reverted restoration is proven back to 306 live slots and 41
subjects, and reverting it exposed five gaps in mem rebase, now fixed. One
session — the one that had scattered worst — re-read under the definition
came back with ten facts under the project and no invented subject. The
other 34 wait for the user.

## 2026-09-23

### `4feaee1` · 22:07 · reread: a claim said again under the same key in other words is replaced, not withdrawn

A re-read of 97c97962 said arch.checkteam in new words, and the history filed
the old wording under «سُحب» beside the new one — as if the first reading had
been wrong about the slot. The trailer still records every earlier wording (or
reindex could not rebuild its row); the replay now files one whose slot the
same note fills as superseded by the note's claim, chained oldest first, and
only when that claim took the slot. What ends up live does not change.

On a copy of the real vault, mem rebase: 309/309 live slots and 12/12 queue
verbatim, 831 rows before and after, 33 labels retracted → superseded and
nothing else; reindex on a copy of that gives the same labels on all 642 rows
it rebuilds.

### `8c77c23` · 22:19 · CLAUDE.md: a reworded claim is replaced, three of the 34 re-read, and the stop at acme\_server

### `63e38dd` · 22:49 · move: mem move --plan — slots filed under a subject the definition does not admit, moved by hand in the notes

The first full scan left 61 live slots under a folder of the repo, a class, a
concept or another spelling of the project, and no rule tells a concept from an
entity. A plan names each slot and its target; every note that claims the slot
files the claim under the target — words, confidence and date unchanged — and
records the old slot among its withdrawals with the target in the reason, so a
rebuild makes the same rows the rebase does. The whole plan is checked first: a
target the vault has ever known, a source no note claims, a duplicate source —
one refusal refuses the plan. --dry-run prints the moves and what the notes
would give after, and writes nothing.

The tail rewrite mem retract used is now shared (withFactsTail).

### `03e561a` · 23:16 · subjects: what the guard rejects is not shown to the model — a folder of the project is a part of it, live or new

acme\_server is a folder of the acme repo. No shape rule caught it, so the list
of live subjects offered it for reuse, and a re-read on 2026-09-23 filed its
facts there again. The folders at the project root are now asked: a subject
spelled like one (acme\_client against acme-client/) is a part, and a new one
goes to the project under a derived key; a tool or a person is excused, as for
the other shapes. The context shows neither the subjects the guard rejects nor
their facts — shown, they taught the name back. The cost: a session cannot
supersede what it is not shown; mem move is the remedy.

On the real vault after the move, one live subject is rejected: gamma-site,
a folder under the project's folder — and the whole memory of that project.

### `95b708c` · 23:21 · extract: a reply cut off or garbled mid-JSON is asked for once more, and both calls are counted

3 of the first full scan's 173 calls came back with JSON that broke off or did
not parse, and so did 2952933d on 2026-09-23; the same call again answered
whole each time. The call failed, not the session, so it is asked once more,
said on stderr, and the reading that lands is judged like any other. Both calls
count toward the tally and the per-run budget, and both are paid for. A second
garbled reply fails as before; a reply with no JSON at all is not asked again.

### `ef1f1bd` · 23:32 · CLAUDE.md: the move, the folder rule, the retry, and five of the 31 — stopped at 461b6fab

## 2026-09-24

### `03f69f8` · 00:29 · scan: two unreadable replies are kept in .index/garbled, and --max-chars reads one session through a smaller window

461b6fab came back garbled twice on 2026-09-23, at two different places, and
nothing of either reply survived to say whether it was cut off or held a stray
quote. When the retry fails too, both replies are written to .index/garbled —
redacted first, like everything that enters the vault, and withheld if the
redactor cannot vouch for them. --max-chars caps the distilled session for one
run; the vault's commit names it, so a reading made through a smaller window
says so in the history.

### `ab8dc20` · 00:34 · doctor: each live subject the guard now rejects, with its facts and its project — before it goes silent

A live subject the guard rejects is hidden from its project's extractor, and no
session reaches its facts again. The folder rule did that to gamma-site on
2026-09-23 — the whole memory of gamma — and nothing said so. doctor now
judges every live fact by the rule the scan uses, with the folders of the
project whose session filed it, and names what it finds.

### `2d028e4` · 00:50 · CLAUDE.md: 461b6fab read on the third try, gamma-site moved, doctor's check, and five of the 26 — stopped at tooling

### `beffd46` · 10:48 · subjects: a tool is shown with the line that says what it admits, or not at all — tooling, by name alone, took a script the session wrote

tooling admits external tools the session did not write (git, PowerShell,
MySQL, Laravel, Node); a script or tool a session wrote for a project goes to
that project, however general its shape. The line is in the prompt and beside
tooling in the context. A tool subject with no definition — built in, or in
engine.config.json's new "definitions" — is shown to no reading, name or
facts, and mem doctor names it.

### `f2a7d16` · 13:35 · move: a slot all of whose history is the moving session's own withdrawn wording takes its claim back

4fb58e98's first reading filed the audit-script gotcha under acme; its re-read
filed it under tooling and withdrew the acme slot. Moving it back was refused
as a slot the vault knows, though nothing of another session was there to be
superseded uncompared. The note files the old wording as replaced, as a re-read
under the same key does; a slot another session held or withdrew is refused as
before.

### `85fcd7e` · 13:53 · CLAUDE.md: tooling defined and the definition a condition, the audit-script slot moved back, the duplicate withdrawn, and ten of the 21 — stopped at 476578b4

### `5a0b79d` · 13:54 · CLAUDE.md: key drift between close sessions, counted — three sightings, two of them the same day, each with the old key in the context

### `0c29aa2` · 14:27 · subjects: tooling goes by where a gotcha shows up, not by who made the tool

A gotcha that shows up with the tool in any project is tooling's; one that
shows up in this project alone, because of its files, its database or its
setup, is the project's, however external the tool. The line named Laravel
among tools the session did not write, and 476578b4 filed under tooling that
a full test run wipes acme\_local for want of a .env.testing. The maker is
gone from the line, the context and the prompt — replaced, not excepted.

### `83b07ca` · 14:31 · extract: a line right above the slots — they exist; a claim about one takes its key word for word

Shown was not enough: three sessions filed a fact they could see in the
context under a key of their own (git-diff beside git-diff-pathspec twice, and
the tender minimum as a decision and as arch). No guard in the code yet, by
the user's call — the line's effect is measured on the remaining re-reads.

### `ea5ae2d` · 14:40 · CLAUDE.md: tooling by where, the moves, the line above the slots and its first measure, and six of the 11 — stopped at dd11f8d7

### `24c0af3` · 14:50 · CLAUDE.md: a gotcha filed on the wrong side of project and tooling, counted both ways in one counter — three so far, no guard on the tool label

### `c060230` · 15:06 · extract: every key the reading is offered is shown; the claim, for the forty nearest the session — and a tool's facts cross projects

The cap fell on slots: the first 40 by subject and key, so a acme reading saw
40 of 223, all acme.arch.\*, and never a decision.\* or a tooling key. The old
key behind all five drifts counted was live and not shown. Now every key is
listed; the claim goes to the forty whose words the session shares, weighted
by rarity, through indexable() on both sides as mem search does. A cap, if one
is ever needed, falls on claims, not keys — the user's rule.

A defined tool's facts are shown to a reading of any project, as tooling is
cross-project by definition: only facts another reading by the same agent
made, under a same-provider wall, so no CLI sees what it had not (constant 12).

### `f29bede` · 15:21 · schedule: node runs inside a headless console host — Hidden hid the task from the list, not its window

node is a console program; the scheduler gives it a console, and Windows 11
shows it as a Windows Terminal window, every fifteen minutes. A window monitor
saw it the second the task first ran. The earlier check had covered what the
scan starts, not what starts the scan. Through conhost.exe --headless a task
running node wrote its proof file and no window appeared; the same task
running node directly opened WindowsTerminal and node.

### `c15d1dc` · 15:31 · CLAUDE.md: the blind context found and fixed, the four last re-reads, the hook and the task installed — and the task's window caught — the full scan, and what it showed

### `ff91dd3` · 16:32 · move: every move is written into the note's ledger and applied to each re-read before the note is written — a move outlives the re-read that undid it; and mem restore, the mirror of retract

### `4f18302` · 16:38 · scan: a transcript written to in the last two minutes is a session still open and is left for the hook's --file — the full scan read the session that was running it

## 2026-09-25

### `5f8dc89` · 10:37 · CLAUDE.md: constant 19 — a move is a ledger the re-read follows, and mem restore — the two-minute rule, the collision counted with the drift, epsilon read behind its wall, and log-rotation left to the user

### `0ce1b89` · 10:52 · extract: the two examples that settle the edge the tooling rule leaves open — a common setting is the tool's, a thing of the project is the project's (the user's call on laravel-daily-log, 2026-09-25)

### `7fff1b2` · 10:57 · restore --confirm: the human's word puts the claim back at 1.0 — carried into the rewritten note on re-read, and paired in the index by confidence too, so the withdrawn row stays withdrawn

### `a4db629` · 10:59 · scan --file on a transcript that was never written: one line in hook.log and exit zero, not a stack trace — a session closed without a word names one anyway

### `be53d92` · 11:02 · CLAUDE.md: laravel-daily-log kept in tooling with the two examples, restore --confirm and what holds it, the hook on a missing transcript — and the counts

### `4adc4b3` · 12:05 · audit: five mechanical checks over what the vault already holds, and a report that fixes nothing — the wait measured from the session, not from the last retry

Every class of defect this project found, it found by looking: a slot taken by
a different claim, a key that drifted six minutes after its twin, a subject the
guard began rejecting and stopped showing anyone. 361 live slots is past what
an eye catches, so each class is a check here — orphan rows against the notes,
near keys under one subject, the guard's rejects, a claim no note has restated
for 60 days in a project still moving, a session pending for more than a week.

It reports and stops: none of the five is safe to act on automatically, and the
two thresholds it does have were measured on a copy of the real vault rather
than guessed. Running it there found two defects in the checks themselves — a
pending session's wait read from processed\_at is always minutes old, because
every scan retries it and writes that column; and three shared claim words is
what any two short claims about one table share.

### `ccc0d2b` · 12:06 · CLAUDE.md: mem audit — the five checks, the numbers the first run gave on a copy, and what the run itself corrected

Also the edge it leaves standing: the near-key section names pairs, it does not
judge them, because no shape separates a drift from two neighbouring facts —
which is the same reason constant 14 has no guard.

## 2026-09-26

### `1fb8ce5` · 15:54 · CLAUDE.md: the Codex app writes the CLI's rollouts — and three ways its files differ from what the scan assumes

The app's threads land in sessions/YYYY/MM/DD/rollout-\*.jsonl in the CLI's
shape, so no SQLite reader is needed for Codex. What the check found instead:
the file's mtime stays at its creation while its first writer appends; opening
an old thread appends one thread\_settings\_applied line and moves the
fingerprint while the distilled text stays byte-identical; and archiving moves
a file to archived\_sessions, where discover does not look. Also the first live
run of the codex branch — by the scheduler, the minute the CLI appeared — and
the task disabled after it read a turn still running.

### `daadd4d` · 15:54 · scan: the distilled text decides, not the file — its digest in the note's trailer, so a rebuild keeps it

Size and mtime stay the cheap first gate. A file that passes it is parsed and
distilled as before, and when the digest of that text equals the one in the
session's model note, the new fingerprint is recorded and nothing is sent.
The case: the Codex app appends thread\_settings\_applied whenever a thread is
opened — the 25 September session grew 2,678 bytes with its text unchanged.

The digest lives in the trailer, not the index (constant 3), and every rewrite
of a note by hand carries it. So the scan after `reindex`, which knows no
fingerprint, no longer sends every transcript back to the model. --force still
reads; a local note is still read by the model once a wall allows it.

### `da52250` · 15:57 · scan: Codex says from its records when it last wrote — a running turn stays open for six hours of silence, a finished one two minutes

Codex leaves a rollout's mtime at its creation for as long as the first writer
appends. On 2026-09-26 an app thread grew by 600KB in ten minutes with its
mtime at 10:48:59, and the two-minute rule let the scheduled scan read it
halfway through a turn; three writes from node through one handle moved the
mtime each time, so it is Codex, not NTFS.

Adapter.activity is optional; the Codex adapter reads the end of the file in
64KB chunks, back to the last turn marker. The last stamp is the clock, and
task\_started after the last task\_complete/turn\_aborted means a turn is
running — open until six hours pass without a record, the user's cap for an
agent that died. Asked only of a file whose fingerprint moved; --file is exempt
as it is from the mtime rule, and --force does not override it.

### `c38cc19` · 16:00 · codex: discover walks archived\_sessions too — and a session's row follows its file when it moves

Archiving a thread in the Codex app moves its rollout, whole, from the dated
tree to archived\_sessions beside it. Six sessions of April and May went there
on 2026-09-25 and their rows stayed pending on paths that no longer existed,
never to be tried again.

The same move exposed the row: upsertSession never updated source\_file, and the
cheap gate keys on file and fingerprint together, so a moved file would have
been parsed on every scan after. The row now records the file it was last read
from. A session read before it was archived costs nothing when it moves: the
text is the same (the previous commit).

### `c3b170e` · 16:02 · codex: --ephemeral — an extraction call no longer leaves a rollout on disk and a thread in the app

`codex exec --help` on 0.157.1 has it: "Run without persisting session files
to disk". Without it the six calls of 2026-09-26 each left a rollout in
~/.codex/sessions — read back as self, harmless to the vault — and a thread in
the Codex app's own list. Verified before relying on it: one call the same day
with the flag, and no rollout appeared, and the app's thread count stayed 22.

The command line is built in cliCall now, exported so a test pins the flags
that keep a call off the disk — claude's --no-session-persistence with it.
The self check stays, for the rollouts already there.

### `6484b9e` · 16:05 · codex: its tokens counted — exec --json, and the summary tallies each provider apart

The six codex calls of 2026-09-26 were counted as calls with zero tokens: the
bare text reply carries no usage. `exec --json` (0.157.1, one call seen live)
prints events, the last of them turn.completed with the turn's usage; the reply
is the agent\_message item. Its input\_tokens counts the cached ones too, so they
are kept apart, as claude reports them — input means uncached input whoever
answered. Reasoning is inside output\_tokens. A turn.failed or error event is
thrown with its message; bare text from an older CLI is still read.

The summary said one line for all of it, claude's dollars beside nobody's.
Each reply now names the CLI that answered, the scan tallies by it, and the
summary prints a line per provider — "no price from the provider" where there
is none, never a guessed one. For the record, from their rollouts, the six
calls took 157,452 input tokens (79,104 cached) and 2,258 output.

### `3ff6649` · 16:08 · CLAUDE.md: the four Codex decisions as they landed — the digest in the trailer, the clock in the records, the archive walked, --ephemeral and --json — and what still waits

The note of delta's session read mid-turn waits on the user, and the
scheduled task stays disabled until it is decided. Also what the next scan
will send (the six archived sessions, all to codex under their walls), the
notes from before the digest that still cost one call on their first change,
and the counts: 215 tests in thirteen files.

### `c3c5ea7` · 16:20 · doctor: the sessions the scan would leave alone right now, per agent, and why

A rule that skips leaves no trace when it works and none when it fails: the
scheduled scan of 2026-09-26 read a live Codex turn and nothing said the
two-minute rule had not seen it. `mem doctor` now asks every transcript, changed
or not, by the scan's own two rules — written in the last two minutes, or its
records saying a turn is running or ended under two minutes ago — and names
each with its agent and the write that keeps it open.

### `a54fafc` · 16:38 · adapters: the file's name is the session — a resumed transcript no longer takes the row of the one it copied

A resumed Claude Code conversation opens a new file and copies the earlier
session's records into it first, under the earlier id: ff78b3bb opens with 383
records of 67dab054, whose own file still sits beside it. The adapter took the
id of the first record, the two files shared one row, and since 2026-09-24
nearly every scan re-read one of them through the model — 66 rewrites of one
note, with its slots superseded and put back each time.

Claude Code names each transcript by its session id, so the name now decides,
and records of another session are skipped: they are that session's, read from
its own file. Checked on this machine before making it the rule for all three:
the name agrees with the id in 140 of 141 Claude Code sessions (the one
exception is ff78b3bb), 22 of 22 Codex rollouts and 8 of 8 Gemini logs, so no
existing id moves but that one. Codex takes the uuid in the rollout's name;
Gemini keeps the header's full id only when it starts with the name's eight
digits. A name that is no id falls back as before.

### `971a40c` · 16:40 · CLAUDE.md: the file's name is the session, what the next scan does to the two notes that shared a row, and what is and is not proven about open Codex sessions

The adapter sees a live Codex turn as open — shown at 12:55Z on delta's
session while it ran — but no scheduled scan has yet met one since the fix, so
item 1 is not counted proven. Also the full scan's numbers before and after, the
Codex usage limit that turned back the delta re-read, and the doctor line.

## 2026-09-27

### `539ba29` · 08:40 · doctor: sessions read more than three times in a week, with the count — from the vault's own history

Two files sharing one session id were re-read by turns for three days — 66
rewrites of one note — and nothing said so: each reading looked fine, only the
count was wrong. The vault's git history is the one record of every reading
(the index keeps the last), so doctor counts, per session note, the scan
commits of the last seven days that rewrote it; commits of move, retract and
restore are a hand, not a reading, and are left out. More than three is shown
with its count (the user's line). It catches the class — a fingerprint that
never settles, a transcript read while still being written, a gate keyed on
the wrong thing — not the one case.

First run on the real vault: 67dab054 61 times this week, and two more to look
at, 3169ae61 8 and b3c92ce1 4.

### `63e23d6` · 09:09 · CLAUDE.md: the duplicate-id fix proven on the scheduled task, a live Claude Code session read mid-tool, and what a provider's limit looks like today

After the task came back, 67dab054 was read once from its own file (05:36Z),
ff78b3bb once as a new session (05:51Z), and the 06:06Z scan read neither. The
same 06:06Z scan read this working session while it waited on a four-minute
command — its last record an assistant tool\_use with no result, a signal the
transcript already carries — and filed one wrong claim at 0.95. Proposed, not
built: an activity clock for Claude Code as for Codex. Also the Codex limit's
behaviour (the reset time cut off, stats silent), the six threads left as
they are, the delta re-read and the six archived sessions read, doctor's
count of re-reads, and 221 tests.

## 2026-09-28

### `0e8cd6c` · 12:46 · claude-code: a clock from the records — a turn waiting on a tool is not a closed session

The scheduled scan of 2026-09-27 06:06:23Z read b46e21ae mid-turn. Its last
record was a Bash call sent at 06:02:45 whose result came at 06:07:04; nothing
was written for three and a half minutes, the two-minute rule took the quiet
for an ending, and the reading filed a claim at 0.95 that the session went on
to disprove.

The adapter now has an activity clock, as Codex's does. The last
conversational record decides: a prompt, a tool result not yet answered, or an
assistant message asking for a tool (stop\_reason tool\_use, set on every block
of the message) is a running turn, open for six hours from the last record; an
assistant message asking for none ends it, and so do the user's interruption
and a local command's output, after which no model turn comes. A subagent's
inline records are the parent's wait, not its turn.

Run on the 159 transcripts on this machine: 133 finished, 14 unstamped, 11
closed mid-turn (the newest three days old, past the cap), and the session
writing this one running; slowest read 5.5ms.

The test replays the case at the moment it happened: the transcript's last 13
records as they stood at 06:06:23Z, byte for byte — cut there, the whole file
distils to the sha256 the 06:06 scan wrote in its note (11f4e4d9…) — with the
file's mtime at that last write and the scan's clock at 06:06:23.647Z (a `now`
seam in ScanOptions). Without the clock the model is asked, as it was; with it
the session is skipped as open, and read six hours on. Breaking each branch in
dist fails its case: no clock, stop\_reason ignored, no interruption, no local
command, subagent counted.

### `67c9fbd` · 12:53 · pending: the provider's words whole, counted by provider and by what it said — and a failed re-read is no longer called a fallback

Codex's limit on 2026-09-26 left seven sessions waiting, and three things hid
it. What the scan kept of the notice stopped at 160 characters, before "try
again at 8:43 PM" — the one part worth reading — in the row, in
\_inbox/pending.md and in eleven lines of hook.log. `mem stats` and the summary
said "ينتظر استخلاصه 6" and nothing else. And a session with an earlier note
was printed as "تراجَع إلى الاستخلاص المحلي… بقيت ملاحظته السابقة" though
nothing stood in for it.

- The message is kept whole: the four cuts at 160 and the two at 200 are
  gone. It goes into the vault, so it passes the redactor on the way, and
  onto one line, since it is printed as one.
- waitingLines counts waiting sessions by provider and by the provider's own
  message, in the scan summary and under pendingExtraction in `mem stats`
  ("codex 2 — error: You’ve hit your usage limit… try again at 8:43 PM."). The
  provider is the session's agent's CLI; the message is never read for
  meaning, so a vendor rewording it changes the line and nothing else.
- A session read before whose provider does not answer: "لم يُجب مزوّدها في N
  جلسة لها ملاحظة — لم تُقرأ ثانية، وبقيت ملاحظتها السابقة". A real fallback
  keeps its old line.

The cooldown from the same proposal — reading "try again at" to skip the CLI
until then — is not built: it acts on a vendor's text (the user's call,
2026-09-28).

Breaking each in dist fails its case: the cut, the line breaks, the redactor,
the provider's prefix, grouping by provider alone, the old wording, stats
without the groups.

### `0a0feaf` · 12:57 · CLAUDE.md: constant 20 — silence is not an ending; each agent's clock is read from its own file, and time is the last thing relied on

The time rule alone erred twice: on Codex, whose rollout keeps the mtime of
its first write, then on Claude Code, whose transcript is silent while a tool
runs. The constant names both clocks, says plainly that Gemini has none yet
and so breaks it, and that a new adapter is written with its clock.

And the state after the day's four decisions: the Claude Code clock
(0e8cd6c) and what is and is not proven of it on the scheduled task; the
wrong claim of b46e21ae, retracted on its own — by the scheduled scan at
06:21Z, not by the hook, which never fired for a session left open in the
app; the pending changes (67c9fbd) without the cooldown; and transcripts
whose mtimes move in batches to exactly seven days back, which cost 49
model re-reads on notes without a digest — 86 such notes remain.

## 2026-09-30

### `df6a417` · 13:34 · CLAUDE.md: the seven-day batches measured — the new mtime is the move's moment less seven days, by NTFS ChangeTime; unequal batches, no common folder, a ten-day age; cause not guessed

### `39a1547` · 13:47 · infer-digests: an inferred digest for the notes read before the trailer carried one — "the text is what it was at the last reading, as far as we know; not that it was read now"

Batches of old Claude Code transcripts have their mtime set back to seven
days before the moment, from outside the engine, and every note written
before daadd4d had no record of the text it was read from: each move cost a
model call to read an unchanged session again, about $5.28 in four days.

`mem infer-digests [--dry-run] [--break-lock]` writes, without a call, the
sha256 of what today's adapter distils from the transcript into a separate
trailer field, distilledInferred {sha256, at, readAt, size} — never into
`distilled`, so no one takes it for a real one (the user's word, 2026-09-30).
"As far as we know" is three conditions, each absence a named skip: the
note's last reading commit is the reading its index row remembers, no revert
touched the note after it, and the file is as long as it was then. Only the
trailer line changes; sameText accepts it; a hand's rewrite carries it; the
first real reading replaces it. Under the scan's lock, one vault commit.

Run on a copy, then on the vault (backup ~/.memory-backup-2026-09-30-before-
infer): 69 candidates, 67 inferred, 2 whose transcripts are gone; each of the
67 changed lines is the old trailer plus the field alone; copy and vault
agree on every sha, reading and size (vault fd6534a). On a copy with the 67
fingerprints broken, a local scan: "تغيّر الملف لا نصه 67"; after reindex,
377/377 live slots and 17/17 queue, and a local scan read no model note
again ("تغيّر الملف لا نصه 150").

Breaking each in dist fails its case: the scan's acceptance, keeping it
apart from distilled, the length, the reading-to-row match, the revert, the
session id, local notes, inferring twice, --dry-run, the hand's rewrite.

The diagnosis the user asked for first is df6a417.

### `dc2223f` · 13:58 · gemini: a clock from the log — a model message with no words is a turn still running; and activity is required of every adapter

Constant 20 was broken for Gemini, and CLAUDE.md said so: its mtime was its
only clock. Its log is a mutation log, and the CLI appends a model message
before its tools have run and again, same id, once they have — first bare
in 1dfc00bd (2026-09-14), first with `tokens` in 44a6467d (09-15) — so while
a tool runs the last record is that message, with no tool calls and no
words; `tokens` alone is no clock.

The last message the log holds — appended, or the last of a `$set` snapshot
— decides: a user message not yet answered, a model message with tool
calls, or a model message with no words is a running turn; a model message
with words and no tools ends it, and so does an error nothing followed;
`info` decides nothing. The clock is the last stamp, a snapshot's
lastUpdated included.

Thin evidence, and the comment says so: two real sessions, one with tools,
and six of the extractor's own calls. Replaying every prefix of the real
logs (300 cuts) gave no reading in mid-turn, but their longest silence is
51 seconds, so the logs never tested what the clock is for. Words and a
tool call together, a cancelled turn and a status other than success have
not been seen.

`activity` is now required in Adapter, so no agent can be added without a
clock — the constant is a condition of the type, not a habit. The Claude
Code counterfactual test now stands in a clock that says nothing, which is
what the scan had then.

Breaking each in dist fails its case: the wordless message, tool calls with
words, the error, the snapshot, lastUpdated.

### `d0afb55` · 13:58 · CLAUDE.md: the Claude Code clock proven live — the scheduled scan of 2026-09-28 10:57:50Z met 5873d896 eight minutes into a ten-minute PowerShell call and left it open; read after each turn, never in one

### `d9bf083` · 15:01 · notes: the digest of its text is required of every note a scan writes — a path that forgets it fails instead of writing a note that costs a call ten days later

The 67 notes of before daadd4d had no digest, and each cost a model call the
first time something outside the engine moved its transcript's mtime to
seven days back. Today's notes carry one — the scan passes it for every
reading, model or local, fallback or --force — but nothing held a future
path to it: `distilled` was optional in renderSessionNote.

It is now required in the type and checked when the note is rendered (64
hex digits); a note without it is refused, not written. The hands' three
paths — retract, restore, move — rewrite an existing note's trailer with
whatever digest it holds and create none. The test walks every path that
writes a note and then checks every note in the vault; the tests that build
notes by hand now give theirs a digest.

Breaking each in dist fails its case: the render check, the scan forgetting
the digest, move dropping the trailer's.

### `1bb4637` · 15:44 · scan: the summary adds up to what was discovered — it says when it stopped at --limit and how many wait, and counts the readings that left a note in place

At --limit (100 by default) the scan stopped looking and said nothing, and
its counts fell short of what it had discovered. It now goes on through the
cheap gate for the rest and counts what it leaves (leftAtLimit); the
summary, --dry-run and the vault's commit say "توقّف عند الحدّ N، بقي M".
Two outcomes had no counter at all — a session read before whose own CLI
did not answer, and a local reading that met a model note — and are now
"بقيت ملاحظتها السابقة" (keptPrevious). They alone explain the 20 of 205
summaries since 09-24 that did not add up; the limit was not reached by a
scheduled scan in that time.

Measured, not changed: short and self sessions take 35 of the 100 seats in
every scan (22 and 13 today), because they have no row and never pass the
cheap gate. CLAUDE.md records the proposal and its price.

Breaking each in dist fails its case: stopping at the limit, the commit's
line, either uncounted path.

### `7554e89` · 15:50 · CLAUDE.md: a transcript that vanishes passes in silence — the scan, doctor and audit say nothing, the brief still offers its resume command; the current behaviour as shown to the user, unchanged

### `8968e10` · 15:50 · CLAUDE.md: the live proof of the Codex and Gemini clocks is owed, and waits — what counts as proof, how it is looked for, and that it is not staged

## 2026-10-01

### `45fe1b8` · 23:41 · scan: short transcripts and the extractor's own are recorded in the index — empty with the threshold a short one fell under, skipped for the extractor's own — so they stop taking a --limit seat on every scan; a changed minUserChars judges a short one again

### `126536e` · 23:47 · doctor: names every session whose transcript has gone from the disk — a note, a wait, a quarantine — which no scan meets again and none said a word about

### `7a0128d` · 23:57 · brief: no resume command for a session whose transcript has gone — buildBrief leaves it out, and the scan rewrites a written brief and the agent files it went into that still offer one; the note and its facts are not touched

## 2026-10-02

### `8e8e0fc` · 00:03 · stats, audit: a waiting session whose transcript has gone is named «نصّها مفقود», not counted as waiting — at any age, since no scan will find it to try again; the inbox stops promising it a retry

### `a79ee11` · 00:13 · CLAUDE.md: constant 21 — everything the brief shows must work when it is shown; a command that does not work is worse than none. What guards it today, and what writing it found that does not hold yet

### `a51aed4` · 00:13 · CLAUDE.md: short and self transcripts recorded with their threshold, proven live on the scheduled scan of 20:36Z; a transcript that vanishes now has its three marks — doctor, the brief (proven live, vault f59f989), and «نصّها مفقود» in audit and stats

### `b7b3f53` · 12:09 · tests build into test-build/, not dist — dist is the deploy the scheduled task and the hook run on the real vault, and every guard broken to prove a test fails used to be live there until put back; a test fails if any test file reads dist or npm test builds it

### `62ff74d` · 12:22 · brief: the freshness stamp names node and the CLI by full path, with its vault — a deploy assumes no PATH, and mem was never on it; the scan rewrites a written brief whose stamp does not run, as it does one that offers a dead resume command

### `e209edc` · 12:25 · brief: no resume command whose folder has gone — the cd it opens with would fail; the resume text stays, and the scan rewrites a written brief that still offers one (three projects)

### `69b90ba` · 12:27 · CLAUDE.md: constant 21's three findings decided — the stamp by full path and the dead folder are guarded, whether the CLI is installed is not asked; 261 cases (254 said before was a miscount of 256)

## 2026-10-06

### `67d801c` · 00:02 · package: files names what is published — dist, the two READMEs and LICENSE; CLAUDE.md, src, test and their fixture stay out

CLAUDE.md is the contract, written for this machine: project names, people, session ids. npm pack without a files field took everything git does. README.en.md is in because README.md links to it.

Item 1a/1b of 2026-10-05.

### `4cb6b60` · 00:05 · test: the b46e21ae fixture is synthetic — the shape of the 06:06 transcript's last 13 records, none of its text

Same record kinds in the same order, same keys and value types, same timestamps and stop reasons, ending on the Bash call sent at 06:02:45.695Z with no result. Every text, id and path is made up; a script checked that no string value of the real records survives but the structural ones. The three b46e21ae tests pass as before: with the clock off the model is asked, with it on the session is open.

The real records are still in this repository's history.

Item 1c of 2026-10-05.

### `eabce18` · 00:31 · names: no project, class, file or path of a live project in the tests, the comments or the prompt's examples

The user's rule of 2026-10-05, for everything that is published or would be: a fact about one of their projects is told without its name, and an illustration uses a made-up one that keeps the shape the guard reads — a ticket stays a ticket, a class a class, a folder a folder.

Tests: one mapping from each real project, folder, class, file, ticket, table, key and person to a made-up name of the same shape — the names the tests carry now, and the ones this file uses (acme, dojo, beta, BillingService, OrderDraft, lib/handlers.rb, X9-42, CheckTeam, accounts.tax\_code, batch-split-rule, tender, omar). The dojo that replaced one subject has to sort before engine, as the real one did.

Comments: an incident is told without its project ("a reading in the largest project", "a repository's server folder", "three projects").

The prompt, which the model reads once dist is rebuilt: its three examples — a person's role key, a class and a ticket that are not subjects, and tooling's project-side example — took made-up names. Same examples, other names.

261 tests pass.

### `8eeb3fa` · 00:31 · README: the publishing README, Arabic first with README.en.md beside it — Codex's reply told, not quoted, and the quoted brief without its class names

Written in the session of 2026-10-04 and never committed until now, so its first commit already has neither: Codex's reply described a gap in a running system and named the path of its repository. Now: the session stopped at a proposal waiting on the user's decision, and Codex read the brief and put the two points back to them. The resume section Codex read keeps its words, with the controller names in brackets and a line saying the quote was edited. The drift list says the same limit under decision.… and arch.… instead of the project's own key.

Item 2 of 2026-10-05, and the rule the user added to it.

### `f3bcf78` · 00:32 · README: no link to CLAUDE.md — it is not published, so the link would lead nowhere and the limits section would cite a file no reader has

Item 1b of 2026-10-05, on the README's side.

### `92b8a33` · 13:52 · name: the package is sila-memory and the command sila — package.json, the lock, bin, every message and usage line, the help, the MCP server, the vault's git identity, the launchd label, and the READMEs' install line

Four names stay memory-engine, each with its reason beside it, because each is how the engine finds something it already wrote on disk:
- the injection markers \<!-- memory-engine:begin/end --\>: renamed, every block already in a project's CLAUDE.local.md, AGENTS.md or GEMINI.md is orphaned, and a second one written beside it (the user's own example);
- HOOK\_MARK, the statusMessage our SessionEnd entry is found by: renamed, install adds a second hook and uninstall leaves the first;
- TASK\_NAME, the scheduled task's name: the same, for schtasks;
- NEUTRAL\_DIR, the extractor's temp folder: a session whose cwd is there is the extractor's own and never read — renamed, the calls made before would no longer be recognised, and after a reindex they would be read and sent as a person's.

Where mem is history — the stamp that said `mem scan` and the check that still recognises one — it stays mem.

Item 4 of 2026-10-05. 261 tests pass.

### `2265b32` · 14:03 · hook: install refuses to run from npx's cache, and says why — the entry names this file by absolute path, and npm empties that cache

npxInstall: a cli path with a \_npx segment is npm's cache (\<cache\>/\_npx/\<hash\>/node\_modules/…), emptied when npm cleans it and replaced when it fetches the package again; a hook pointing there fails at every session end with no one told. The refusal names the path, says that, and prints the global install; exit 1, settings.json untouched. Uninstall and status still run from anywhere.

Two tests: the rule on Windows and POSIX cache paths against global, repository and look-alike paths; and the CLI itself, run through a junction shaped like npx's cache — refused with exit 1 and nothing written, while the same files by their real path install. Both fail with the guard disabled in test-build. The README says install globally, and why.

Item 5 of 2026-10-05. 263 tests pass.

### `e7ff11a` · 14:14 · schedule: install refuses to run from npx's cache too — the task carries the same absolute path the hook does

Not in the list of 2026-10-05; found doing item 5 and kept apart so it can be judged alone. A task registered from npx's cache, or a launchd/cron entry printed from it, runs a file npm will delete, and fails every cycle without a word. On Windows install is refused, status and uninstall still run; elsewhere nothing is printed, since what is printed is what gets installed. --file is refused too: the definition it writes holds the same path.

The CLI test adds schedule install --file through the npx-shaped junction: exit 1, no task definition written; it fails with the refusal removed in test-build. 263 tests pass.

### `157b924` · 14:17 · deps: @google/genai and @google/generative-ai removed — nothing in the engine imports them

The contract says three dependencies, and there were five. Their one user was test-gemini.mjs at the root, a hello-world call to the Gemini API with GEMINI\_API\_KEY, outside src and test and in no npm script; it goes with them. The lock loses 397 lines.

Item 6, first half, of 2026-10-05. 263 tests pass.

### `fe5dde8` · 15:24 · doctor and --dry-run say where sessions go, as the scan sends them — on a fresh config they named the API, a local fallback and "no git", while every session went to its agent's CLI

A fresh config is provider anthropic, model claude-sonnet-5, no walls, no key, and every wall, unlisted folder and unknown cwd is same-provider. On this machine's fresh config (2026-10-04, again 2026-10-06):
- doctor said "API key — سيُستخدم الاستخلاص المحلي" and "extractor anthropic / claude-sonnet-5", and nothing about whether claude, codex or gemini was installed — the three things the scan would use;
- the dry run said "النموذج: claude-sonnet-5" and "سيُرسل للنموذج 86", 13 of which were the extractor's own sessions, never read;
- doctor said "— بلا git" for the reread count two lines under "git ✓": git log fails in a repository with no commit, and that read as no git.

Now destinationFor (config.ts) states the scan's own two rules, and both say what it gives: doctor names each agent's CLI with ✓ or "its sessions wait until installed", and the model it is called with; the provider is named only for walls that opted out of same-provider, the one place it is used. The dry run says "سيُرسل حتى N" by destination — "إلى claude 56 — claude-sonnet-5 · effort medium · مثبّت ✓" — says why "up to", counts the extractor's own sessions apart and keeps them out of the projects and folders. A repository with no commit has rewritten nothing. The walls warnings say the CLI of the agent, not "the model". The README's numbers are this run's: 208 files, up to 73 sent, 14 local, 13 the extractor's own.

Tests: destinationFor on a fresh config, under walls and with each provider; and the CLI's doctor and dry run on a fresh config with one session and one of the extractor's own. Each fails with its fix removed in test-build: same-provider ignored, the extractor's sessions counted, an unborn repository read as no git.

Item 6, second half, of 2026-10-05. 265 tests pass.

### `8bd9a9b` · 15:28 · scan summary and MCP banner: who answered, not what the config names — on a fresh config they said anthropic and claude-sonnet-5 too

Found doing item 6, the same misreading in two more places, kept apart:
- the scan's summary printed "نداءات النموذج N (anthropic)" after calls the agents' CLIs had taken; it now prints the count and, as before, a line per provider that answered;
- the MCP server's startup line named the extractor's model, though the server calls none; it now says it reads only, and no longer loads the config it used for nothing else.

No test reads either line; the banner was checked by starting the server on a fresh vault. 265 tests pass.

### `e728b54` · 15:30 · license: MIT, Mohammed Abu Shamleh — LICENSE at the root, license and author in package.json, and the READMEs link to it

npm pack now carries LICENSE (1.1 kB), which the files field already named. The English README gives the name in Latin letters; the Arabic one keeps the Arabic and adds them.

Item 7 of 2026-10-05. 265 tests pass.

### `54a44ce` · 15:32 · README: cost as measured — the example session and three runs, each figure from the summary line its scan printed, said to come from one vault and not to be a benchmark

Checked against the record before writing: the example session in .index/hook.log (2026-09-25 08:29:46Z, 1 call, $0.0967, 21.5 s); the one-project re-read in the session that started it (10 calls, $0.7035, 93.0 s, vault commit 4d4180f); the full scan with context in hook.log (63 processed, 55 calls, $4.7415, 857.3 s); the first full scan's three runs in its own log and hook.log (104, 62 and 7 calls; $7.8186, $4.4218 and $0.5261 — 173 and $12.7665; 42,120.9 s with the machine asleep, 1,020.1 s, 184.5 s). The rounded figures and the missing time are now the printed ones, and the table says processed is not calls, that no average or estimate is offered, and why.

Item 8 of 2026-10-05. Text only.

### `183b063` · 15:38 · README: installing from npm, as tried today from the packed tarball — npx refuses hook and schedule install, a global install works

2026-10-06, sila-memory-0.1.0.tgz built from HEAD (91 files): through real npx (npm-cache\\\_npx\\9cc510e4…) hook install and schedule install --file refused, exit 1, nothing written; installed globally into a temporary prefix, init, hook install, doctor and scan --dry-run ran, and the hook named the install's own path. Text only.

### `84107a9` · 15:39 · CLAUDE.md: the publishing preparation of 2026-10-05 — the name and the four names kept, the files field, the synthetic fixture, the names rule, npx refused, two dependencies gone, doctor and the dry run truthful, the license, the README; the n8n key not in the vault; dist not rebuilt

And what this made untrue: the fixture is no longer the real records, the tests are 265 (policy 9, hook 21, gate 53).

### `0955034` · 15:50 · names: two more key families of a live project out of the tests and a comment — to bundle-\* and ticket(s)-exposure

A second sweep, this time of every slot key the code, tests and READMEs name against the vault's keys under project subjects, found what the first one let pass as plain words: two families of keys — seven of one, a singular and plural pair of the other — are the largest project's own keys, as the tender-\* family was. The made-up bundle-\* keeps the original's six letters, so the three keys still share the root the old rule merged them by; ticket(s)-exposure keeps the plural the test is for. Keys that are plain words in any project (convention.mobile, misc.backup, constraint.lint) and this project's own (arch.lock, arch.reconcile) stay.

265 tests pass.

### `f15d51d` · 15:51 · package: no source maps — files excludes dist/\*\*/\*.map, and build:publish builds with tsconfig.publish.json, sourceMap false

The 29 maps were 330 kB pointing at src, which is not published, and a map carries the path it was built at: built outside the repository on 2026-10-06, every one ran through the user's home directory. Two guards, either enough: the publish build makes none, and a dist built with them — the live one — still packs without them (62 files from it today).

A test asks npm itself: npm pack --dry-run may list only package.json, the two READMEs, LICENSE and dist files that are not maps. It fails with the exclusion removed.

Item 2 of 2026-10-06. 266 tests pass.

### `6805f75` · 15:55 · README: npm audit as it is — three advisories in this repository's lockfile, none on a fresh install, and the one of the three that does load

Item 3 of 2026-10-06, written against what was checked rather than what was assumed. The assumption, mine on 2026-10-05, was that all three sit in the SDK's HTTP server; the check found two of them do:
- proxy-addr 2.0.7 (critical, via express) and ip-address 10.7.0 (moderate, two advisories, via express-rate-limit) never load: a resolve hook recorded every module the MCP server loaded through initialize, tools/list and a call of each of its five tools, and express was not among them;
- fast-uri 3.1.7 (moderate) does: ajv loads it, the SDK's schema validator.
All three are this lockfile's (2026-09-14). The package carries none, and a global install from it on 2026-10-06 got fast-uri 3.1.8, proxy-addr 2.0.8 and ip-address 10.7.3; npm audit on a fresh lock of the same package.json: 0. Text only.

### `539ba6a` · 15:59 · README: the install from npm was tried again on the package as it will be published — 62 files, no source maps; npx refused both installs, the global install ran

2026-10-06, sila-memory-0.1.0.tgz built with build:publish from HEAD (206.0 kB, was 255.5 kB with the maps): npx refused hook install and schedule install with exit 1 and wrote nothing; installed globally into a temporary prefix, hook install, init, doctor and scan --dry-run ran, and no .map was installed. Text only.

### `d279a8f` · 16:00 · publish: the public repository is git archive HEAD — CLAUDE.md and private/ are export-ignore, so the copy leaves them out without a hand to remember it

The user's call of 2026-10-06: the public repository starts with no history, and this one stays local, unpublished. Copying the tree by hand and deleting CLAUDE.md from it is a step a later copy can forget; .gitattributes now says it, and git archive obeys.

private/decisions.mjs writes docs/DECISIONS.md from this repository's commit messages, cleaned by the names rule. It holds the real names it replaces — which is why it is private, and why it is kept: the next DECISIONS.md needs the same mapping.

### `f51061e` · 16:01 · CLAUDE.md: the publish repository — git archive HEAD into a folder of its own, one commit, this repository kept local; DECISIONS.md and its private generator; source maps out; npm audit corrected to what was checked; 266 tests

And the correction stated as one: on 2026-10-05 I said the three audit advisories were all in the SDK's HTTP server. Two are and never load; fast-uri loads, through ajv. All three are this lockfile's only.

### `8d65c3e` · 16:02 · docs: DECISIONS.md — the messages of all 144 commits of this repository, oldest first, cleaned by the names rule; documentation, not history

The user's call of 2026-10-06: the public repository starts with no history, and the messages are not lost with it — why each change was made, what broke before it, what the user decided. Written by private/decisions.mjs: every real project, folder, class, file, ticket, key and person becomes the made-up name the tests carry (acme, beta, gamma, delta, epsilon, dojo, BillingService, X9-42…), two messages that were the replacement list itself are told without it, and Markdown is escaped outside code spans so \<vault\> and \<!-- … --\> survive rendering. Swept afterwards for every project name, class, path and real slot key: nothing. Session ids and vault commit ids stay — they point at nothing outside the author's machine.

### `b84fa94` · 16:03 · gitattributes: the export-ignore comment reads true on both sides — it travels into the public repository, where "this one" meant the wrong repository

### `7f0d4b2` · 16:03 · docs: DECISIONS.md through the .gitattributes comment — 145 commits

### `f3eb50d` · 16:18 · README: one date for the numbers, and a date beside every other one — stats, the agents, the files on disk, the vault's commits and the tests rerun on 2026-10-06

The section mixed stats of 2026-10-04 with figures of 09-25 and 09-17, and read as a contradiction: pendingExtraction 0 beside "nine Codex sessions waited". Now the numbers section is all of 2026-10-06 13:16Z (stats 172 sessions, 389 facts, 19 pending; by agent 158/12/2 with notes; 178/22/8 files; 249 vault commits; npm test 266 in 13 files) and says so in its first line, the cost table keeping each run's own date. Elsewhere: the nine sessions say they were read and the count is 0 on 10-06; MCP unregistered, the Codex and Gemini clocks unmet, no acceptance and no non-plural s pair — each as of 2026-10-06, checked that day; the six drifts up to 2026-09-24; the 34 near-key pairs on a copy of 2026-09-25; the six Gemini files on 2026-10-06.

Item 1 of the README corrections of 2026-10-06. Text only.

### `45ad4f1` · 16:18 · README: the limits section says what is unpublished — the internal log it is drawn from, not the section itself

"هذا القسم من سجلّ العمل الداخلي للمشروع، وهو لا يُنشر" read as the section saying it is not published, in the published README. Now: drawn from the project's internal working log; the log itself isn't published.

Item 2 of the README corrections of 2026-10-06. Text only.

### `3d196b8` · 16:18 · README: a line under the tagline to docs/DECISIONS.md — why every decision in this project was made, and what broke before it

Item 3 of the README corrections of 2026-10-06. Text only.

### `9cfcb56` · 16:18 · docs: DECISIONS.md through the README corrections of 2026-10-06

### `9016997` · 16:32 · package: repository, homepage and bugs point at github.com/MohammedAbuShamleh/sila — the public repository it is published to

### `31e5ab6` · 16:32 · docs: DECISIONS.md through the repository field in package.json

### `cd94022` · 16:42 · site: the landing page moves in under site/ — its tree from its own repository's one commit, f769c4d, without that repository's .git

The user's decision of 2026-10-06: the site is published with the engine, from the public repository, instead of living in a folder of its own. The tree came out of that folder with git archive, so only what it tracked moved: its .git, node\_modules, dist and the brief the engine had injected (CLAUDE.md, AGENTS.md, GEMINI.md) stayed where they were. The 38 files are blob for blob the ones f769c4d holds; the 39th, its .gitignore, became a section of this one.

.gitignore: the site's rules under /site/, the engine's untouched. The Thmanyah Sans files — licensed for the author's own devices, never to be hosted — were copied to site/public/fonts/thmanyah/ so the dev server looks as before, and that folder is ignored here as it was there. The brief files are ignored too, though nothing writes them now: the engine resolves site/ to this repository's root, where injection is off.

docs/DECISIONS.md: the site's message gets a section of its own after the engine's. It was frozen into private/site-commits.json before the old folder is deleted, and decisions.mjs reads it from there, so regenerating keeps it.

Left out of the engine on purpose: package.json's files does not list site, so npm pack --dry-run is still 62 files with site/dist and site/node\_modules present; npm test names its thirteen files and tsc includes src/ only, so neither enters site/. .gitattributes does not mark site/ export-ignore: it reaches the public repository.

Checked from inside site/: npm install, npm run build (prerendered dist/index.html), npm run dev (the page, both Thmanyah weights loaded, no console error). No relative path broke: every script runs with site/ as its working directory. The site's deploy workflow is still at site/.github, where GitHub never reads it; the next commit moves it.

266 tests pass. dist was not built.

### `275f905` · 16:53 · ci: npm test on every push, and the site built from site/ to GitHub Pages under the repository's own path — plus CONTRIBUTING.md, the numbers the site and the READMEs share

test.yml: npm ci, then npm test, on every push. windows-latest, Node 22: every documented run of the suite has been there, and a Linux or macOS runner would test the platform before the code. Run locally the way a fresh runner sees it — no git identity where the test vaults live, no claude, codex or gemini on PATH: 266 pass.

pages.yml is the site's deploy.yml, moved from site/.github (where GitHub never reads a workflow) with the site's paths: run steps in site/, its own lockfile for the cache, site/dist uploaded. It runs on a push to main that touches site/ or itself, and by hand.

The base: a project repository is served under /\<repo\>/, a user repository or a custom domain at /. configure-pages now runs before the build and reports which as base\_path, the build gets it as PAGES\_BASE\_PATH, and vite.config.ts makes it the asset base. Without the variable the base stays './', as it was, for dev, a local build and preview. The trade: the published build differs from a local one in its asset URLs, and those are what was checked: PAGES\_BASE\_PATH=/sila put every asset under /sila/assets/, and vite preview with that base served the page from /sila/ with no failed request and no console error. configure-pages itself has not run; neither workflow has.

site/README.md: deploy.yml became pages.yml; the base section says the above; the commands run from inside site/.

CONTRIBUTING.md: the four figures the site shows from the README — sessions, live facts, superseded facts, tests — each with its place in content.ts, in both READMEs, and the command it comes from; the README's date moves with them; and the install command, not a figure, by the same rule. On 2026-10-06 the site is behind the README on all four and on the install command; this commit does not change them.

npm pack --dry-run: 62 files. 266 tests pass. dist was not built.

## 2026-10-07

### `5d4de38` · 11:05 · site: the install command is the README's, npm install -g sila-memory, and the four figures are the README's of 2026-10-06 — 172, 389, 360, 266

The user's decision of 2026-10-07, after the move showed the site behind the README on both.

The command: the hero said npx sila init. The package is sila-memory, and sila on npm is a different package (0.0.1), so the command would have fetched that. And the engine is installed globally, not through npx: the hook records the program's path, and npx runs it from a cache npm empties. The capsule now copies the README's first line, and a comment beside it says why.

The figures, as CONTRIBUTING.md lists them: sessions 130 → 172, live facts 359 → 389, superseded 210 → 360, tests 186 → 266. They come from the README's stats block and test line, both of 2026-10-06; the comment above stats says so.

The capsule never wraps, and the command is twice npx's length: at 360px it was 412px wide and pushed the copy button off the screen. Below sm the note «بلا مفتاح API» and its rule now give way, as the $ prompt already did, and the guarantees section still says it in full. Measured on the dev server at 360, 390, 639, 640, 768, 1024, 1280, 1440 and 2560: no horizontal overflow, the capsule inside the page padding at every width, the note back from 640. A real click passes npm install -g sila-memory to the clipboard API; the browser pane refuses clipboard writes, so the paste itself was not seen. The numbers band counts up to ١٧٢ ٣٨٩ ٣٦٠ ٢٦٦, and the prerendered dist/index.html carries the new command and no npx.

266 tests pass. dist was not built.

### `d04f9a5` · 11:14 · site/README: Thmanyah Sans is the headings and figures font, its fallback Reem Kufi — as the code has it, not body text with IBM Plex

Item 1 of the user's three of 2026-10-07. The section said the page's text was in Thmanyah and IBM Plex Sans Arabic took its place without the files. The code says otherwise: font-display in tailwind.config.js puts Thmanyah on the headings, the figures and the wordmark, with Reem Kufi from Google Fonts next; body text is IBM Plex Sans Arabic and commands IBM Plex Mono, always; vite.config.ts declares two weights, 400 and 700, and preloads Bold, the weight the hero title opens with. The section now says that, and that a local build copies all five font files to dist/fonts, not the two declared.

The Lighthouse figures were measured under the earlier setup — Thmanyah for body text at 400/500/700 with Regular preloaded — and the bullet says so; the current setup has not been measured. Its numbers are unchanged.

Text only. 266 tests pass. dist was not built.

### `0586d4c` · 11:16 · README: under "not proven live", the site — neither workflow has run on GitHub, and Pages needs enabling by hand once

Item 3 of the user's three of 2026-10-07: the site is not published yet, and the README says so where it says what hasn't been proven. One line in each language: test.yml and pages.yml have not run on GitHub as of 2026-10-07, and Pages needs Settings → Pages → Source: GitHub Actions, once.

Text only. 266 tests pass; npm pack --dry-run is 62 files. dist was not built.

### `98c3829` · 11:21 · site: npm audit fix without --force — source-map-js 1.2.1 → 1.2.2, the lockfile alone; seven advisories remain, all behind Tailwind 3

Item 1 of the user's three of 2026-10-07: one high advisory (GHSA-68fv-2mgg-jv7q, event-loop denial of service through indexed source-map section offsets) falls with a lockfile change only, so there is no reason to keep it. source-map-js comes in through postcss, a build tool.

The change is three lines of site/package-lock.json; package.json is untouched. npm audit after: 7 vulnerabilities (2 moderate, 5 high), from 8 (2 moderate, 6 high). What remains is braces, which has no patched release, and postcss-selector-parser, fixed only in 7.x, which Tailwind 3 does not take; both clear only with Tailwind 4, a major upgrade the user declined. npm audit --omit=dev: 0.

The site builds, and its two assets are byte for byte the ones built before the fix.

266 tests pass. dist was not built.

### `329550f` · 11:22 · site/README: the copy button's two fallbacks were reached once — by a scripted click in a preview browser that refuses the clipboard, not by real use

Item 2 of the user's three of 2026-10-07. The README said neither execCommand nor selecting the command for manual copy had ever been called. On 2026-10-07 both were: button.click() from a script, with no user activation, in a preview browser that refuses clipboard writes. The clipboard API refused, execCommand did not succeed, and npm install -g sila-memory was left selected. The line now says that and how, and that a real click reaching them has not been tried, so it stays under "not tested live".

Text only. 266 tests pass. dist was not built.

### `22c514a` · 11:25 · README: the site's npm audit under the engine's — seven advisories, all in build tools; --omit=dev zero; react, react-dom and scheduler alone reach the browser, shown from the built bundle

Item 3 of the user's three of 2026-10-07, placed right under the engine's own npm audit line in the limits section, in both languages. After 98c3829 the site has seven advisories (2 moderate, 5 high), all through tailwindcss, a devDependency, and they clear only with Tailwind 4, which the user declined. npm audit --omit=dev: 0.

What reaches the browser was not read off the dependency tree. A build with source maps listed every module in the published JavaScript: react, react-dom, scheduler and the site's own files, nothing else. The CSS is Tailwind's output, not its code. That build came after the install command changed and before the lockfile fix, and the fix left both assets byte for byte the same.

Text only. 266 tests pass; npm pack --dry-run is 62 files. dist was not built.

### `825f937` · 11:30 · docs: DECISIONS.md through the site's npm audit line in the README — the move of the site, its workflows and the items of 2026-10-07

### `d048f81` · 11:46 · test/redaction: every credential-shaped sample is a prefix and a body joined at run time — GitHub's secret scanner refused the push over them whole

Item 1 of the user's four of 2026-10-07. All the samples were made up (abcdefghij…, 123456789012, and AKIA…EXAMPLE from Amazon's own documentation), but push protection reads shape, not provenance, and refused the public repository's first commit. Fixing it means they must not look like secrets, not asking GitHub to allow one.

Every such literal — inputs and the markers checked against the output — is now two or more literals joined with +: the private key block, anthropic, openai, aws, github, google, slack, stripe, sendgrid, npm, jwt, the db and basic-auth URLs, bearer, the assigned secrets, the iban and the card, and the same in the scrubNote and false-quarantine cases. The ssh key and the long google key were already built at run time and stay as they were; the nine-digit ids are not credential-shaped.

What reaches redact() is unchanged, character for character, and that was checked rather than read: both versions ran with redact() and scrubNote() wrapped and String.prototype.includes recorded, and the two logs — 25 redact() inputs, the scrubNote() input and 25 markers, in order — are byte for byte the same. A scanner for the provider formats push protection knows finds 22 matches in the old file and none in the new one.

Disabling each of the 19 rules in test-build fails the same cases with the new file as with the old. 26 redaction cases and 266 tests pass. dist was not built.

### `77f3806` · 11:48 · test: the two GitHub-token-shaped strings outside the redaction test are split the same way — gate (a provider's message) and order (a garbled reply)

Item 2 of the user's four of 2026-10-07: scan the rest of what is published for anything shaped like a secret before the push is retried. The scanner covers the provider formats GitHub's push protection knows (anthropic, openai, aws, github, google, slack, stripe, sendgrid, npm, huggingface, gitlab, twilio, mailgun, telegram, discord, shopify, azure), private key blocks, JWTs, URLs carrying a password and bearer tokens, plus a softer net for a secret-named variable given a value. It ran over every file git archive publishes: 93 text files across src, test, docs, the READMEs, site and the workflows.

Strong matches: two, both ghp\_ followed by 36 characters, exactly GitHub's own token format, so the next push would have been refused over them as well. One is the token a refusing provider's message carries in gate.test.mjs, the other the token inside the garbled reply in order.test.mjs; both tests check that it is redacted on its way into the vault. Each is now ghp\_ and its body joined at run time, and so are the markers checked against them. With the joins removed, both files are byte for byte what HEAD holds.

Soft matches: 25, none a secret — field names (inputTokens, the lock's token, tokenize), an environment lookup (apiKey = process.env\[...\]), the redaction markers in comments, and a lock token "sleeper" in a test. After this commit the scanner finds nothing strong in the published tree.

266 tests pass. dist was not built.

### `35f5479` · 11:49 · docs: DECISIONS.md through the secret-shaped test samples; the generator shortens the AWS documentation key one message quotes, which push protection would refuse in this file too

### `3e0c225` · 12:33 · test/redaction: caught() names the rule that must do the masking — disabling any of the 19 rules now fails its own case, 19 of 19, where it was 16

Item 1 of the user's three of 2026-10-07. Disabling each rule in test-build, one at a time, showed three that no case could catch, all three since before the samples were split: with anthropic-key off, the openai rule (sk-… of 32 or more) still masked sk-ant-…, and nothing failed; with npm-token off, assigned-secret masked \_authToken=npm\_…, and nothing failed; with aws-access-key off, assigned-secret masked aws\_access\_key\_id = …, and only the scrubNote case failed. caught() checked that the marker was gone and that something had been reported, so another rule doing the job counted as success.

caught() now takes the rule's kind and requires it among the findings, in place of "something was reported". Each of the 18 cases names its rule. National-id has no caught() case; its two checks — the bare nine-digit number and the id before a full stop — already fail with it off. No rule is left without a case, so none was added.

The 19 disabled one at a time: the edited file fails each rule's own case, 19 of 19; HEAD's copy, 16 of 19, the three above. test-build was restored after the run. What reaches redact() is unchanged: the recorded inputs and markers are byte for byte those of the file before the split.

26 redaction cases and 266 tests pass. dist was not built.

### `af45f3f` · 12:39 · README: npm audit on this repository's lockfile is four advisories, not three — the fourth, high, is the SDK's own OAuth client before 1.31.0, which the engine never imports

Item 2 of the user's three of 2026-10-07, in both languages. npm ci from this lockfile in a fresh checkout reported four vulnerable packages; the README said three. The fourth is @modelcontextprotocol/sdk itself: the lockfile pins 1.30.0, and GHSA-6qxp-vccf-f47h (high) says its OAuth client could send credentials to an authorization server chosen by the MCP server, in every version before 1.31.0.

The engine is a server, not a client: src imports the SDK in one file, server/mcp.js and server/stdio.js, and a walk of the relative imports those two reach in the installed SDK finds sixteen modules, none under client/. The bullet says so.

A fresh lockfile for the same package.json, resolved in a scratch folder today, takes the SDK at 1.32.1, fast-uri 3.1.8, proxy-addr 2.0.8 and ip-address 10.7.3, and npm audit on it finds nothing; the bullet now says that, dated 2026-10-07, where it said the same of 2026-10-06 without the SDK. The lockfile here is unchanged.

Text only. 266 tests pass; npm pack --dry-run is 62 files. dist was not built.

### `1dbb403` · 12:41 · docs: DECISIONS.md through the README's fourth advisory — caught() naming its rule, and the SDK's OAuth client

### `49183c0` · 14:35 · README, package.json: the site is live at mohammedabushamleh.github.io/sila — linked under the tagline in both languages, and homepage points there instead of the repository's readme

### `2145169` · 14:36 · README: the site line under "not proven live" is corrected — published 2026-10-07; test.yml passed the 266 on windows-latest and pages.yml built and published the site in 36 seconds, both that day; the manual Pages step is done and stays in site/README

### `72e646a` · 14:37 · site/README: the deploy workflow ran on GitHub on 2026-10-07 — built and published in 36 seconds, and the live page asks for /sila/assets/, so configure-pages gave base\_path /sila as the local build assumed

### `1dd5b4c` · 14:37 · docs: DECISIONS.md through the site going live — its link in both READMEs and package.json, the corrected line, and the deploy workflow in site/README

### `0959e8a` · 14:45 · site: the GitHub links in the header and the footer point at github.com/MohammedAbuShamleh/sila — one constant for both; the docs and screenshots links stay # until they have a page

### `f549a94` · 14:45 · docs: DECISIONS.md through the site's GitHub links

### `3cb8327` · 14:50 · site: the footer's docs link points at the README on GitHub (the repository page, #readme); only the screenshots link stays #

### `4c36c33` · 14:50 · docs: DECISIONS.md through the site's docs link

### `36e5dc2` · 14:51 · site: the footer drops the screenshots link — it had no page; the footer is GitHub and the docs, and no link on the page is # any more

### `c985a17` · 14:51 · docs: DECISIONS.md through the footer without the screenshots link

### `1eaae78` · 14:55 · README: "anything but Windows" after CI — every documented run of the engine is still one Windows 11 machine on Node 22.12.0, and the 266 tests have also passed on windows-latest (Windows Server, Node 22) since 2026-10-07: a second Windows, not another system; macOS and Linux have run neither the engine nor its tests

### `ce517ba` · 14:57 · test.yml: the comment no longer says every run of the suite was on Windows 11 — outside this workflow it was, on one machine; macOS and Linux still never ran it

## الموقع التعريفي · The site

بُني الموقع في `site/` في مستودع خاص به، ثم نُقل إلى هنا بشجرته وحدها في 2026-10-06. هذه رسائل ذلك المستودع قبل النقل، بالقاعدة نفسها في الأسماء.

The site in `site/` was built in a repository of its own and moved here, its tree only, on 2026-10-06. These are that repository's messages before the move, cleaned by the same rule.

1 commit.

### `f769c4d` · 2026-10-06 16:24 · Add Sila landing page: RTL single page, prerendered for GitHub Pages

Vite + React + TypeScript + Tailwind v3, Arabic RTL throughout.

- Seven sections: hero, how it works, guarantees, numbers, limits,
  works-with strip, footer. All copy lives in src/content.ts.
- Motion only adds: every element rests in its final, readable state;
  entrances play only after the single shared IntersectionObserver
  sees an element scroll in; everything sits behind
  prefers-reduced-motion. Word-by-word headings, sticky shrinking
  header, ghost indices in guarantees, sticky limits column.
- Build prerenders the page into dist/index.html and hydrates it;
  the Pages workflow builds and deploys on push to main.
- Contrast measured on 13 viewport sizes; hero paragraph held on
  forest-700 or darker.
- Thmanyah Sans (headings and figures) is local-only and git-ignored:
  its license forbids hosting the files. Without them the build falls
  back to Reem Kufi.
