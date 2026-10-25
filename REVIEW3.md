# Review, round 3: branching (2026-10-25)

**Status: all findings fixed** (1,182 tests; preset simulations byte-identical to before).

After branching shipped (load balancers over several parts, servers calling several parts one
after another or all at once, shared parts), five reviewers went over commit a24f40a:
1. **Load balancers and splits** (browser + engine checks)
2. **Servers calling several parts, shared parts** (browser + engine checks)
3. **Editing, layout and accessibility** (browser, 1440/1280/390, light and dark, keyboard)
4. **Code review: engine, analysis, fixes** (correctness, readability, maintainability, reliability,
   failure handling)
5. **Code review: builder, UI, worker** (same criteria)

Every finding below was reproduced at least twice by the reviewer, with a script, numbers or a
screenshot (session scratchpad, `review3/`). **Raised by** counts reviewers who found the same
problem independently. The fixes were made in two batches (engine/analysis/fixes, and
builder/UI); the **Status** column says what was done.

## Verdict

**The simulation is right; what the app says about branched systems often wasn't.**

What holds:
- Chains, including the three built-in failures, simulate byte-identically to before branching,
  and their stories, timelines and fixes are unchanged.
- Branched runs are deterministic, and match queueing theory: a split over two pools behaves like
  two independent queues, "all at once" takes about as long as the slower call (81 ms) and "one
  after another" about the sum (107 ms).
- Arrow numbers follow the shares and add up at splits and shared parts.
- Every validation message names the parts and gives a fix on the canvas; saves from before
  branching load.

What didn't:
- **The story, the chart and the fixes could name the wrong part.** The "struggling part" was
  chosen by different rules in different places, from peaks during the failure rather than load
  after it, ignoring parts that weren't behind the failed one, and counting normal noise as
  overload.
- **Shared parts were mis-credited.** Retries into a shared database were split by what each
  caller received, not what it sent; fixes could target the caller whose cache absorbed its load.
- **Unbounded work.** A mesh-shaped system or a huge retry count could hang the tab.
- **Builder editing had a keyboard blocker and two data-loss bugs.**

---

## Findings

Severity: **B** blocker, **M** major, **m** minor, **n** nit.

### Accuracy: the app says something false

