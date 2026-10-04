# Tidy — Decisions

Durable project memory for **Tidy**. Organized by topic, not chronology. Each entry
records a decision, why it was made (where the repository supports a reason), the
constraints it creates, and what future changes must preserve.

Scope note: every "current behavior" statement below describes the current `main`
branch, verified against the files in that branch's tip. No commit SHA is pinned here,
so the record stays valid as `main` advances. Work that exists only on the unmerged
`fix/session-recovery` branch is called out explicitly under **Deferred work** and is
**not** part of current architecture.

Every statement in this file was verified against the files on `main`. Where the repository
does not establish a rationale, the entry says so rather than inventing one.

---

## Product behavior

### Focus sessions are user-driven and time-tracked
- **Decision.** A session is started, paused, resumed, and stopped from the popup.
  Work time is accumulated and stored per calendar day.
- **Why.** The product is a focused-work timer with break reminders.
- **Constraints.** Session transitions are owned by the background worker; the popup
  only issues messages.
- **Preserve.** The start / pause / resume / stop semantics and the daily history model.

### Break cadence is a product promise
- **Decision.** Skipping a break never postpones the following breaks.
- **Why.** README states it explicitly: skipping must not let a user shift their
  schedule. It is a deliberate product guardrail.
- **Constraints.** Skip must reschedule from the original grid (see *Skip behavior*).
- **Preserve.** The grid-preserving skip behavior.

### Monthly skip allowance
- **Decision.** Up to 3 skips per calendar month; the allowance resets on the 1st.
- **Why.** A gentle nudge rather than a hard block.
- **Constraints.** Reset is derived from the current month on read; it is not driven
  by a timer or a cleanup write.
- **Preserve.** The lazy month comparison and the 3-per-month limit.

### Restart-safe accounting
- **Decision.** If the browser closes mid-session, the elapsed work is recorded on
  the next startup.
- **Why.** A closed browser should not silently discard completed work.
- **Constraints.** The startup salvage credits time only when the gap is plausible.
- **Preserve.** Banking elapsed time on startup, and the plausibility cap (see *Recovery*).

---

## Session architecture

### Background is the single source of truth
- **Decision.** `background.js` owns session state, the skip counter, alarms, the badge,
  notifications, and the break-window lifecycle. Pages read `state`/`settings` **directly
  from `chrome.storage.local`** (each page has its own `getState()`/`getSettings()` that
  merges defaults over the stored object); they do not fetch state over messaging.
- **Why.** The popup and break pages are transient; a service worker can be suspended
  and woken at any time, so authority cannot live in a page.
- **Constraints.** Pages issue commands by message and never perform session transitions.
  Verified on `main`: the popup writes only `settings` (and `history` when importing a
  backup) — it has **no** `state` writer. The background has **no** `history` writer
  other than `addWorkMsToToday`; the popup's import path is a second writer.
- **Preserve.** Background authority over session transitions, `state`, and `skips`;
  the asymmetry that the popup may write `history` but never `state`.

### `GET_STATE` is dead code on `main`
- **Decision (current state).** The background's `onMessage` chain handles `GET_STATE`, but
  **no page sends it** — verified: `popup.js` and `break.js` contain no `GET_STATE` sender.
  Both read state straight from storage instead.
- **Why (unknown).** The repository does not record why this handler exists or when the
  pages stopped using it.
- **Constraints.** Do not document it as a live interface, and do not assume changing it
  affects either page. It is safe to leave; removing it is a separate decision.
- **Preserve.** Awareness that state flows through storage, not this message.

### Two start timestamps with distinct meanings
- **Decision.** `sessionStart` marks the current continuous run segment (null while
  paused); `sessionStartedAt` records the session's first start and survives
  pause/resume.
- **Why.** Elapsed time must count only active work, while the UI still needs a stable
  "session started" clock.
- **Constraints.** Do not collapse these into one field.
- **Preserve.** Using `accumulatedMs + (now - sessionStart)` for elapsed, and
  `sessionStartedAt` for display.

### Pause freezes break progress
- **Decision.** Pausing stores the remaining time to the next break in
  `breakRemainingMs`, nulls `nextBreakAt`, and clears the break alarm. Resume
  reschedules from the frozen remaining.
