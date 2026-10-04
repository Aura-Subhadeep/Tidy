# AGENTS.md

Operating context for AI agents working on **Tidy**. Keep this file concise — it is
project memory, not a replacement for the source. Read it before touching code.

## What this project is

Tidy is a **no-build vanilla Chrome extension (Manifest V3)** that tracks focused
work sessions and reminds the user to take breaks. It ships as plain HTML/CSS/JS
loaded via `chrome://extensions` → *Load unpacked*. There is **no bundler, no
framework, no automated test suite, no linter, and no CI**. `package.json` has a
single script (`vendor:webawesome`).

## Components and file ownership

| File / area | Owns |
|---|---|
| `manifest.json` | MV3 manifest, permissions (`storage, alarms, notifications, offscreen`), CSP |
| `background.js` | **The authority.** Session timer state, break scheduling, skip counter, history writes, alarms, badge, notifications, and the break-window lifecycle. Classic (non-module) service worker |
| `popup.html` / `popup.js` / `popup.css` | Home + Settings UI. A **view**: reads state, writes `settings` (and `history` on import), issues commands to the worker via messages |
| `break.html` / `break.js` / `break.css` | Fullscreen break screen. Derives its countdown from state; can skip; closes itself |
| `offscreen.html` / `offscreen.js` | Plays chimes via `AudioContext` (service workers have no audio APIs) |
| `tools/vendor-webawesome.mjs` | Generates/verifies the vendored Web Awesome (single source of truth for the vendor) |
| `vendor/webawesome/dist-cdn/` + `vendor/webawesome/VENDOR_MANIFEST.json` | **Generated** vendor output — never hand-edit |
| `vendor/fonts/` | Self-hosted Instrument Sans (hand-managed) |
| `icons/` | App logo + local Lucide SVGs (`play`, `pause`, `square`), registered in `popup.js` as the `lucide` icon library |

## Where state is authoritative

All persistent data is `chrome.storage.local`:

- `state` — session/break runtime state. **Authoritative in `background.js`** (one
  narrow exception: the popup's `SETTINGS_UPDATED` path re-derives
  `breakRemainingMs`/`nextBreakAt` and saves).
- `settings` — user configuration; written by the popup.
- `skips` — `{ month, used }`; **written only by `background.js`** (`skipBreak`).
- `history` — `{ 'YYYY-MM-DD': { totalMs, sessions } }`; written by the background
  **and** by the popup (import/restore writes `history` directly — see below).

`chrome.storage.session` holds `breakWindowId` (the tracked break window). It is
**intentionally volatile** — it must not survive an extension reload, so a stale id
cannot force a reopen. Do not move it to `local`.

Countdowns shown in the popup and break page are **derived**; never store a
decrementing counter.

Pages read `state`/`settings` **directly from `chrome.storage.local`** (each page has
its own `getState()`/`getSettings()` that merges defaults). They do **not** fetch state
over messaging. `GET_STATE` exists in the background's `onMessage` chain but **no page
sends it** on `main` — verified dead code; do not treat it as a live interface, and do
not assume a page will pick up a change made only there.

The background writes `state`; pages write only `settings` (via `saveSettings`) and
`history` (via import/restore). `state` has no page-side writer.

## How the timer works

- Elapsed focus time is computed from timestamps, not a stored counter:
  `elapsed = accumulatedMs + (sessionStart ? now - sessionStart : 0)`.
- `sessionStart` marks the current continuous run segment (null while paused).
- `sessionStartedAt` is the session's first start; it survives pause/resume and
  anchors the "Session started" clock.
- Pause folds the current segment into `accumulatedMs`, sets `sessionStart = null`,
  freezes the remaining break time into `breakRemainingMs`, and clears the break alarm.
- Resume sets a new `sessionStart` and reschedules the break from the frozen remaining.

## How breaks are scheduled and ended

- `nextBreakAt` = the intended **grid** timestamp (scheduled time).
- The alarm fires at `nextBreakAt`, but MV3 may deliver it late. On delivery,
  `notifyBreak()` sets `currentBreakEndsAt = Date.now() + breakDuration`, so the
  break is measured **from delivery** and the user always gets a full break.
- `currentBreakEndsAt` is the **authoritative break end**; the popup, break page,
  and the `ALARM_BREAK_TICK` alarm all use it.
- **Natural completion** (`ALARM_BREAK_TICK` → `endBreak(true)`) re-anchors the next
  break from the actual break end (`currentBreakEndsAt`).
- **Skipping** (`endBreak(false, state.nextBreakAt)`) preserves the original grid;
  it does not restart an interval from the moment of the skip.
