# Review, round 4: final code review (2026-10-26)

**Status: all findings fixed** except where marked (tests: see the end).

Focus, as asked: **accuracy** (does the app say something false?), **maintainability** and
**readability**, the same way as round 3's code reviews. Three reviewers went over commit
`9f5e640` in parallel, each on one part of the code:
1. **Engine, analysis, sweep, worker**
2. **Fixes, data, builder logic**
3. **UI** (components, saved systems, styles; checked in the browser at 1440, 1180, 1000 and 390 px)

Every accuracy finding was reproduced by its reviewer with a script, numbers or a browser run
(session scratchpad, `review4/` and `review4ui/`), and checked again before fixing. The fixes were
made in three batches (engine/analysis in the main session; fixes/data/builder and UI by two
agents, merged and re-tested here). Severity: **B** blocker, **M** major, **m** minor, **n** nit.

## Verdict

**The engine was right; a few things the app said about it were not, and the UI had one crash.**

What holds:
- The simulation itself: event order, retries, budgets, splits, queues, caches, per-call counts,
  settling and the tipping-point sweep all do what their comments and the decision log say.
- The renames ("retries", "load balancer", "copies") read correctly everywhere a user sees them.

What didn't:
- **The story told the cache "emptied" when it hadn't.** Retries look up the very keys that just
  missed, which halved the measured hit rate while the cache answered as many lookups as before.
- **A few verdicts depended on how the run ended rather than on the system** (no client timeout;
  a failure ending just before the judged range).
- **Fix texts said a call "retried" when it was set not to**, and quoted "0 failed instead of 0".
- **The UI crashed** when the chart's chosen part did not exist in the next system, and dropped
  steps 2–3 on a replay with nothing changed.
- **Maintainability:** about 500 lines of CSS for removed components, dead TypeScript, helpers
  copied in several places, and preset numbers written out by hand next to the code that
  computes them.

---

## Findings

### Engine, analysis, sweep, worker (reviewer 1, fixed in the main session)

| # | Sev | Finding | Status |
|---|---|---|---|
| E1 | M | The cache's hit rate counted retries' lookups, so a retry storm alone halved it and the story said "Cache emptied · 35% hits" while hits per second were unchanged (example, 120 req/s, DB down 30–35 s). The default story told it at 36 s; the cache really runs out at ~60 s. | Fixed: the engine counts hits made for retries (counting only: runs are unchanged); the hit rate is judged on users' own lookups (`ownHitRate`); the signal returns the dip second and the story, timeline and fix explanation read it (one rule, not three copies). The default story's combined "wasted work, cache empty" step moves from 36 s to 60 s. |
| E2 | M | The timeline's "Retries push DB load past its capacity: 2.6×" counted requests a dead database refused at once (it served 3). Review 3 fixed this in the story but not the timeline. | Fixed: seconds the whole part was down are skipped, and only parts that do work (never a cache) are considered, as in the story. |
| E3 | M | With the client's timeout switched off, requests merely in flight at the end of the run counted as failures, so almost every run and map cell read "overloaded". | Fixed: requests that arrived within the longest finished request's time of the end are not judged (a real pile-up, unfinished for longer, still is). |
| E4 | m | A failure ending 0–2 s before the judged range (allowed in a 60 s run) gave no time to judge: "stuck" with 0 failed requests. | Fixed: a run with under 10 s judged after the failure is lengthened, as a late failure already was. Default map: same cells, same time (14.3 s vs 15.3 s). |
| E5 | m | Settling could lengthen a run past the run-size limit it had been checked against (a 30 s run became 75 s). | Fixed: the job passes its limit to settling; a run is never lengthened past it. |
| E6 | m | Progress went backwards (93% → 20%) when a run was lengthened and simulated again. | Fixed: progress holds instead of going back. |
| E7 | m | Headline "1 of 4 App server servers down". | Fixed: "1 of 4 App server copies down"; the story's sentences say "copies" too. |
| E8 | m/n | Duplication and stale comments: `shareWeight` not used by the engine; load per second written out 5 times; the story re-choosing the struggling part the signals already chose; `queuedWaitMs` imported from the timeline by the signals; idle-saturation thresholds in two places without an ASSUMPTION; a JSDoc detached from its function; comments about the old "API", "zipf.ts", "p99 = median", "repeats". | Fixed: one helper each (`loadRps`, `idleSaturated`, `queuedWaitMs` in helpers), the story reads `signals.overloaded`, comments corrected. Validation keeps its own raw share sum on purpose (`shareWeight` would hide an infinite share). |

Checked and correct (reviewer 3 asked): every stuck cell at 200 req/s reports exactly 12,561 failed
requests for 3–12 s failures. Once the storm starts every database call times out whichever the
failure length, so users see identical outcomes; the database's own queue and output do differ.

### Fixes, data, builder (reviewer 2, fixed by an agent)