| # | Sev | Finding | Raised by | Status |
|---|---|---|---|---|
| A1 | M | The story, chart default, fix targets and "why it didn't help" named the part with the biggest spike *during* the failure (Database 2, 7.7×) while another part stayed overloaded *after* it (Database at ~600 req/s against ~160). Four places used three different rules. | 2, 4 | Fixed: one rule (`strugglingPart`) for story, chart, fix targets and explanations: the part most over capacity after the failure ends, else its peak during it. |
| A2 | M | When an app server failed, an overloaded database beside it was never mentioned (only parts behind the failed server were considered). | 2 | Fixed: every part that does work is considered, not only those behind the failed one. |
| A3 | M | Normal noise on a busy sibling (1.12× with no failure) was told as "overloaded… Repeats land on it too" with 0 repeats, sometimes after "Back to normal", sometimes before any retry existed. | 1, 2, 4 | Fixed: a sibling counts only in seconds repeats pushed it over; "Repeats land on it too" only then; nothing told after "Back to normal". |
| A4 | M | A dead part's refused retries counted as load it took on (3.56× vs a real 0.85×), hiding a sibling that really was overloaded. | 4 | Fixed: seconds a part was entirely down are left out of its peak. |
| A5 | M | In a plain chain with a small cache, the story could blame the cache (caches counted as parts doing work). | 4 | Fixed: `doesWork(tier)` excludes caches; chain-with-small-cache story test. |
| A6 | M | Arrows into a shared database credited retries to a server set to 0 retries ("523 rps incl. 308 retries"). | 1, 2 | Fixed: the engine counts first tries and retries per call; arrows use them (a 0-retry server shows "no retries"). |
| A7 | M | A caller whose cache absorbed most requests was picked as "the heaviest caller", so timeout/instances/retry fixes changed the wrong call. | 4 | Fixed: exact per-call counts pick the heaviest caller. |
| A8 | M | "Across the stack" named the call the fix changed but showed another path's number ("This fix leaves that at 12×"), and multiplied retries in front of a queue into the part behind it (a queue acknowledges on store). | 1, 2, 4 | Fixed: names the layers when the worst path changes, says what a one-layer fix does on its own path; multiplication restarts at a queue. |
| A9 | M | "Cap retries" could aim at users' apps in front of a queue, who never see the failure. | 2 | Fixed: retry fixes stop at a queue's consumers. |
| A10 | M | "Scale out +50%" added load-balancer instances (7% busy) when the overloaded part was the app server pool behind it. | 1 | Fixed: scales the overloaded pool when its caller is a load balancer or barely busy. |
| A11 | M | The wasted-work signal picked a part doing almost no work (by percentage only); "Drop expired work" then changed nothing. | 2 | Fixed: picks the part that wasted the most compute. |
| A12 | M | The failure picker's "DB1 slows down" could run "DB2 slows down" (the plain id followed whichever database was busiest). | 5 | Fixed: one scenario id per part (`custom-db-slow:<id>`); old ids still restore. |
| A13 | M | A "one after another" call could be refused by an idle database (the next call started before the previous part freed its worker); with "Bound the queue" at 0, 27 of 27 requests failed in an idle system. | 4 | Fixed: the next call of a sequence starts as a new event; diamond test with a queue limit of 0. Chains byte-identical. |
| A14 | m | A load balancer's own retry went back to the same pool; real load balancers retry another backend. With a pool down, 13% of users got errors. README wrongly said load balancers have no capacity or timeouts. | 1 | Fixed: a load balancer's retry goes to another pool (0 failed with one pool down); README corrected, no health checks listed. |
| A15 | m | The cascade listed a caller that never retried, and sibling servers as if they were stacked layers. | 1, 4 | Fixed: each caller's own retries; pools behind a split grouped as alternatives. |
| A16 | m | "Why try it" quoted the wrong part ("Retries made up 65% of Load balancer's load" for a database fix). | 1 | Fixed: quotes the part the fix is aimed at. |
| A17 | m | Several app servers sharing a cache: only one cache arrow drawn, and the story named only one server. | 1 | Fixed: the cache box shows lookups from all its servers; the story names every server. |
| A18 | m | Off-path story lines: a cache dip identical to the no-failure run, and a queue's pile blamed while a database storm kept the run stuck. | 2 | Fixed: noise-level cache dips are not told; "pile of messages" only when the queue is still backed up. |

### Reliability and data loss

| # | Sev | Finding | Raised by | Status |
|---|---|---|---|---|
| R1 | M | Per-request work was unbounded: a mesh (2,390 events per request) or 1,000,000 retries passed the run-size guard and validation. | 4 | Fixed: retries capped at 10 (engine `MAX_RETRIES`, shared with the forms); the run-size guard counts calls per request (presets unaffected). |
| R2 | M | A damaged saved drawing crashed the page on every load, and "Start again" re-read it. | 5 | Fixed: saves are checked field by field, bad parts dropped with a notice; "Start again" clears the save. |
| R3 | M | A kept drawing was lost on the second Cancel. | 3 | Fixed. |
| R4 | M | Undo after a removal also reverted later edits. | 3 | Fixed: any panel edit ends the Undo of an earlier removal. |
| R5 | m | The builder accepted settings the engine rejects (every run then failed with an id-laden message). | 5 | Fixed: the builder checks call, cache and queue settings with the engine's limits. |
| R6 | n | A malformed `moreDownstream` threw a TypeError instead of "Invalid config"; shares of 1e308 overflowed. | 4 | Fixed: "Invalid config" messages. |

### Editing and layout