- **Why.** Pause should not silently reset break progress.
- **Constraints.** `breakRemainingMs` is only meaningful while paused.
- **Preserve.** Freeze-on-pause / restore-on-resume.

---

## Timer and scheduling

### Countdowns are derived from timestamps
- **Decision.** Elapsed time and break countdowns are computed from persisted
  timestamps (`sessionStart`, `nextBreakAt`, `currentBreakEndsAt`), never from a stored
  decrementing counter.
- **Why.** MV3 service workers can be suspended, so an in-memory or decrementing
  counter would drift or stop; timestamp math is suspension-proof and identical across
  the badge, popup, and break page.
- **Constraints.** All consumers must read the same timestamps; UI tickers only re-derive.
- **Preserve.** Timestamps as the authoritative clock.

### Break scheduling uses a grid with bounded catch-up
- **Decision.** `scheduleNextBreak(fromMs)` sets
  `nextBreakAt = fromMs + (floor(max(0, now - fromMs)/interval) + 1) * interval`, then
  creates the break alarm at that exact time.
- **Why.** When an anchor is already overdue, the next break must advance to the next
  whole interval instead of firing immediately, keeping the cadence. Arithmetic (not a
  loop) keeps the work bounded.
- **Constraints.** The alarm's `when` must equal `nextBreakAt` so the alarm and the
  popup countdown always agree. Repeating is enabled only when `autoRepeatBreaks` is on.
- **Preserve.** The grid math and the `when === nextBreakAt` coupling.

### Break duration is measured from delivery
- **Decision.** `notifyBreak()` sets `currentBreakEndsAt = Date.now() + breakDuration`.
- **Why.** An MV3 wake can land well after `nextBreakAt`; the user must still receive a
  full-length break rather than a truncated one.
- **Constraints.** The break-end alarm (`ALARM_BREAK_TICK`) is created at
  `currentBreakEndsAt`, before the notification is shown, so the break ends on time
  even if the notification fails.
- **Preserve.** Measuring the break from delivery, and creating the end alarm before
  other side effects.

### Changing the interval reschedules from now
- **Decision.** `SETTINGS_UPDATED` for a running, non-breaking session calls
  `scheduleNextBreak()` anchored to the current time; for a paused session it re-derives
  `breakRemainingMs` from the new interval.
- **Why.** New settings should take effect promptly without resuming a stale countdown.
- **Constraints.** This intentionally does **not** preserve the old grid.
- **Preserve.** This is current behavior; do not silently change it without deciding so.

---

## Break behavior

### Three distinct times
- **Decision.** **Scheduled time** = `nextBreakAt` (the grid). **Actual delivery time**
  = when the worker runs `notifyBreak()`. **Authoritative break-end time** =
  `currentBreakEndsAt`.
- **Why.** These differ whenever Chrome wakes the worker late; conflating them would
  either truncate breaks or drift the countdown.
- **Constraints.** Countdowns use the end time; the grid is only for scheduling.
- **Preserve.** The distinction and the fields that represent it.

### Natural completion re-anchors to the break end
- **Decision.** When the break-end alarm fires, `endBreak(true)` reschedules from
  `currentBreakEndsAt`.
- **Why.** A completed break should start the next interval when the break actually
  ended.
- **Constraints.** `currentBreakEndsAt` falls back to `now` if unset.
- **Preserve.** Natural-break anchoring to the actual break end.

### Closing the window does not end the break
- **Decision.** A break window removed while a break is running is reopened.
- **Why.** Chrome cannot disable the window's close control, and the product intent is
  that the break actually happens.
- **Constraints.** Intentional closes clear `breakWindowId` **before** removing the
  window; the removal listener reopens only when the removed id still matches the
  tracked id and `breakMode` is true.
- **Preserve.** Clear-id-before-close ordering, and the reopen guard.

---

## Skip behavior

### A skipped break preserves the grid
- **Decision.** `skipBreak()` increments the counter and calls
  `endBreak(false, state.nextBreakAt)`, so the next break is anchored to the original
  grid timestamp.
- **Why.** The next break should arrive on the interval the user was already on;
  skipping must not buy extra focus time.
- **Constraints.** `notifyBreak()` deliberately does **not** clear `nextBreakAt`, so the
  original grid remains available at skip time.
