# Review, round 3: branching (2026-10-25)

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
| A1 | M | The story, chart default, fix targets and "why it didn't help" named the part with the biggest spike *during* the failure (Database 2, 7.7×) while another part stayed overloaded *after* it (Database at ~600 req/s against ~160). Four places used three different rules. | 2, 4 | |
| A2 | M | When an app server failed, an overloaded database beside it was never mentioned (only parts behind the failed server were considered). | 2 | |
| A3 | M | Normal noise on a busy sibling (1.12× with no failure) was told as "overloaded… Repeats land on it too" with 0 repeats, sometimes after "Back to normal", sometimes before any retry existed. | 1, 2, 4 | |
| A4 | M | A dead part's refused retries counted as load it took on (3.56× vs a real 0.85×), hiding a sibling that really was overloaded. | 4 | |
| A5 | M | In a plain chain with a small cache, the story could blame the cache (caches counted as parts doing work). | 4 | |
| A6 | M | Arrows into a shared database credited retries to a server set to 0 retries ("523 rps incl. 308 retries"). | 1, 2 | |
| A7 | M | A caller whose cache absorbed most requests was picked as "the heaviest caller", so timeout/instances/retry fixes changed the wrong call. | 4 | |
| A8 | M | "Across the stack" named the call the fix changed but showed another path's number ("This fix leaves that at 12×"), and multiplied retries in front of a queue into the part behind it (a queue acknowledges on store). | 1, 2, 4 | |
| A9 | M | "Cap retries" could aim at users' apps in front of a queue, who never see the failure. | 2 | |
| A10 | M | "Scale out +50%" added load-balancer instances (7% busy) when the overloaded part was the app server pool behind it. | 1 | |
| A11 | M | The wasted-work signal picked a part doing almost no work (by percentage only); "Drop expired work" then changed nothing. | 2 | |
| A12 | M | The failure picker's "DB1 slows down" could run "DB2 slows down" (the plain id followed whichever database was busiest). | 5 | |
| A13 | M | A "one after another" call could be refused by an idle database (the next call started before the previous part freed its worker); with "Bound the queue" at 0, 27 of 27 requests failed in an idle system. | 4 | |
| A14 | m | A load balancer's own retry went back to the same pool; real load balancers retry another backend. With a pool down, 13% of users got errors. README wrongly said load balancers have no capacity or timeouts. | 1 | |
| A15 | m | The cascade listed a caller that never retried, and sibling servers as if they were stacked layers. | 1, 4 | |
| A16 | m | "Why try it" quoted the wrong part ("Retries made up 65% of Load balancer's load" for a database fix). | 1 | |
| A17 | m | Several app servers sharing a cache: only one cache arrow drawn, and the story named only one server. | 1 | |
| A18 | m | Off-path story lines: a cache dip identical to the no-failure run, and a queue's pile blamed while a database storm kept the run stuck. | 2 | |

### Reliability and data loss

| # | Sev | Finding | Raised by | Status |
|---|---|---|---|---|
| R1 | M | Per-request work was unbounded: a mesh (2,390 events per request) or 1,000,000 retries passed the run-size guard and validation. | 4 | |
| R2 | M | A damaged saved drawing crashed the page on every load, and "Start again" re-read it. | 5 | |
| R3 | M | A kept drawing was lost on the second Cancel. | 3 | |
| R4 | M | Undo after a removal also reverted later edits. | 3 | |
| R5 | m | The builder accepted settings the engine rejects (every run then failed with an id-laden message). | 5 | |
| R6 | n | A malformed `moreDownstream` threw a TypeError instead of "Invalid config"; shares of 1e308 overflowed. | 4 | |

### Editing and layout

| # | Sev | Finding | Raised by | Status |
|---|---|---|---|---|
| E1 | B | Keyboard users could only ever edit the last box: focusing a box selected it, so tabbing to the panel re-selected every box. Arrow settings were unreachable by keyboard. | 3 | |
| E2 | M | Arrows that skip a column on the same row were drawn through the box between (100 of 1,500 random graphs). | 5 | |
| E3 | M | A new load-balancer arrow took ~50% once any share had been edited (50/25/25 → 25/13/13/50). | 1, 3, 5 | |
| E4 | M | Change chips on bent arrows (step 3) squeezed to 3–5 lines and clipped; "timeout 3 s (was 1 s)" hidden at 1280 dark. Badges overlapped the box below. | 2, 3 | |
| E5 | M | At 1280×800 the 5th added part landed off-screen. | 3 | |
| E6 | m | A share shown as "0%" turned its field red and blocked Re-run / Use this topology; 70, 20, 10 typed in turn gave 69/21/10; three even shares showed 33/33/33. | 1, 3, 5 | |
| E7 | m | Parts added with Add sit on one row, so a load balancer's arrows ran through boxes and labels piled up. | 1, 3 | |
| E8 | m | Long names squashed a box's numbers; focus fell to the page after Remove and Undo; ten drawer fields shared one accessible name; the phone's settings panel stayed off-screen. | 3 | |
| E9 | n | Names: typed names lower-cased ("the ledger db", "redis"); numbered copies read badly ("the database 2", "the app server 2 2"); "Lets at most 0 requests wait". | 1, 2, 3 | |

### Maintainability

| # | Sev | Finding | Raised by | Status |
|---|---|---|---|---|
| C1 | m | Path listing capped at 64 paths made the worst-path multiplication partial and the walk exponential; linear passes over the call graph suffice. | 4 | |
| C2 | m | Duplicated helpers (`listed`, `capitalise`, `tierOf`, graph walks, three share-weight functions), `times` meaning two things, dead exports (`callerOf`, `callPolicyInto`, BuilderScreen's `note`), stale comments. | 4, 5 | |
| C3 | m | `useFixRanking` was not keyed by config (an old ranking could show for one render). Plausible, not reproduced. | 5 | |

### Kept as decided

- **Stuck map cells without ✕** (reviewer 5 flagged colour-only): kept, by your decision. Stuck
  cells keep their accessible names; the stale PLAN line was corrected.
- **"Retry at one layer (whole stack)"** (reviewer 5 nit): intended. The fix changes every layer.
