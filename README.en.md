# Sila

**Shared memory for your coding agents.**

Website: [mohammedabushamleh.github.io/sila](https://mohammedabushamleh.github.io/sila/)

[`docs/DECISIONS.md`](docs/DECISIONS.md): why every decision in this project was made, and what broke before it.

[العربية](README.md)

Sila (صِلة, Arabic for "connection") reads your Claude Code, Codex and Gemini sessions from disk. It pulls out what was decided, what was turned down and where you stopped, and keeps all of it as Markdown files you own. When one agent hits its limit, open another and tell it to carry on.

---

## Getting started

You need Node 20 or later, and at least one of the three agents installed and logged in.

```bash
npm install -g sila-memory
sila init
sila scan
sila hook install
```

- **No API key, no new account.** Extraction runs through the agent's own CLI (`claude -p`, `codex exec`, `gemini -p`) under that CLI's own login. The engine strips `ANTHROPIC_API_KEY` from the child process's environment before starting it.
- **No cost beyond your subscription**, as long as the CLI is logged in with one. Each session the model reads is one call against your subscription's usage. If the CLI itself is logged in with an API key, the call bills that key.
- **The first `sila scan` sends data.** It handles up to 100 sessions per run, and each session's redacted text goes to the CLI of the agent that produced it. `sila scan --dry-run` shows what would be sent and what would stay local, without making a single call. On this machine, with a fresh config, on 2026-10-06 it reported 208 files, of which the first run would take 100. Up to 73 would be sent: 56 to `claude`, 15 to `codex` and 2 to `gemini`. 14 would be summarized locally because their folder is unknown, and 13 are the extractor's own calls, which are never read. "Up to" because it counts files, and any with fewer than 200 characters from you isn't sent.
- **Git repositories:** the brief is never written into a file git would pick up. Add `CLAUDE.local.md`, `AGENTS.md` and `GEMINI.md` to `.gitignore` before the first scan, or injection stops for that project (see [Connecting your agents](#connecting-your-agents)).
- **Codex and Gemini have no hook.** `sila hook install` covers Claude Code only. On Windows, `sila schedule install` scans every 15 minutes; elsewhere, use `sila watch`.

**Install globally, not with `npx`.** `hook install` writes the program's absolute path into `~/.claude/settings.json`, and `npx` runs the package from npm's cache (`npm-cache/_npx/…`). That cache is emptied when npm cleans it and replaced when npm fetches the package again, and then the hook fails at every session end without telling anyone. So `sila hook install` refuses to run from there, says why, and prints the two commands for a global install. Both routes were tried on 2026-10-04 from the same package, before the refusal existed: through `npx` the hook pointed into `npm-cache\_npx\…`, through a global install at the install itself.

---

## The example that explains everything

This happened on 2026-09-25, in a Laravel + React repository on this machine. All times are UTC and come from the logs.

**08:29:46** — A Claude Code session closed. It had analysed an edit guard on the server, asked the user two questions, and got no answer. Closing it fired the hook, which scanned that one session: one model call, 21.5 seconds. The scan rewrote the brief and injected it into 3 files, `AGENTS.md` among them. Here is the resume section as Codex read it from disk a few seconds later:

> _محدَّث 2026-09-25 08:30 UTC — إن مضى أكثر من يوم على هذا الختم فشغّل `mem scan` قبل الاعتماد عليه._
>
> ## استئناف — آخر جلسة (2026-09-25 · claude-code)
>
> - **وقفنا عند:** الوكيل عرض تحليل حارس [دالة تحديث] مقابل [دالة تحديث أخرى] وطرح سؤالين على المستخدم دون تلقي إجابة، ثم بدأت جلسة فرعية غير مرتبطة (video-ad-editor)
> - **الخطوة التالية:** العودة لسؤال المستخدم عن الحقل البديل ونطاق الدفعة الأولى قبل كتابة أي إصلاح لحارس [المتحكّم]

Translation:

> _Updated 2026-09-25 08:30 UTC. If this stamp is more than a day old, run `mem scan` before relying on it._
>
> ## Resume: last session (2026-09-25 · claude-code)
>
> - **Stopped at:** the agent laid out its analysis of the guard on [an update method] against [another update method] and asked the user two questions without getting an answer; then an unrelated side session began (video-ad-editor)
> - **Next step:** go back to the user's question about the replacement field and the scope of the first batch before writing any fix for the guard on [the controller]

(The quote is edited: its class names were taken out and are shown in brackets; the rest is as Codex read it. Below it in the file: the files the session touched, and a `claude --resume <id>` command. `mem` in the stamp is the command's old name.)

**08:30:07** — In Codex, in the same folder, the user typed:

> اقرأ AGENTS.md وكمّل
>
> _(Read AGENTS.md and carry on.)_

**08:30:14** — Codex read the file. At **08:31:12** it opened the Claude Code transcript named by the resume command and read the analysis there. At **08:31:26** it replied.

The session had stopped at a proposal waiting on the user's decision, so Codex read the brief and put the two points back to them. It named the stopping point as the brief did, asked the same two questions in the same order, recommended an answer to one of them, and said it wouldn't touch a file until both were settled.

**08:33:40** — The user answered both questions, and Codex started on the guard.

One thing in this doesn't show in the reply. Codex puts `AGENTS.md` into its context when it starts, and when it started at 08:30:07 the scan hadn't written yet. So the copy in its context was the previous day's brief (stamped 2026-09-24 12:28), whose resume section pointed to a 15 September session about different work. Codex got the new one because it read the file from disk when asked to. A brief is only as current as the last scan.

---

## Guarantees

**1. Markdown is the source; the SQLite index is derived from it.** Every fact is written into the trailer of its session's note. `reindex` rebuilds the index from the notes alone, using the same function the scan uses.

```bash
sila stats                                      # note the numbers
mv ~/.memory/.index ~/.memory/.index.bak        # or delete it
sila reindex
sila stats                                      # same facts, pending and subjects
```

Known exception: a fact confirmed with `sila accept` is not written to Markdown, so `reindex` loses it and puts it back in the queue (see [Limits](#limits)).

**2. No claim is ever deleted.** Facts are append-only. A changed fact is marked superseded, and one its session no longer makes is marked retracted. Every scan that changes anything ends in a commit in the vault.

```bash
sila history <subject> <key>    # every claim made for that slot, and when it changed
git -C ~/.memory log --oneline
```

**3. A session's text goes only to the agent that produced it.** A Codex session is summarized by `codex` and nothing else. If `codex` is missing or fails, the session waits for the next scan; it never goes to `claude`, `gemini` or the API.

```bash
sila stats      # sessions whose CLI is missing show under pendingExtraction, named by provider, not as notes
```

On this machine, 9 Codex sessions waited from the first full scan on 2026-09-17, with `claude` installed right beside them, and weren't read until `codex` was installed on 2026-09-26. Then they were read: `pendingExtraction` on 2026-10-06 is 0.

**4. Nothing is written into a file git would carry.** Before injecting the brief into a repository folder, the engine asks git about the three files. If any of them is tracked, not ignored, or git can't be asked, nothing is written and injection is switched off for that project in the config.

```bash
git status                                # in the project folder after a scan: no new files
grep '"inject"' ~/.memory/engine.config.json
```

---

## Commands

| Command | What it does |
|---|---|
| `sila init` | Creates the vault (`~/.memory`, or `MEMORY_VAULT`) and finds your session sources. Leaves existing walls alone |
| `sila scan` | Reads new or changed sessions and updates the memory. `--dry-run`, `--limit N` (default 100), `--agent`, `--project`, `--file`, `--force` |
| `sila watch [--interval 900]` | `scan` on a timer |
| `sila hook install\|uninstall\|status` | Claude Code session-end hook in `~/.claude/settings.json` |
| `sila schedule install\|uninstall\|status` | Windows: a scheduled task every 15 minutes and at logon. Elsewhere: prints launchd/cron entries, writes nothing |
| `sila search "text"` | Arabic/English search across every session |
| `sila brief <project> [--sync <dir>]` | Prints the brief, or injects it into the agent files |
| `sila subject <name>` | Live facts for a subject |
| `sila history <subject> <key>` | History of one slot |
| `sila pending` / `accept <id>` / `reject <id>` | What's waiting on you: claims below the confidence floor (0.75), or weaker than a fact they contradict |
| `sila retract <subject> <key> --reason "…"` | Withdraw a fact that's no longer true |
| `sila restore <subject> <key> [--confirm]` | Undo a `retract` |
| `sila move --plan <file.json> [--dry-run]` | Move slots to the right subject; the move survives re-reads |
| `sila reindex` | Rebuild the index from the Markdown alone |
| `sila rebase` | Line the existing index up with the notes, in place |
| `sila audit` | Model-free check; report in `_inbox/audit.md` |
| `sila stats` / `sila doctor` | Vault numbers / what it found on your machine and what needs attention |

---

## Connecting your agents

### The three files

After every scan, `BRIEF.md` is regenerated for each project the scan touched and injected into a marked block in that project folder's agent files:

| Agent | File |
|---|---|
| Claude Code | `CLAUDE.local.md` in a git repository, `CLAUDE.md` outside one |
| Codex | `AGENTS.md` |
| Gemini | `GEMINI.md` |

```
<!-- memory-engine:begin -->
...
<!-- memory-engine:end -->
```

Anything you wrote outside the block is left alone. The brief opens with a freshness stamp that names the scan command by the full path of node and the program. The first section, "Resume", comes from the latest session: where it stopped, the next step, the files it touched, and the command to resume it in its own agent. The command alone is dropped once the transcript it opens, or the folder it `cd`s into, is gone. The brief is capped at 6,000 characters.

**In a git repository**, git is asked about the three files before anything is written. A tracked file, a file not listed in `.gitignore`, or a repository git can't answer for means nothing gets written to that folder, and `"inject": {"<project>": false}` is written to `~/.memory/engine.config.json`. Only you can lift it: add the files to `.gitignore` and delete the entry so git is asked again, or set it to `true`, which says you accept the injection even into a file that will be published. `"briefSync": false` turns injection off everywhere.

### The MCP server

Five read-only tools: `memory_get_brief`, `memory_search`, `memory_get_subject`, `memory_list_subjects`, `memory_read_session`. An agent can consult the memory but not change it; only the scan and you write to it.

```json
{
  "mcpServers": {
    "sila": {
      "command": "node",
      "args": ["<npm root -g>/sila-memory/dist/serve/mcp.js"],
      "env": { "MEMORY_VAULT": "/home/you/.memory" }
    }
  }
}
```

The server speaks MCP over stdio. It has been exercised directly: handshake, `tools/list`, and real tool calls. **As of 2026-10-06 it hasn't been registered in any of the three agents on this machine.** The block above is the shape most clients take, not a config that was tried inside an agent. Codex configures MCP servers in TOML in `~/.codex/config.toml`; see its docs for the format. As for the two routes: the files are read at startup and need nothing from the agent, while MCP never writes into your folder and builds the brief at request time.

---

## Numbers from my vault

**These come from one vault, on one machine, used by one person since 2026-09-14. They are not a benchmark, and not an average for anyone else.**

Every figure in this section is from 2026-10-06, except the cost: each run there carries its own date.

`stats` on the vault, 2026-10-06 13:16Z:

```
sessions       172
quarantined    0
pendingExtraction 0
unreadTextGone 0
subjects       17
facts          389
superseded     360
retracted      1253
links          112
pending        19
last_scan      2026-10-06T13:06:52.807Z
```

- `sessions` are sessions with a note. `facts` are live facts. `subjects` are subjects with at least one live fact. `pending` are claims waiting for a decision.
- `superseded` and `retracted` count rows that are kept, not deleted. The large `retracted` figure is history, not a fault: every re-read of a session retracts what it no longer says, and this vault's sessions were re-read many times during development.
- Sessions by agent, from the index on 2026-10-06:

| Agent | With a note | Too short to read | The extractor's own calls |
|---|---|---|---|
| Claude Code | 158 | 22 | 1 |
| Codex | 12 | 4 | 6 |
| Gemini | 2 | 0 | 6 |

- On disk on 2026-10-06 (`doctor`): 178 Claude Code files, 22 Codex, 8 Gemini. The vault holds 249 commits.

**Tests:** `npm test` on 2026-10-06: **266 passed, 0 failed, across 13 files**.

| redaction | reconcile | policy | project | adapters | hook | extract | brief | schedule | order | move | audit | gate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 26 | 28 | 9 | 5 | 12 | 21 | 25 | 9 | 12 | 34 | 20 | 12 | 53 |

**Cost, as measured: one vault, not a benchmark.** The example session above, and three larger runs on the same vault. Every figure is from the summary line the scan printed when it finished: in `.index/hook.log`, in the first full scan's own log, or in the session that started it. The dollar figure is what `claude` itself prints at API prices. The login was a claude.ai subscription, so this money wasn't paid; it came out of the subscription's usage. Every call in these runs went to `claude`; `codex` reports tokens with no price, and wasn't installed at the time.

| Run | Processed | Calls | Reported $ | Time |
|---|---|---|---|---|
| The example session above, via the hook (2026-09-25) | 1 session | 1 | 0.0967 | 21.5 s |
| One project, every session re-read (2026-09-24) | 10 | 10 | 0.7035 | 93.0 s |
| Full scan with memory context (2026-09-24) | 63 | 55 | 4.7415 | 857.3 s |
| First full scan (2026-09-17), three runs, two of them overlapping | 105 + 62 + 8 | 104 + 62 + 7 = 173 | 7.8186 + 4.4218 + 0.5261 = 12.7665 | 42,120.9 s (the machine slept mid-run) + 1,020.1 + 184.5 |

"Processed" isn't "calls": a session whose note is written locally is processed without one. In the first full scan, 24 sessions were read twice because two runs overlapped (see [Defects from the first full scan](#defects-from-the-first-full-scan-2026-09-17-since-fixed)). There's no average here and no estimate for any other vault: cost follows the length of the sessions and how much memory is shown with each reading, and both are particular to my work.

---

## Limits

This section is drawn from the project's internal working log; the log itself isn't published. Nothing here is fixed by rewording: what was fixed says how and where, and what isn't proven says so.

### What it doesn't do

- **No semantic retrieval.** Search is full-text (SQLite FTS5) with Arabic normalization. It strips the article «ال» only, not `بال`, `وال` or `لل`, so `ريأكت` won't find `بالريأكت`.
- **No UI, no dashboard.** A CLI, Markdown files and an MCP server.
- **One machine, one person.** No sync. The vault is a plain git repository.
- **No Cursor.** Adapters exist for Claude Code, Codex and Gemini only. Cursor keeps its data in SQLite, not JSONL, and its adapter hasn't been written.
- **No daily spend cap.** `dailyCallLimit` (200) is per run, not per day, and there's no spend table. The scan summary counts tokens per provider; dollars come from `claude` alone.
- **Local extraction produces no facts.** A session behind a `localOnly` wall gets a note made of what the user typed, with no facts. Its silence proves nothing, so it never retracts or supersedes.
- **MCP tools are read-only.** By design.
- **No hook for Codex or Gemini.** Automatic scheduling exists on Windows only; on macOS and Linux the command prints launchd/cron entries and installs nothing.
- **Gemini:** `logs.json` isn't read, and a version without a `chats/` folder yields zero files.

### Not proven live

- **The Codex and Gemini clocks.** Silence doesn't mean a session has ended, so each adapter reads the tail of its file and reports whether a turn is still running. A running turn counts as open for six hours after its last record; anything else, for two minutes. The Claude Code clock was proven live on 2026-09-28: a scheduled scan met a session 8.3 minutes into a PowerShell command that took ten, left it alone, and read it after the turn ended. **The Codex and Gemini clocks are built and tested, but as of 2026-10-06 no scheduled scan has met a live turn for either.** No turn will be staged to prove them. The Gemini evidence is thin anyway: two real sessions on this machine, the last on 2026-09-15.
- **Anything but Windows.** Every documented run of the engine was on a single Windows 11 machine, on Node 22.12.0. The 266 tests have also passed in CI on `windows-latest` (Windows Server, Node 22), first on 2026-10-07. That is a second Windows, not another system. macOS and Linux have never run the engine or its tests, and `engines` says Node 20 or later without a run on 20.
- **Installing from npm.** Not published yet. Tried on 2026-10-06 from the local package (`npm pack`, 62 files, no source maps). Through `npx`, `hook install` and `schedule install` refused, exited with 1 and wrote nothing. As a global install into a temporary prefix, `init`, `hook install`, `doctor` and `scan --dry-run` worked, and the hook pointed at the install. A real `scan` after that install hasn't been run. It has been run thousands of times from the repository.
- **MCP inside an agent.** Exercised over stdio directly, never registered in an agent.
- **Agent versions.** What's been run: `claude` 2.1.251, `codex` 0.157.1, `gemini` 0.59.0. Gemini's format is the least stable of the three and needs re-checking on every update.
- **`codex resume <id>`** exists in `codex --help`; resuming a specific session ID with it hasn't been tried.
- **`sila restore --confirm`** hasn't been run on the real vault, only in tests.
- **The site in `site/` was published on 2026-10-07**, at [mohammedabushamleh.github.io/sila](https://mohammedabushamleh.github.io/sila/). Both workflows ran on GitHub that day: the 266 tests passed on `windows-latest` in CI (`test.yml`), and the site was built and published in 36 seconds (`pages.yml`).

### Not measured

- **Whether what gets extracted is any good.** The question "is this worth reading a month from now?" hasn't been judged yet.
- **Cost at scale.** Without a spend table, there's no telling whether 900 sessions cost one dollar or forty.
- **The cause of the seven-day batches** (below). Unknown, and not guessed at.
- **The effect of prompt instructions.** One line above the slot list asks the model to reuse a key verbatim, and two examples in the `tooling` definition settle where a tool ends and a project begins. Their effect can't be read off the numbers.
- **Context size.** For a session in the largest project here it went from 11,961 characters to 19,251 once every key was shown. Roughly 28k is expected at 500 slots and 44k at 1,000; neither has been measured.
- **Speed at thousands of notes.** Every scan re-reads all notes to re-derive subjects: 113 notes and 62 subjects in about a second and a half. At thousands it will need a subject → notes index.

### Known rough edges

- **A `--force` re-read where the CLI doesn't answer.** Under same-provider, if the CLI fails on a session that already has a note, the old note stays and the session isn't demoted to waiting. Intended, and the scan says so: "provider did not answer… not re-read, previous note kept".

- **After `reindex`, the next scan checks every file once.** File digests are reset, so every transcript is distilled again. No model call is made unless a session's note lacks the digest of its distilled text. Notes written before the trailer carried that digest used to cost a call on the first change to their file. On 2026-09-30, 67 of them got an "inferred digest" without a call, meaning: this is what the text was at the last reading as far as we know, not that it was read now.

- **Claude Code transcripts have their modification times moved in batches from outside the engine, cause unknown.** Measured on 2026-09-30 from NTFS ChangeTime:
  - 81 of 448 files had their mtime moved, all of them main Claude Code transcripts.
  - The new mtime is exactly seven days before the moment of the move (604,800,000 ms, plus 7 to 248 ms).
  - Every file whose age was known before the move was between 10.04 and 10.94 days old.
  - The batches are uneven, share no folder, and the same file comes back every three to four days.

  It cost about $5.28 over four days, until the notes carried their text digest. Since then a move costs nothing for a note that carries one.

- **One scan handles 100 sessions by default (`--limit`).** It still runs the cheap check over the rest and counts them without processing them, and the summary says "stopped at the limit N, M left".

- **Short sessions and the extractor's own sessions** have an index row with their file's digest, so they aren't re-parsed on every scan. A short one records the threshold it fell under, and any change to `minUserChars` re-judges it once. The price: `reindex` doesn't restore these rows, so they're parsed once afterwards.

- **A transcript that vanishes from disk.** The scan only sees what's on disk, so it says nothing about a transcript that's gone. There are three marks instead:
  - `doctor` lists every session with a note or a wait whose transcript is gone.
  - The brief drops its resume command. "Stopped at" and "Next step" stay, and the note is untouched.
  - A waiting one is labelled "text missing" in `audit` and `stats`.

  A file moved to somewhere the scan walks (an archived Codex thread) counts as gone until the next scan. A delete marker in the desktop app isn't evidence either: the hook once read a session three seconds after it was deleted, with the text still on disk, and two sessions carry a delete marker while their text remains.

- **A hook naming a transcript that was never written.** The `SessionEnd` payload can name a file that doesn't exist. That now produces one log line and exit code zero.

- **`sila accept` doesn't write to Markdown.** `reindex` loses the accepted fact and returns it to the queue. `rebase` keeps it as a 1.0 claim dated at acceptance, so scan and `reindex` disagree on any subject with an acceptance. My vault held none on 2026-10-06.

- **Containment counts as equivalence.** A later session that says the same thing in more detail is treated as "unchanged" and the detail is lost, in the scan and in `reindex` alike.

- **The plural rule in key matching.** A key ending in s that isn't a plural (`https`) matches the same key without the s (`http`) if both sit under one subject and one prefix. No such case in my vault on 2026-10-06: the one pair there that differs by an s is `gate`/`gates`, a real plural.

- **Two keys for one fact (drift), and the reverse: a slot taken by a different claim.** One counter for both, and no guard in code, by decision. A session states an existing fact under a new key for the same subject, and it becomes two live slots. Key matching doesn't catch it because the difference isn't spelling, and claim equivalence doesn't because the wordings differ. In every early case the old key was live but never shown to the session: the context was the first 40 facts in alphabetical order, so one session saw 40 slots out of 223. That was fixed (`c060230`), and every key is shown now. Up to 2026-09-24, drift was seen six times, and the reverse once:
  1. `tooling.gotcha.git-diff-pathspec`, then `tooling.gotcha.git-diff` the same day. The second was retracted by hand.
  2. The same limit in the project, under `decision.…` and then under `arch.…`, six minutes apart. A re-read with the new context retracted the duplicate.
  3. `tooling.gotcha.git-diff-pathspec`, then `tooling.gotcha.git` four days later; the second is the cause of the first. After the fix, the re-read narrowed the second into a neighbouring fact.
  4. `tooling.gotcha.powershell-setcontent`, then `tooling.gotcha.powershell` a minute later: `Set-Content` writes a BOM that breaks PHP files. Both live.
  5. `tooling.gotcha.claude-cli-shell` (25 August) and `tooling.gotcha.tinker` (15 September). Both live.
  6. `tooling.gotcha.tinker-dollar-sign`, the same fact a third time. This time the old key was shown, but it bundled three facts, so taking it would have replaced the bundle with one part of it.
  7. The reverse: a session put a different Laravel fact into `tooling.gotcha.artisan-route-list-json` and superseded another session's claim. Left as is, by decision.

- **Misplacement between the project and `tooling`, in both directions.** One counter, and no guard on the `tool` tag, by decision. The rule: a gotcha that shows up with the tool in any project belongs in `tooling`; one that shows up only in this project, because of its files, database or setup, belongs to the project. Seen five times up to 2026-09-24:
  - A script the session wrote for the project went to `tooling`.
  - "`php artisan test` wipes the project's local database because `.env.testing` is missing" went to `tooling`, under an older definition that named Laravel.
  - A Laravel test auth-guard gotcha went to the project.
  - Two facts about a video skill went to `tooling`.

  All five were moved by hand with `sila move`. One borderline case was settled: Laravel's `daily` log driver stays in `tooling`. The two examples added to the definition since then haven't had their effect measured.

- **A live tool with no definition is invisible to every extractor,** so no session can supersede or retract it. The fix is a line in `definitions`, or `sila move`. Anything the subject guard rejects (a new subject shaped like a file, a class, a ticket, or a folder at the project root) is hidden while live for the same reason.

- **Re-reading a moved session used to undo the move.** Fixed: `move` records the move in the note's trailer, and the scan applies it to every later read. What remains: the record holds subject and key only, so a claim the model files under a third key isn't caught. Four facts dropped by the re-read of a transcript that had grown were put back with `restore`; most likely the distill cap (24,000 characters) cut its beginning, but that wasn't verified. And `restore` isn't immunity: a re-read that drops the claim retracts it again. The only immunity is confidence 1.0.

- **A session read before it had finished.** It happened twice and was fixed twice:
  - A full scan read a working session mid-way and produced a wrong fact. The two-minute rule came out of that.
  - Then a scheduled scan at 06:06:23 read a Claude Code session whose last record was a Bash command sent at 06:02:45 with no result yet, and a wrong claim entered the vault at 0.95. A full read of the session at 06:21 retracted it automatically, and the log-based clock followed (`0e8cd6c`).

  Before either, a Codex file's mtime stayed at its first write for as long as its writer kept writing to it, so a scan read a Codex turn mid-way.

- **A session that's never closed is never read by the hook.** `SessionEnd` fires on close, and a session left open in the desktop app gets nothing. The scheduled scan reads it once it goes quiet.

- **An agent that hits its limit.** Now reported with the provider's full message, grouped by provider. There's no cooldown: every scan retries every waiting session, one CLI process per session per cycle, each refused at once. It costs nothing, but it's noise. No live limit has been hit since the fix.

- **Two garbled calls in a row aren't counted** in the scan's cost output. Both replies are kept, redacted, in `.index/garbled/`.

- **Six sessions the extractor left in Codex** before `--ephemeral` was passed are still in its app and on disk. The scan counts them as its own and doesn't read them.

- **`sila audit` names things; it doesn't judge them.** The near-duplicate-keys section is a list to read by eye. On a copy of my vault on 2026-09-25 it had 34 pairs, including the live drifts, but most are genuinely neighbouring slots. No shape tells the two apart, which is exactly why there's no guard.

- **Confidence.** Three anchors: 0.95 when the user said it outright, 0.85 when it showed up in code or output within the session, 0.6 for inference. The floor is 0.75, so inference always goes to the queue, on purpose. Even so, 0.9 turned up twice, although the prompt allows nothing but the anchors.

- **`npm audit` on this repository: four advisories (on 2026-10-07); on a fresh install: none.** The lockfile here dates from 2026-09-14 and pins `@modelcontextprotocol/sdk` 1.30.0 and old versions of its dependencies:
  - `@modelcontextprotocol/sdk` 1.30.0 itself (high): its OAuth client could send credentials to an authorization server chosen by the MCP server, in every version before 1.31.0. The engine is a server, not a client, and imports only `server/mcp.js` and `server/stdio.js` from the SDK; the sixteen modules their imports reach include nothing under `client/`.
  - `proxy-addr` 2.0.7 (critical) through `express`, and `ip-address` 10.7.0 (moderate, two advisories) through `express-rate-limit`. Both belong to the SDK's HTTP server. The engine speaks stdio and never loads them: every module the MCP server loaded through a full session (startup, handshake, all five tools) was recorded, and neither `express` nor either of these was among them.
  - `fast-uri` 3.1.7 (moderate). **This one does load**: `ajv` loads it, and the SDK uses `ajv` to validate tool schemas.

  The published package carries no lockfile, so an install takes the newest versions the ranges allow. A global install from the package on 2026-10-06 got `fast-uri` 3.1.8, `proxy-addr` 2.0.8 and `ip-address` 10.7.3. A fresh lockfile for the same `package.json` on 2026-10-07 takes `@modelcontextprotocol/sdk` 1.32.1 and the same three versions, and `npm audit` on it finds nothing. Who is affected is whoever clones the repository and installs from its lockfile.

- **`npm audit` in `site/`: seven advisories (2 moderate, 5 high, on 2026-10-07), all in build tools.** They all come through `tailwindcss` and clear only with Tailwind 4, which hasn't been taken. `npm audit --omit=dev` finds nothing. Of the dependencies, only `react`, `react-dom` and `scheduler` reach the browser, alongside the site's own files. That was shown from the contents of the built bundle — a build with source maps listing every module in the published JavaScript — not from the dependency tree.

- **Small things:**
  - The vocabulary says `person.<name>.role`, and one session created two people with a bare `role` key.
  - Links keep the names the notes gave them after a `move`.
  - `move` marks the old slot "retracted", with the reason "moved to …", and no special tag.
  - Some old notes show under "retracted" in their text what the index calls "superseded".
  - `.index/inject-warned.json` is no longer read, and was left in place.

### Defects from the first full scan (2026-09-17), since fixed

1. **A lock taken from a live scan.** The machine slept mid-scan. The first hook after waking found an 11-hour-old lock and took it, then released it while the first scan was still running, and the scheduled scan ran alongside it for 17 minutes. A live process's lock is no longer taken because of its age, and each scan releases only its own lock.
2. **Matching keys by their first six characters merged different facts.** 67 rewrites, 17 of which sent two different keys from one reply into one slot. Keys are now matched on spelling alone.
3. **The scan applied facts in processing order and `reindex` in session-date order,** and they disagreed on 34 of 300 slots. Session date is now the order for both.

---

## How it works

Each agent has an adapter that streams its session files, never loading a whole one into memory, drops tool output on purpose, and tells from the records themselves (not the file's mtime) whether a session has ended. Everything after the adapters speaks one shared vocabulary. A session's transcript is distilled under a character cap and redacted, then read by its own agent's CLI together with what the memory knew about that project before the session's date. The reply is JSON, checked against a schema. Each session gets a Markdown note with its facts in a machine-readable trailer, and every subject the session touched is re-derived from all notes in session-date order. A SQLite index (FTS5) is derived from those notes, and the vault is a git repository where every scan ends in a commit. Retrieval goes from the vault out to the agent files and the MCP server. **Adapters are written once per agent; retrieval is written once.**

---

## Privacy

**What leaves the machine, and for whom.** A session's text is sent only to the CLI of the agent that produced it. A Codex session goes to `codex` and nowhere else: no other provider, not the API, and no local note standing in. If the CLI is missing or fails, the session waits. **Extraction doesn't widen the circle of who has seen a session's text**: whoever reads it is whoever saw it in the first place.

**What crosses between agents on purpose.** The extracted facts and the brief. That's what makes the memory shared: the `AGENTS.md` that Codex reads contains facts from Claude Code sessions. When a session is extracted, the extractor is also shown what the memory knows about that project, whichever agent's session those facts came from. Only `tooling` facts cross projects, and only from the same agent.

**Walls.** You classify your folders in `~/.memory/engine.config.json`. `"localOnly": true` means no network call of any kind for sessions in that folder; the note is written locally from what you typed, with no facts. `"sameProvider": true` is the default for every wall. With no walls at all, every session goes to its own agent's CLI, and `sila doctor` warns you about it. Once you add one wall, any unclassified folder stays local. A session whose folder is unknown is always local. `sila scan --dry-run` lists each folder with its session count before you decide.

**Redaction.** 19 rules run before a single byte leaves:
- API keys (Anthropic, OpenAI, AWS, GitHub, Google, Slack, Stripe, SendGrid, npm), JWTs, database URLs and URLs with passwords, bearer tokens, variables named PASSWORD, SECRET or TOKEN, SSH keys and private keys.
- Nine-digit ID numbers, card numbers and IBANs, which are removed unconditionally.

After redaction, the output is checked again against 16 of the rules. If anything survives, the whole session is quarantined in `_inbox/quarantine.md` and nothing is sent. Everything entering the vault goes through a second redaction pass. There are 26 test cases, three of which guard real past defects:
- An ID number slipped through because a full stop after it broke the match.
- A fixed-length rule failed silently on a longer key.
- A verification pass matched its own replacement and quarantined healthy sessions forever.

**What's never sent.** Tool output, meaning the contents of files the agent read and the output of commands. The session text that is sent is cut at 24,000 characters. The extractor call itself runs in an empty temporary folder:
- `claude -p --safe-mode --tools "" --no-session-persistence`
- `codex exec --sandbox read-only --ephemeral`
- `gemini --approval-mode plan`

`claude` and `codex` are told not to save the call as a session on disk, which was verified for `codex` with a live call. `gemini` gets no such flag, so it leaves a session file behind. The scan recognises it by its temporary folder and doesn't read it (6 on this machine on 2026-10-06).

**The brief in a repository you publish.** The brief summarises your sessions: what you decided, what you rejected, and the names of people you worked with. That's why it's never written into a file git would carry (guarantee 4). MCP doesn't write into your folder at all.

---

## Contributing and license

`npm test` builds into `test-build/` and never touches `dist`. Run it after any change to `redact.ts`, `reconcile.ts` or `vault.ts`.

License: [MIT](LICENSE), Mohammed Abu Shamleh.