- **Preserve.** Passing the original grid as the skip anchor.

### Natural and skipped breaks differ on purpose
- **Decision.** Natural completion anchors to the actual break end; skipping anchors to
  the original grid.
- **Why.** Natural completion absorbs delivery latency; skipping must stay on schedule.
- **Constraints.** This is why `endBreak(resumeWork, nextAnchorMs)` has two anchors.
- **Preserve.** The two-anchor design; do not unify it.

### Skip authority and reset
- **Decision.** Only `background.js` writes the skip counter. `getSkips()` compares the
  stored month key to the current month on every read; a stale key reads as a fresh
  allowance with no write.
- **Why.** Pages are transient and must not race the counter; the reset should not
  require a scheduled job.
- **Constraints.** `SKIP_LIMIT = 3` is duplicated across `background.js`, `popup.js`,
  and `break.js` (see *Storage/data*).
- **Preserve.** Background-only writes and the lazy month comparison.

### Skip is protected against double consumption
- **Decision.** The popup and break page disable their skip control while the reply is
  in flight, and the worker guards on `breakMode`.
- **Why.** Prevent a double click from consuming two skips or ending a break twice.
- **Constraints.** A second `skipBreak()` finds `breakMode === false` and is rejected.
- **Preserve.** Both the UI guard and the worker-side `breakMode` check.

---

## Fullscreen break

### Configurable, default on
- **Decision.** `settings.fullscreenBreak` (default `true`) controls whether a break
  opens a fullscreen window. Disabling it still runs the entire break from the popup;
  only the window is skipped.
- **Why.** The break should be hard to miss by default, but users may prefer popup-only
  breaks.
- **Constraints.** The setting's source of truth is the `settings` object in
  `chrome.storage.local`; the popup owns edits.
- **Preserve.** That disabling fullscreen does not change break timing or skip behavior.

### Window creation is defensive
- **Decision.** `openBreakWindow()` tries `state: 'fullscreen'` first and falls back to
  a focused non-fullscreen popup if fullscreen is refused.
- **Why.** Fullscreen can be refused (another fullscreen window, some platforms); the
  break must still be visible.
- **Constraints.** The window id is stored in `chrome.storage.session` as
  `breakWindowId`.
- **Preserve.** The fullscreen-first fallback and the session-storage id.

### Settings changes during an active break
- **Decision.** `SETTINGS_UPDATED` closes the window when fullscreen is disabled, and
  ensures (opens/keeps) it when fullscreen is enabled during a break.
- **Why.** The setting should take effect immediately.
- **Constraints.** Closing goes through `closeBreakWindow()`, which clears the id first.
- **Preserve.** Immediate application without ending the break.

---

## Recovery and lifecycle

### `reconcileAlarms()` is repair-only
- **Decision.** On every worker module load, `reconcileAlarms()` refreshes the badge and
  rebuilds alarms from persisted timestamps — `ALARM_BREAK_TICK` from
  `currentBreakEndsAt` while breaking, otherwise `ALARM_BREAK` from `nextBreakAt`, and
  reopens the break window when breaking. It performs **no** state transitions.
- **Why.** Alarms are dropped on extension reload, so they must be rebuilt; keeping the
  function transition-free means a racing `onStartup` cannot double-apply a transition.
- **Constraints.** Alarm creation is clamped to `max(now + 1000, target)` so an overdue
  target fires promptly rather than immediately.
- **Preserve.** Repair-only semantics and the clamp.

### Startup banks elapsed time and resets to idle
- **Decision.** `chrome.runtime.onStartup` credits `accumulatedMs` plus the current
  segment (only when `0 < elapsed < 24h`), records it to the day, resets state to
  `DEFAULT_STATE`, clears all alarms, and refreshes the badge.
- **Why.** A closed browser ends the session; unsaved time should be preserved without
  trusting an implausible gap.
- **Constraints.** The 24-hour plausibility cap is deliberate.
- **Preserve.** Bank-then-reset, and the plausibility cap.

### Break-window creation is deduplicated
- **Decision.** `ensureBreakWindow()` coalesces concurrent calls through an in-memory
  `breakWindowTask` promise.
- **Why.** Multiple sources (`notifyBreak`, the removal listener, `reconcileAlarms`,
  settings changes) can request a window at once.