| # | Sev | Finding | Status |
|---|---|---|---|
| F1 | M | "Twice as many consumers" showed no change in the replay's "Changed by the fix" list. | Fixed: "32 consumers (was 16)". |
| F2 | M | For a call set to 0 retries, "Longer timeout" said it "still gave up and retried" and "causes no retry". | Fixed: "still gave up"; its own description for a call that does not retry. |
| F3 | m | Fix texts put "the" before numbered names ("Only the App server 2 retries the Database 2") and named the target twice for a caller with several calls. | Fixed: "Only App server 2 retries Database 2 (once)"; "Only the App server's calls to DB retry (once)". |
| F4 | m | Two Clients (only from a damaged save) got advice the canvas refuses. | Fixed: one problem, "Keep one and remove the other". |
| F5 | m | A queue limit of 0 ("no queue") was described as "when its short queue is full". | Fixed: "turns away any request it can't start at once". |
| F6 | n | "the part that should handle them" (a word the builder messages avoid); "Each request asks {target} at most twice". | Fixed: "work through them"; "tries … one try and one retry". |
| F7 | m | "0 requests failed instead of 0: no improvement". | Fixed: "Even without it, no request failed and the failure made no difference to users, so there was nothing to improve." |
| F8 | m/n | Never-shown `blurb` field; preset titles and failure-length rows hand-written next to `failure.ts`; part-name, `listed`, `uncap`, ratio helpers copied; fix numbers written in prose with no test tying them to the settings; test-only code exported; the 20 s judging margin defined twice; stale comments. | Fixed: blurb removed; presets built with `failureTitle`/`failureAxis` (a test proves the values are unchanged); one helper each; ASSUMPTION notes and a test tying the fix texts to `FIX_SETTINGS`; one `JUDGE_AFTER_FAILURE_S` in `data/limits.ts`; comments corrected. |

### UI (reviewer 3, fixed by an agent)

| # | Sev | Finding | Status |
|---|---|---|---|
| U1 | **B** | The chart's "Showing:" part survived a switch to a system without that part (e.g. undoing "Use the example system instead", then the tour), and the chart read a part that didn't exist: the page crashed, and the error page's "Start again" deleted the saved built system. | Fixed: a chosen part is used only if this run has it, else the default; the chart code copes with a missing part. Re-run of the reproduction: no crash. |
| U2 | M | "Replay from the start" (or Re-run with nothing changed) counted as new settings: steps 2 and 3 were rebuilt, losing the chosen map cell and fix. | Fixed: with nothing changed only the replay restarts. |
| U3 | M | Re-running from step 2 with another failure kept a map cell that wasn't on the new map ("Not on the map", a 12 s replay on a 1–20 s map). | Fixed: the cell resets to the one nearest your settings when the settings change. |
| U4 | M | "Changed?" was decided by comparing settings as JSON text, so key order mattered: switching the part DB → Cache → DB showed "(edited)" and a fake comparison chip ("slows 8× for 5 s at 30 s → slows 8× for 5 s at 30 s"). | Fixed: one order-insensitive comparison (`sameData`) for every such check; failures are built in the presets' key order. |
| U5 | M | After "Use this topology", a carried-over edited failure kept its old title: renaming DB to "Ledger" still showed "DB slows down". | Fixed: "Ledger slows down". |
| U6 | M | When no fix helped, the first "didn't help" tab looked selected but its panel said "Working out why…" forever. | Fixed: that fix is chosen, so its "why" is worked out and its maps and replay show. |
| U7 | M | Between 1101 and 1200 px an empty 380 px column sat beside step 1's player, and below 1100 px an empty 340 px block under it (left from the removed details panel). | Fixed: the side column is left out while the story sits above the chart. |
| U8 | m | A drawer problem quoted an option that doesn't exist ("one server goes down"); the same failure was a "server" in one place and a "copy" in another. | Fixed: the real option label, and "copy" throughout ("loses one copy"). |
| U9 | n | "Users retried more, adding retries"; step 2 said "Client 5×" beside a banner saying "users' apps 5×". | Fixed: "Users retried more, and more requests failed"; "users' apps 5×". |
| U10 | M | ~650 lines of theme.css (~20%) styled classes no source used (removed timeline, picker, details panel, event track, old fix list…); the story-beside-the-chart layout was defined twice, a later block silently reversing the first. | Fixed: dead rules removed (3,298 → 2,650 lines); one rule set per element. Screenshots before/after pixel-identical at 1440 and 1280 px. |
| U11 | m/n | Dead TypeScript (Timeline, timelineView, presetDraft, graphForCanvas…), comparability decided by splitting the display name on " + ", copied `capitalise`/`listed`, a saved field never read, names and comments describing removed panels ("timeline slot", "Show the details"), stale measurements and examples. | Fixed: removed or renamed (`storyTarget`, `storyEl`…); runs are comparable by scenario, failing part and kind; comments re-measured and corrected. |

---

## After the fixes

- **Tests:** 1,208 pass (103 files), up from 1,189; every accuracy fix has a test that fails without it (`src/analysis/review4.test.ts` and tests beside each change).
- **Speed:** the default tipping map takes the same time (14.3 s here, 15.3 s before: noise).
- **Checked in the browser:** the crash reproduction, step 3 when no fix helps, and all three steps at 1440×900.

### Decided

- **"(edited)" appears only when the system's own settings were changed** (its parts and calls:
  copies, timeouts, retries…), by your decision on 2026-10-26. Choosing another failure, adding
  failures or changing the traffic no longer adds it.