- The break window reopening logic disambiguates "our own close" from a user close
  by clearing `breakWindowId` **before** removing the window.

If you touch `background.js`, these two anchors (`nextBreakAt` vs
`currentBreakEndsAt`) and the skip-vs-natural distinction are the easiest things to
break silently.

## Non-negotiable behavior

- Timestamps are the authoritative clock; countdowns are always derived.
- Break duration is measured from actual delivery, not the grid.
- Skipping preserves the break grid; a natural break re-anchors to the break end.
- Closing the fullscreen window does **not** end a break — it is reopened.
- `reconcileAlarms()` is **repair-only**; it must not perform state transitions
  (a racing `onStartup` must not be able to double-apply one).
- Web Awesome components are imported statically per page; the autoloader is never used.
- The extension stays **fully offline** — no remote JS, CSS, fonts, or icons.

## Message and event flows

Commands travel page → worker; state changes travel worker → page. Verified on `main`:

| Message | Direction | Notes |
|---|---|---|
| `START_SESSION` / `PAUSE_SESSION` / `RESUME_SESSION` / `STOP_SESSION` | page → worker | session transitions |
| `SKIP_BREAK` | page → worker | popup and break page both send it |
| `SETTINGS_UPDATED` | page → worker | the one settings-write path |
| `GET_STATE` | — | **handled but never sent** on `main` (dead code) |
| `STATE_CHANGED` | worker → page | broadcast after mutations; popup and break page listen |
| `PLAY_SOUND` | worker → offscreen doc | intercepted and ignored by the worker itself |

`notifyStateChanged()` swallows the "no receiver" error because the popup is usually
closed when the worker broadcasts. Adding or renaming a message requires mirroring it in
both the background's `onMessage` chain **and** every page that sends or listens for it —
these are separate script contexts with no shared module.

The background's `onMessage` and `onAlarm` if/else chains are the two places where all
transitions are decided. They are also the highest-risk spot for merges.

## MV3 / service-worker constraints

- `background.js` is a **classic** service worker script; `offscreen.js` is a classic
  script. Only `popup.js` and `break.js` are ES modules (`<script type="module">`).
  Module features cannot be used in the worker/offscreen contexts.
- CSP is `script-src 'self'; style-src 'self' 'unsafe-inline'`. No remote scripts or
  styles. Inline *styles* are allowed (Web Awesome and inline `style=""` use them).
- Service workers are suspended aggressively. Alarms persist across suspension but
  are dropped on extension reload and browser restart. Timers must not rely on the
  worker staying alive.
- Alarms have a minimum granularity in production (~0.5 min).
- Only one offscreen document may exist; `playSound()` tolerates the concurrent-create race.

## Vendor rules

- `vendor/webawesome/dist-cdn/` and `VENDOR_MANIFEST.json` are **generated build
  artifacts** committed only so clones work offline. Never edit them by hand,
  including the Bunny Fonts removal — that patch lives in the script.
- To add/remove/upgrade a component, change the component list or the script and run
  `npm run vendor:webawesome` (then add/remove the static import in `popup.js`
  yourself). `--check` verifies a clone; `--upgrade <version>` pins a new version.
- The version is pinned exactly (no semver ranges). See [VENDOR.md](VENDOR.md) for the
  full operational process.

## Recovery (current `main`)

- `reconcileAlarms()` runs on **every worker module load** and repairs alarms from the
  persisted timestamps (`ALARM_BREAK` from `nextBreakAt`, `ALARM_BREAK_TICK` from
  `currentBreakEndsAt`, reopens the break window if `breakMode`). It performs **no**
  state transitions.
- `chrome.runtime.onStartup` banks a running session's elapsed time (only if the
  plausible gap is under 24h) and resets state to idle.
- **Not on `main`:** heartbeat-based recovery (`lastSeenAt`, `SHUTDOWN_GAP_MS`,
  `reconcileIfBrowserGone`, `refreshHeartbeat`, `createBadgeTick`, `ensureBadgeTick`,
  the `RECONCILE` message) lives on the unmerged `fix/session-recovery` branch. Verified
  absent from `main`: none of those identifiers appear in any file on `main`. Do not
  describe or assume it as current behavior.
- Current verified limitation: `reconcileAlarms()` only creates `ALARM_BADGE_TICK` in
  its final branch, which is reached only when the session is running, not paused, not
  breaking, **and** `nextBreakAt` is falsy. While running, `nextBreakAt` is normally set,
  so that branch is effectively unreachable and the badge tick is not rebuilt. Chrome
  drops alarms on extension reload, so the badge can stop updating after a reload until
  the next state change. Do not "fix" this incidentally.