- **Constraints.** The task promise is module-scoped and reset in `finally`.
- **Preserve.** The dedupe guard; removing it risks duplicate windows.

### Service-worker lifecycle assumption
- **Decision.** Listeners (`onAlarm`, `onMessage`, `onRemoved`, `onStartup`,
  `onInstalled`) are registered at module top level; state lives in storage.
- **Why.** MV3 requires listeners to be registered on each wake, and a suspended worker
  keeps nothing in memory.
- **Constraints.** Do not move listener registration behind async work or conditionals.
- **Preserve.** Top-level registration and storage-backed state.

---

## Storage and data

### `chrome.storage.local` is the persistent store
- **Decision.** Four keys: `state`, `settings`, `skips`, `history` — verified as the only
  keys used on `main`.
- **Why.** Survives worker suspension and browser restarts; local-only satisfies the
  privacy promise (no network).
- **Constraints.** Writes are whole-object `set` calls after a `get` → mutate → `set`
  cycle (not atomic across overlapping handlers).
- **Preserve.** Background as the sole writer for `state` and `skips`. `history` has two
  writers: the background's `addWorkMsToToday` and the popup's import/restore path.

### `breakWindowId` lives in session storage
- **Decision.** The tracked break window id is stored in `chrome.storage.session`.
- **Why.** It is intentionally volatile: a stale id must not survive an extension
  reload and force an unwanted reopen.
- **Constraints.** It is cleared automatically on reload.
- **Preserve.** Session, not local.

### No schema versioning or migrations
- **Decision.** There is no stored schema version.
- **Why.** Reading merges defaults onto the stored object, so new fields are additive.
- **Constraints.** Removing or renaming a field requires care; the code does not migrate.
- **Preserve.** Merge-with-defaults reads; be deliberate about field removal.

### Intentional duplication of immutable constants
- **Decision.** Several constants are hand-duplicated across script contexts. Verified
  file-by-file on `main`:

  | Constant | Files |
  |---|---|
  | `SKIP_LIMIT = 3` | `background.js`, `popup.js`, `break.js` |
  | `DEFAULT_SETTINGS` | `background.js`, `popup.js`, `break.js` |
  | `DEFAULT_STATE` | `background.js`, `popup.js`, `break.js` |
  | `monthKey()` | `background.js`, `popup.js`, `break.js` |
  | `dayKey()` | `background.js`, `popup.js` |
  | `fmtClock()` | `popup.js`, `break.js` |

- **Why.** Each page/worker is a separate script context and the extension has no build
  step, so shared modules are not available (the worker is classic; only popup/break are
  ES modules).
- **Constraints.** Duplicated values must be kept in sync by hand; comments mark them
  (e.g. `// mirrors SKIP_LIMIT in background.js`). Changing one copy only produces
  silently divergent UI-vs-authority behavior — e.g. a skip limit the popup displays that
  differs from the one the worker enforces.
- **Preserve.** The duplication is a consequence of the no-build decision, not an
  invitation to add a build step casually.

### Backup is broader than restore
- **Decision.** Export dumps all of `chrome.storage.local` (including `state` and
  `skips`), but restore applies only `settings` and/or `history`, then reloads the
  extension. This is the popup's one direct write to `history`.
- **Why.** Restoring session runtime state or a skip counter could produce surprising
  behavior; settings and history are the useful portable data.
- **Constraints.** `pendingImportData` is cleared on confirm, cancel, and dialog hide.
- **Preserve.** The export/restore asymmetry unless a deliberate decision changes it.

### Clearing history is scoped
- **Decision.** "Clear all history" removes only the `history` key.
- **Why.** It is a history reset, not a factory reset.
- **Constraints.** Settings, skips, and state are untouched.
- **Preserve.** The narrow scope.

---

## Messaging

### Commands flow to the background; state changes flow back
- **Decision.** Pages send command messages (`START_SESSION`, `PAUSE_SESSION`,
  `RESUME_SESSION`, `STOP_SESSION`, `SKIP_BREAK`, `SETTINGS_UPDATED`); the background
  broadcasts `STATE_CHANGED` after mutations. `PLAY_SOUND` goes from the background to the
  offscreen document (the worker explicitly ignores it: `if (msg.type === 'PLAY_SOUND') return;`).