| # | Sev | Finding | Raised by | Status |
|---|---|---|---|---|
| E1 | B | Keyboard users could only ever edit the last box: focusing a box selected it, so tabbing to the panel re-selected every box. Arrow settings were unreachable by keyboard. | 3 | Fixed: focus no longer selects; Enter/Space opens a box's or arrow's settings and moves focus there; Delete acts on the focused item. |
| E2 | M | Arrows that skip a column on the same row were drawn through the box between (100 of 1,500 random graphs). | 5 | Fixed: layout and routing keep lines out of occupied cells; the 1,500-graph fuzz is a regression test. |
| E3 | M | A new load-balancer arrow took ~50% once any share had been edited (50/25/25 → 25/13/13/50). | 1, 3, 5 | Fixed: a new arrow gets an even share, the others scale down. |
| E4 | M | Change chips on bent arrows (step 3) squeezed to 3–5 lines and clipped; "timeout 3 s (was 1 s)" hidden at 1280 dark. Badges overlapped the box below. | 2, 3 | Fixed: chips show words when they fit, else 🔧, with every change listed under the diagram; badges have room between stacked boxes. |
| E5 | M | At 1280×800 the 5th added part landed off-screen. | 3 | Fixed: new parts scroll into view, with a "Scroll sideways" hint. |
| E6 | m | A share shown as "0%" turned its field red and blocked Re-run / Use this topology; 70, 20, 10 typed in turn gave 69/21/10; three even shares showed 33/33/33. | 1, 3, 5 | Fixed: "<1%" labels, shares to one decimal, whole percents add to 100; shares typed in one round keep their values (70, 20, 10 → 70/20/10). |
| E7 | m | Parts added with Add sit on one row, so a load balancer's arrows ran through boxes and labels piled up. | 1, 3 | Fixed: Add fans parts out; builder arrows bend around boxes, labels avoid each other. |
| E8 | m | Long names squashed a box's numbers; focus fell to the page after Remove and Undo; ten drawer fields shared one accessible name; the phone's settings panel stayed off-screen. | 3 | Fixed. |
| E9 | n | Names: typed names lower-cased ("the ledger db", "redis"); numbered copies read badly ("the database 2", "the app server 2 2"); "Lets at most 0 requests wait". | 1, 2, 3 | Fixed: built-in kind names become nouns; typed and numbered names keep their spelling; "no queue" for a limit of 0. |

### Maintainability

| # | Sev | Finding | Raised by | Status |
|---|---|---|---|---|
| C1 | m | Path listing capped at 64 paths made the worst-path multiplication partial and the walk exponential; linear passes over the call graph suffice. | 4 | Fixed: single passes over the call graph; `pathsTo` removed. |
| C2 | m | Duplicated helpers (`listed`, `capitalise`, `tierOf`, graph walks, three share-weight functions), `times` meaning two things, dead exports (`callerOf`, `callPolicyInto`, BuilderScreen's `note`), stale comments. | 4, 5 | Fixed: shared helpers, one share-weight function, dead code removed, comments corrected. |
| C3 | m | `useFixRanking` was not keyed by config (an old ranking could show for one render). Plausible, not reproduced. | 5 | Fixed: keyed by config; late results of a cancelled ranking dropped. |

### Left as is

- Step 2 of the nine-part branched system is ~24 px taller than a 1440×900 screen (the story
  panel sets that row); the 10-part system scrolled before too.
- A cache-aside lookup still calls the part behind the cache inside the cache's response
  (deferring it would change every preset's event order; no wrong result was found from it).
- Very large fan-out systems may have some tipping-map cells refused, with a plain-language
  message, by the new run-size guard.

### Kept as decided

- **Stuck map cells without ✕** (reviewer 5 flagged colour-only): kept, by your decision. Stuck
  cells keep their accessible names; the stale PLAN line was corrected.
- **"Retry at one layer (whole stack)"** (reviewer 5 nit): intended. The fix changes every layer.