## Duplicated constants

Because there is no build step and the worker is a classic script, several constants
are **hand-duplicated across files and must be kept in sync manually**:

| Constant | Files |
|---|---|
| `SKIP_LIMIT = 3` | `background.js`, `popup.js`, `break.js` |
| `DEFAULT_SETTINGS` | `background.js`, `popup.js`, `break.js` |
| `DEFAULT_STATE` | `background.js`, `popup.js`, `break.js` |
| `monthKey()` | `background.js`, `popup.js`, `break.js` |
| `dayKey()` | `background.js`, `popup.js` |
| `fmtClock()` | `popup.js`, `break.js` |

`background.js` and `popup.js` also duplicate `dayKey()`; `break.js` does not need it.
Changing any of these requires editing every listed file — a change in only one place
produces silently divergent UI vs. authority behavior (e.g. a different skip limit shown
than is enforced).

## AI attribution is prohibited

**Never add AI attribution to commits or any repository metadata in this project.** This
includes, without limitation:

- `Generated with Codebuff`, `Generated with Claude`, or any similar generated-by line
- `Co-Authored-By: Codebuff <noreply@codebuff.com>`
- `Co-Authored-By:` trailers naming **any** AI (Claude, GPT, Copilot, Gemini, Codebuff,
  or any other model/tool)
- AI attribution appended automatically by tooling or editor plugins

AI tools may assist with development, but **commits must represent the project's human
author only**. Do not add attribution unless the repository owner explicitly requests it
in that instance — no such request has been made for this repository, so the rule is
unconditional in practice. This applies to commit messages, trailers, authorship,
co-authorship, and any other Git or repository metadata.

If a tool would auto-insert a trailer, disable it or strip the trailer **before**
committing; do not amend it later unless asked. This mirrors the existing history on
`main`, where no commit carries AI attribution.

## Git safety

- **`main` is the stable baseline.** Do not switch off it for this kind of work.
- Keep changes focused. Stage explicit paths only — never `git add -A`, which sweeps in
  files you did not create or intend to include.
- Resolve conflicts **semantically**, not merely textually. A clean textual merge can
  silently drop or duplicate a branch. Pay particular attention to the `onMessage`
  and `onAlarm` if/else chains and the recovery logic in `background.js`, and mirror
  any message-name change in `popup.js`/`break.js`.
- There is no established rebase-vs-merge preference in the repository — do not invent one.

### Commit and push require explicit, immediately-prior approval

Prior authorization is not enough. The repository owner runs the commit and push
themselves for documentation work, and the approval must be given for the specific
action, not inferred from an earlier, broader instruction.

- **Never run `git commit` without explicit user approval given immediately before that
  commit.** Show the exact staged diff (`git diff --cached`) and the proposed commit
  message, then **stop and wait** for approval. A prior "commit and push this" covers
  neither the content nor the message of a later, changed commit.
- **Never run `git push` without explicit user approval given immediately before that
  push.** Show the exact branch and remote target (for example `main` →
  `origin/main`, plus `git remote -v`), then **stop and wait** for approval.
- If a user message says the owner will commit and push manually, treat that as a
  standing instruction **not** to run `git commit` or `git push` at all. Prepare the
  changes and hand over the diff and a proposed message instead.
- **Never rewrite Git history unless explicitly instructed** — no `git commit --amend`,
  no `git rebase`, no `git reset` that moves an already-pushed commit. An instruction to
  *prepare* a replacement commit is not an instruction to create it.
- **Never use force push or other destructive Git operations without explicit
  approval** — no `git push --force`, `git push --force-with-lease`, `git reset --hard`,
  `git clean`, or `git branch -D`. These require their own explicit go-ahead even when a
  push or commit was already approved.

The operational rules for commit content (no AI attribution) are in the next section.

## Verification expectations

- There is no automated test suite. Verify by loading the unpacked extension and
  exercising: start / pause / resume / stop, a natural break, a skip, fullscreen
  on/off, and an **extension reload mid-session**.
- For vendor changes, run `npm run vendor:webawesome -- --check`.
- Confirm `git status` is clean of unintended files; run `git diff --check`.

## Documentation map

- `README.md` → user-facing behavior and features.
- `VENDOR.md` → Web Awesome / vendor operational process.
- `AGENTS.md` → this file: AI/project operating context.
- `docs/DECISIONS.md` → durable decisions and their rationale.