- **Why.** One authority issuing transitions keeps the UI consistent.
- **Constraints.** `notifyStateChanged()` swallows the "no receiver" error because the
  popup is usually closed; message-name changes must be mirrored in `popup.js` and/or
  `break.js`. These are separate script contexts with no shared module, so a rename must
  be made in the worker **and** every page that sends or listens for it.
- **Preserve.** The message names and the broadcast pattern.

### The background handler is the conflict hot spot
- **Decision.** Transitions live in the `onMessage` if/else chain and the `onAlarm`
  chain.
- **Why.** These concentrated chains are where behavior is decided.
- **Constraints.** A merge must not duplicate or drop branches in these chains.
- **Preserve.** Single ownership of each transition in the background.

---

## UI architecture

### Two-page popup, no router
- **Decision.** Home and Settings are sibling sections toggled with the `[hidden]`
  attribute via `showPage()`; both headers pre-exist in the markup.
- **Why.** Simple, no framework, no routing.
- **Constraints.** `popup.css` forces `[hidden] { display: none !important }` because
  `.page` sets `display: flex`.
- **Preserve.** The `[hidden]` override and the two-page structure.

### Web Awesome is used as a component layer, statically imported
- **Decision.** Pages import the specific `wa-*` components they use; the autoloader is
  never started.
- **Why.** The autoloader would fetch components lazily, which conflicts with the
  offline, no-build runtime model.
- **Constraints.** An un-vendored `<wa-*>` tag simply never upgrades.
- **Preserve.** Static per-page imports; add/remove components in the vendor + import
  together.

### Theme, fonts, and icons are local
- **Decision.** The Awesome theme stylesheets are linked after the base styles; a
  self-hosted Instrument Sans overrides the theme font via `--wa-font-family-*`; system
  icons are built-in and local Lucide SVGs are registered as an `lucide` library.
- **Why.** Offline operation and CSP `style-src 'self'`.
- **Constraints.** Break page uses system icons only (it does not register `lucide`).
- **Preserve.** Self-hosted typography and no remote icon libraries.

### First-paint animation suppression
- **Decision.** `body` starts with `suppress-anim`; JS removes it after two animation
  frames, and `body.ready` drives fade-in of the status pill and timer.
- **Why.** Prevent every popup open from animating hidden→visible.
- **Constraints.** Preserve the class-to-`ready` sequence.
- **Preserve.** The suppress→ready first-paint pattern.

---

## Web Awesome / vendor architecture

### Web Awesome is vendored as a curated subset
- **Decision.** Only the runtime closure of the 7 used components (`button`,
  `checkbox`, `dialog`, `icon`, `input`, `switch`, `tooltip`) is committed under
  `vendor/webawesome/dist-cdn/`, with a manifest recording the pinned version
  (`3.14.0`), per-file SHA-256 hashes, and sizes.
- **Why.** Keeps the extension fully self-contained at runtime (no CDN, no network, no
  build) while avoiding shipping the ~11 MB full distribution.
- **Constraints.** The version is pinned exactly; the generated output is committed only
  so clones load offline.
- **Preserve.** The pinned version, the curated closure, and the offline guarantee.

### The generator is the single source of truth
- **Decision.** `tools/vendor-webawesome.mjs` resolves the runtime closure from the
  package tarball, applies one deterministic patch (removing the upstream Bunny Fonts
  `@import`), writes the manifest, and validates the result. `--check` verifies a clone.
- **Why.** Reproducible, idempotent regeneration; the offline CSP would block the
  remote font import anyway.
- **Constraints.** Never hand-edit `dist-cdn/` or `VENDOR_MANIFEST.json`; add/remove/
  upgrade through the script. App code (the static import) is edited by the developer.
- **Preserve.** Generated files are outputs, never sources; the Bunny removal stays in
  the script.

### What belongs where
- **Decision.** `VENDOR.md` documents the operational process; `AGENTS.md` states the
  short rules; this file records the decision and rationale.
- **Why.** Avoid duplicating the procedure across documents.
- **Preserve.** Keep operational how-to in `VENDOR.md`.

---

## Platform / security constraints

### Manifest V3 with a service worker
- **Decision.** MV3, `background.service_worker`, permissions exactly
  `storage, alarms, notifications, offscreen`.
- **Why.** Current Chrome extension platform.
- **Constraints.** No persistent background page; listeners registered on every wake;
  alarms dropped on reload/restart; alarm minimum granularity applies.
- **Preserve.** The MV3 model and the permission set (adding permissions broadens trust).

### Strict CSP and fully local assets
- **Decision.** `script-src 'self'; style-src 'self' 'unsafe-inline'`.
- **Why.** Security and the offline requirement.
- **Constraints.** No remote scripts/styles; inline styles are allowed and relied upon.
- **Preserve.** No remote runtime dependencies.

### Classic vs module boundaries
- **Decision.** `background.js` and `offscreen.js` are classic scripts; `popup.js` and
  `break.js` are ES modules.
- **Why.** The service worker does not use module imports here, and offscreen is a
  plain script; the pages need imports for the vendored components.
- **Constraints.** Module-only syntax cannot be used in the worker/offscreen.
- **Preserve.** The context boundaries; do not import in the worker without converting it.

### Sound requires an offscreen document
- **Decision.** Chimes are played by `offscreen.html`/`offscreen.js` via `AudioContext`,
  created on demand with reason `AUDIO_PLAYBACK`.
- **Why.** Service workers have no audio APIs and the popup is usually closed.
- **Constraints.** Only one offscreen document may exist; the create race is tolerated.
- **Preserve.** The offscreen approach and its single-document handling.

---

## Git / development workflow

### `main` is the stable baseline
- **Decision.** Work proceeds from `main`; it is treated as the reference state.
- **Why.** It is the released branch (`origin/main`).
- **Constraints.** Do not force-push or rewrite shared history on your own initiative.
  History rewriting and force pushes are destructive and revertible only by the owner;
  they happen only when the owner explicitly instructs them.
- **Preserve.** Linear, shared `main`.

### Focused commits with conventional prefixes
- **Decision.** History uses short conventional prefixes (`feat:`, `style:`).
- **Why.** Readable, consistent history.
- **Constraints.** Keep commits focused; do not bundle unrelated changes; do not commit
  or push without explicit authorization.
- **Preserve.** The commit style and scope discipline.

### Conflicts must be resolved semantically
- **Decision.** A clean textual merge is not sufficient; the merged behavior must be
  verified against both sides' intent.
- **Why.** A textual merge can silently drop or duplicate a branch — especially in the
  `background.js` `onMessage`/`onAlarm` if/else chains and the recovery logic.
- **Constraints.** Message-name changes must be mirrored in the page listeners.
- **Preserve.** Semantic review of these hot spots on every merge.

### No established rebase-vs-merge preference
- **Decision.** The repository does not establish a definitive preference.
- **Why.** History is too thin to establish a workflow rule (it contains one merge
  commit that merged `origin/main` into a feature branch).
- **Constraints.** Do not invent a mandate.
- **Preserve.** None — this is an intentionally open point.

### Commits and pushes need explicit, immediately-prior approval
- **Decision.** An agent never runs `git commit` or `git push` on prior or implied
  authorization. Before a commit it shows the exact staged diff and the proposed message
  and waits; before a push it shows the branch and remote target and waits. Approval
  covers that specific action only — a reworded message or an added file invalidates it.
  When the owner states they will commit and push manually, the agent prepares the
  changes and hands over the diff instead of committing.
- **Why.** Commits and pushes are the points where work becomes published and shared
  history; they are the owner's to make, and they are hard to undo once pushed.
- **Constraints.** Applies to documentation-only work as much as to code. An instruction
  to *prepare* a replacement commit is not permission to create or amend it.
- **Preserve.** The stop-and-wait gate. The operational rules live in `AGENTS.md`.

### AI attribution is prohibited in commits
- **Decision.** Commits and repository metadata must never carry AI attribution: no
  `Generated with <tool>` lines, no `Co-Authored-By:` trailers naming any AI (Codebuff,
  Claude, GPT, Copilot, Gemini, or any other model/tool), and no tooling-injected trailer
  of that kind. Commits represent the human author only.
- **Why.** The repository owner requires it explicitly, and it is consistent with the
  existing history: no commit reachable from `main` carries AI attribution (verified —
  all commits on `main` were scanned for those patterns and returned no matches).
- **Constraints.** AI tooling may assist with development, but must not leave attribution
  in the repository. Strip or disable auto-inserted trailers before committing. Do not add
  attribution unless the owner explicitly requests it in that instance.
- **Preserve.** The absence of AI attribution in history. The operational rules live in
  `AGENTS.md`; this entry records the decision itself.

---

## Known limitations

### Badge tick is not rebuilt on extension reload mid-session (verified)
- **Decision (current state).** No fix on `main`.
- **Why it happens.** `reconcileAlarms()` only recreates `ALARM_BADGE_TICK` on the
  branch where the session is running, not paused, not breaking, and `nextBreakAt` is
  falsy. In normal operation `nextBreakAt` is always set while running, so that branch is
  effectively unreachable. Chrome drops alarms on extension reload, so the badge can stop
  updating until the next state change.
- **Constraints.** This is a known gap; do not "fix" it incidentally.
- **Preserve.** Documented as a limitation until addressed deliberately.

### Startup recovery cannot distinguish sleep from restart
- **Decision (current state).** `onStartup` salvages elapsed time using a 24-hour
  plausibility cap rather than a heartbeat.
- **Why.** `onStartup` only runs on a real browser start, and there is no finer signal on
  `main`.
- **Constraints.** Gaps of 24 hours or more are not credited.
- **Preserve.** The cap is deliberate.

### No automated test suite, linter, or CI
- **Decision (current state).** Verification is manual.
- **Why.** The project is a small no-build extension.
- **Constraints.** Changes must be manually tested in a loaded extension.
- **Preserve.** Be explicit about how behavior was verified.

---

## Deferred work

### `fix/session-recovery` is unmerged
- **Status.** The branch exists with two commits not on `main`
  (*Fix session recovery after browser interruption*, *Fix session timer badge recovery*)
  plus a merge commit that incorporates `origin/main`.
- **Contents (NOT current architecture).** Heartbeat-based recovery: a persisted
  `lastSeenAt` stamped on writes, `SHUTDOWN_GAP_MS` (5 minutes), `reconcileIfBrowserGone()`
  (banks work up to the last heartbeat, discards the gap, resets to idle),
  `refreshHeartbeat()`, `createBadgeTick()`/`ensureBadgeTick()` (badge-tick repair using
  `delayInMinutes`), and a `RECONCILE` message sent from the popup's `refresh()`.
  It also changes `addWorkMsToToday()` to accept an explicit day key so recovered work is
  banked to the day it happened.
- **Verified absent from `main`.** `lastSeenAt`, `SHUTDOWN_GAP_MS`,
  `reconcileIfBrowserGone`, `refreshHeartbeat`, `createBadgeTick`, `ensureBadgeTick`, and
  `RECONCILE` each return zero matches across all files on `main`.
- **Why deferred.** It is committed but not merged; `main` does not contain it.
- **Constraints.** Do not describe any of the above as current `main` behavior, and do
  not assume its function names exist on `main`. Note that its merge also reroutes
  `reconcileAlarms()`'s badge-tick creation through `createBadgeTick()`, which is a
  behavior change to a `main` function — do not assume `main` behaves this way.
- **Preserve.** The distinction between current and deferred behavior in all docs and
  discussions.

---

## Open decisions

- **Merge path for `fix/session-recovery`.** Whether and how to land the heartbeat work
  is undecided. Note its merge also changes `reconcileAlarms()`'s badge-tick creation,
  which interacts with the badge limitation recorded above.
- **Badge tick not rebuilt on reload.** Verified present on `main` (see *Known
  limitations*). The branch's `ensureBadgeTick()` addresses it, but that is not current
  behavior. Fixing it on `main` has not been decided.
- **Consolidating duplicated defaults.** The duplicated constants cannot be unified
  without adding a build/module layer, which conflicts with the no-build decision.
  Unresolved.
- **Removing the dead `GET_STATE` handler.** It is unused on `main`; removal is a
  separate, undecided cleanup.
- **Stale branch cleanup.** `feature/focus-experience` is contained in `main`; whether to
  delete it is undecided.
- **Unknowns (not decided, not assumed).** The repository does not establish a
  rebase-vs-merge preference, a publishing/store policy, any localization plan, or a
  reason for `GET_STATE` existing. These are recorded as unknown rather than guessed.
