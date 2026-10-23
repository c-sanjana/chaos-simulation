# PLAN.md

Single source of truth for this project. If this file and the conversation disagree, this file wins until we agree to change it.

**Status:** Plan agreed. Implementation in progress (see 9.9).

---

## 1. Requirements

### Hard requirements

| ID | Requirement | Notes |
|----|-------------|-------|
| R1 | Pick exactly one of the five themes | Exploration & Understanding, Creative & Generative Tools, Systems & Reliability, Evaluation & Data Quality, Performance Optimization |
| R2 | A functional prototype | It must actually work, not be a mockup |
| R3 | Self-contained evaluation (marked "critical" in the brief) | The reviewer needs no data, documents or domain expertise of their own. Bundle examples or provide a demo mode |
| R4 | Written rationale, including roughly how long was spent | A README is enough for now |
| R5 | Time box | 2.5–3 hours agreed, against the brief's target of 1–2 hours and hard limit of 8. Scoping is part of the evaluation |

### Strong guidance

| ID | Guidance |
|----|----------|
| R6 | Depth over breadth: something insightful and deep beats feature count |
| R7 | Theme 5 only: judged mainly on measured performance against baselines (does not apply, since we chose Theme 1) |

### Evaluation criteria (agreed stand-in for a rubric)

- **Taste:** deliberate, polished, nothing extra.
- **Handles complexity gracefully:** hard things are made understandable or robust, not hidden.
- **Non-obvious:** solves a real problem in a way a reviewer wouldn't have predicted.

## 2. Confirmed context and assumptions

| # | Item | Status |
|---|------|--------|
| A1 | AI assistance is allowed. The rationale will say plainly how it was used | Confirmed |
| A2 | Time budget is 2.5–3 hours of your wall-clock time, including time working with Claude | Confirmed |
| A3 | Delivered as a **hosted URL** the reviewer opens in a browser, plus the repo with a README | Confirmed |
| A4 | The reviewer needs nothing but a browser: no installs, accounts or API keys | Confirmed |
| A5 | The reviewer may spend only 10–15 minutes, so the first minute has to show the most interesting behaviour | Assumed |
| A6 | The tech stack is up to us | Assumed |
| A7 | Framing: the simulation is for **building intuition** about how systems fail. It does not predict production behaviour | Confirmed |

A hosted URL points towards a client-only static site: no server, no secrets, no running cost. Anything with a backend or LLM calls adds uptime, cost and key-exposure risk.

## 3. Idea: Chaos Simulation Lab (Theme 1)

An interactive simulation for engineers and service owners. It shows how distributed systems fail, how failures spread and recover, and **the tipping point where a system stops recovering on its own** (a metastable failure). Fixes are tried as setting changes and re-run against identical traffic, so you can see whether a fix helps and whether it moves the tipping point.

Core principle: behaviour **emerges from the simulation**. Nothing is hard-coded. Retry storms and cascades come out of the modelled mechanisms, and the model is checked against known results.

## 4. Requirements check

| Req | Verdict | How |
|-----|---------|-----|
| R1 | Met | Theme 1: emergent dynamics, building understanding of failure |
| R2 | Met | A real simulation engine; every result comes from simulated requests |
| R3 | Met | Preset topology and scenarios. The page opens on the retry-storm scenario, so the reviewer needs nothing of their own |
| R4 | Planned | README with rationale, time spent, what is not modelled, how the model is tested |
| R5 | At risk | Scope exceeds 2.5–3 h by my estimate. Mitigated by the build order and cut line below |
| R6 | Met | One topology done in depth before a second is added. The tipping point is the core insight |
| Taste | Planned | One question per screen; secondary detail behind toggles |
| Complexity | Planned | Emergent failures made visible: workers occupied vs. CPU busy, the retry multiplier, a timeline of events |
| Non-obvious | Planned | Same traffic, different history, different outcome (metastability); fixes proven by re-running them, and seeing whether the tipping point moves |

## 5. V1 scope

### Build order and cut line

Built in this order. Whatever is unfinished at the time limit is cut from the bottom up.

1. **M1–M8 for the retry storm** (below)
2. **S1: slow vs. dead database**, plus map-cell drill-down and multi-seed confidence. The last two are nearly free, because runs are deterministic and cheap to re-run
3. **S2: cache failure and stampede**
4. **C1: a second topology** (one service calling several others, with a deeper call stack). Only starts once the base topology works end to end

### Must (M1–M8)

| # | Item | Detail |
|---|------|--------|
| M1 | Simulation engine | Simulates every request individually, using a priority queue of timed events. Random values are derived from stable keys (request, attempt, tier). Runs in Web Workers. Mechanisms: worker pools held while waiting on downstream calls, timeouts, retries with backoff and jitter, bounded or unbounded queues, work continuing on requests the caller already gave up on, cache-aside caching with capacity, LRU eviction, TTL and refill on success (the hit rate is an output), CPU cores as a second limit on each instance, failing fast vs. responding slowly, long-tailed service times |
| M2 | Modelling tests | (a) comparison with queueing theory (M/M/1, M/M/c and Erlang C formulas, Little's law); (b) invariants, such as conservation of requests, pool limits, retry multiplier bounds; (c) known failure patterns: a blip leaves the system stuck with retries and lets it recover without them, a slow DB is worse than a dead one, the cache doesn't recover while the DB is saturated |
| M3 | Preset topology | Client → Gateway → API → DB, with a cache beside the API (cache-aside: the API checks the cache, and on a miss calls the DB itself). Stored as data. Every setting is editable: traffic rate; per tier: instances, workers, cores, queue limit, service time, timeout, retries, backoff, jitter; cache: capacity, TTL, number of distinct keys, popularity skew |
| M4 | Retry-storm scenario | The headline scenario; the page opens on it |
| M5 | Run view | Live topology with per-tier stats. One main chart with tabs for **throughput, latency (p50/p99), error rate, workers occupied, CPU busy**, with the failure window shaded. Clicking a tier switches the charts to it. A short timeline of detected events (one line per event, about 10 or fewer, each with a time and a number) |
| M6 | Fixes and comparison | Candidate fixes are setting changes stored as data. They are **ranked by measured effect**: each candidate is actually run against the same seed. Fixes that can't be applied are not shown. Applying a fix re-simulates it with the full run view, overlaid on the original run |
| M7 | Tipping-point map | A 2D grid where each cell is one simulation run. Axes are fixed per scenario: **traffic × retries** for the retry storm. Shown before and after a fix. Cells fill in as their runs finish |
| M8 | Deploy and README | Static hosted site. The README covers rationale, time spent, how AI was used, what is not modelled, and how the model is tested |

### S1, S2, C1

| # | Item | Detail |
|---|------|--------|
| S1 | Slow vs. dead database | Map axes: **traffic × outage length**. One map with a **Slow / Dead toggle** that redraws it on the same axes |
| — | Map-cell drill-down | Click any cell to re-run its settings and open the full run view. The result is identical, since runs are deterministic |
| — | Multi-seed confidence | Each fix verdict runs on 5 random seeds and is reported as "recovers in N of 5 seeds". This is confidence *within the model*. Each fix also has a one-line caveat behind a toggle |
| S2 | Cache failure and stampede | Map axes: **traffic × outage length** |
| C1 | Second topology | One service calls several others in parallel, with a deeper call stack (for example payments, inventory and orders) |

### Definitions

- **Recovered** (option C): run the identical traffic with no failure, as a control. The system has recovered at the moment after which **every request gets exactly the same outcome and latency as in the control run**. If that never happens within the observation window, the run is **stuck**. Recovery time and the number of requests affected come out of the same comparison.
  - **Fallback** (option B), used only if leftover state such as which keys are cached prevents exact matching: success rate, p99 latency and queue depth all return within the healthy period's own natural range, and stay there. If we switch to it, the README says why.
- **Goal:** show that a fix brings the system back to its original shape, not merely closer to it.

### Design principles

- **The engine is a stable core.** A new scenario or topology that reuses existing mechanisms is data only. A new mechanism is an engine change, and it comes with tests.
- **Topologies, scenarios (timed schedules of failures), fixes (setting changes) and map definitions are all data.**
- **Readable first:** one question per screen, in order (what happened → why → where is the tipping point → does the fix help). Advanced settings, extra charts and long text are collapsed or behind toggles.
- **The same traffic for every comparison.** Random values come from stable keys, and a test enforces it.

## 6. Revisit after V1 (deferred, not dropped)

| Item | Why deferred | Revisit question |
|------|--------------|------------------|
| Deeper trace-back (click a failure, walk back through its causes) | The UI could get cluttered without adding much value | Does the V1 timeline already explain enough? |
| Drag-and-drop canvas builder for your own topology | High cost; presets plus editable settings cover V1 | Is it worth it once presets and the data format are proven? |
| Building a topology from a flowchart or diagram | Depends on the data format and probably on the builder | After the builder decision |
| Multi-region setups | Big modelling effort; not needed for the core insight | — |
| LLM explanations and follow-up questions, grounded in run results | Needs a backend and keys, which conflicts with a static site | The event log is kept structured with IDs and numbers so it can be added later |
| Search for the smallest change that keeps the system healthy | It is a search loop over fix changes; easy once V1 exists | — |
| Real defaults from RDS, Aurora, DynamoDB and other AWS services | Risk of implying more accuracy than the model has | Can they be offered as presets with clear caveats? |
| More scenarios: a queue that never catches up, garbage-collection pauses, slow networks, AI-agent traffic, retries without jitter, connection pool exhaustion | Scope (originally C3 and beyond) | — |
| Retry tree for one sampled request ("1 click → 64 DB queries") | Not in the agreed build order | Would it add clarity without clutter? |
| Model-validation view in the UI (simulation vs. formulas) | Not in the agreed build order; the tests already cover it | — |

### Decided against (for now)

- **User-selectable map axes.** Each scenario has the right axes fixed in its data.
- **A "what this model leaves out" panel in the UI.** The README covers it.

### Not modelled in V1 (goes in the README)

Garbage-collection pauses; CPU contention slowing a server as it gets busier; network delay and packet loss; autoscaling; load-balancer algorithms; connection setup costs; users giving up or refreshing.

## 7. Risks (all agreed)

| # | Risk | Mitigation | Status |
|---|------|------------|--------|
| 1 | Running out of time | Scope in tiers, with the build order and cut line in section 5 | Agreed |
| 2 | Simulated behaviour doesn't match real systems | Presets ship sensible, fully editable settings; nothing is auto-picked or auto-tuned. Model correctness is enforced by tests at three levels (M2) | Agreed |
| 3 | Overclaiming accuracy | Framed as building intuition, not prediction. The README lists what is not modelled | Agreed |
| 4 | Sweeps too slow | Web Workers running in parallel. Estimate: a 60-cell map in about 5–10 s; benchmark in M1. Cells fill in as they finish | Agreed |
| 5 | Fix suggestions look scripted | Every fix is a real setting change that gets re-run; ranked by measured effect; fixes that can't be applied are not shown | Agreed |
| 6 | Too much on screen | One question per screen; the rest behind toggles | Agreed |
| 7 | Trace-back balloons | V1 has a short timeline only; deeper trace-back is revisited after V1 | Agreed |
| 8 | Hosted URL fails | You will test it repeatedly; low concern | Agreed (low) |
| 9 | Before/after runs not comparable | Random values from stable keys; a test checks both runs see identical traffic | Agreed |

## 8. Open questions

- ~~Q5~~ Decided 2026-10-23: option B, a deadline-aware handler (see the decision log). Was: "Drop expired requests" checks the deadline when a queued request gets a worker. With 64 DB connections on 4 cores, admitted requests then wait for a core and expire there, so the fix doesn't help in the default scenario. Option: also re-check the deadline when compute starts (a deadline-aware handler), or leave it and keep the README note.
- **Q6.** The permanent URL (claimed site) can only be updated with the owner's here.now API key, which this environment doesn't have.
- ~~Q4~~ Decided at the P3 review: map axis B.
- **Q4 (raised at the P3 review).** On the retry-storm map, rows for 1–5 retries per layer look identical. This is real behaviour, not a bug: retries at three layers multiply ((r+1)³ calls to the DB, so even 1 retry is 8×), and a 5 s blip can only tip the system if it overloads the DB during the blip (above ~80 requests/s), whatever the retry count. Options to make the map more informative are listed in the review message.

- ~~Q1~~ Decided: here.now with a free account (see 9.8).
- ~~Q2~~ Decided: one map with a Slow / Dead toggle.
- ~~Q3~~ Decided: parallel calls are built only when a topology needs them (C1).

## 9. Plan: architecture, technical choices and milestones

Mockups (agreed): https://claude.ai/artifact/6cV8WhmMWanmYvRVQUj1te

### 9.1 Overall shape

A static site; everything runs in the browser.
- **UI** runs on the main thread.
- A **pool of Web Workers** (one per spare core, at most 8): each worker runs whole simulation runs, one at a time. A worker is a browser thread, **not** a node in the simulated system.

| Layer | Folder | Job | Changes when… |
|---|---|---|---|
| Engine | `src/engine/` | Simulates requests: settings in, metrics and per-request outcomes out. Pure code, no DOM | A new *mechanism* is needed (rare, comes with tests) |
| Analysis | `src/analysis/` | Recovery vs. the control run, the timeline, fix diagnosis. Pure | A new kind of insight |
| Sweep | `src/sweep/` | Sweep specs, results and tipping-point extraction (pure); the runner that fans out to workers | — |
| Data | `src/data/` | Topologies, scenarios, fixes as plain objects | A new scenario, topology or fix |
| Worker | `src/worker/` | Worker entry point and pool | — |
| UI | `src/ui/` | React components | Presentation |

### 9.2 Stack

TypeScript, Vite, React. Vitest for tests. uPlot for time-series charts. The map and topology are plain React and SVG components.

### 9.3 Modelling principles

- **Objects with encapsulated state and behaviour model the things that exist in a simulated system:** `Simulation`, `Tier`, `Instance`, `LoadBalancer`, `Cache`, `Database`, `Client`, `Attempt`, `MetricsRecorder`, and on the sweep side `SweepSpec`, `SweepRunner`, `SweepResult`, `TippingPoint`.
- **Composition over inheritance.** Components share small interfaces (for example "accepts an attempt"). No deep class hierarchies.
- **Settings and results stay plain data.** Topologies, scenarios, fixes, `RunConfig` and `RunResult` are plain objects, because they cross the worker boundary (which strips class methods) and because data-driven scenarios are an agreed principle. Objects are built from data inside the worker.

### 9.4 Engine

- **Event loop:** a time-ordered priority queue, with ties broken by a sequence number so results are bit-for-bit repeatable.
- **Traffic:** open loop. New requests arrive at the set rate whatever the system's state.
- **`Attempt`:** one call to one tier. It holds the request ID, the attempt path (which retry at each layer), the tier and the caller's deadline. Its states:
  - queued → running → waiting on downstream → done or failed
  - **abandoned:** the caller gave up. The tier keeps working on it unless "drop expired" is on, and time spent on abandoned attempts is recorded as **wasted work**.
  - **dropped** (with "drop expired"): the caller's deadline had passed when the attempt got a worker, or when it got a CPU core (a deadline-aware handler checks when it starts computing). A dropped attempt is never computed, so it wastes nothing.
- **`Instance`:** its own FIFO queue (bounded or unbounded), a pool of workers, and **CPU cores (option B)**. A worker must hold a core to compute and queues for one otherwise. A worker is held, without a core, while it waits on a downstream call. CPU busy = busy cores ÷ cores.
- **`Tier`:** a set of instances plus its settings: service-time distribution (long-tailed), timeout, retries, backoff, jitter, optional retry budget, and drop-expired.
- **`LoadBalancer`:** a routing policy on each connection between tiers that picks an instance; round-robin in V1. An explicit load-balancer tier with its own capacity is deferred.
- **`Cache` (cache-aside):**
  - Holds real keys, up to a capacity, with LRU eviction and a TTL per entry. Requests ask for keys drawn from a popularity curve (Zipf).
  - A hit means the key is present and not expired. On a miss **the API calls the DB**, and the key is stored only if that read succeeds.
  - Runs start warm (pre-filled with the cache's normal contents). Failure modes: down, and flush (a cold restart).
  - Optional: concurrent misses on the same key share one DB read.
  - **The hit rate is an output, not a setting.**
- **`Database`:** instances, a connection limit (its workers), long-tailed service times. Failure modes: slow (service time × N) and dead (refuses immediately). Reads only in V1.
- **Same random numbers before and after:** every random value is a hash of (seed, stream, request ID, attempt path, tier), never drawn in sequence.
- **Output (`RunResult`):** per-second metrics for each tier, and per-request outcomes at the client. Per-tier metrics:
  - requests in, successes, errors
  - latency p50 and p99 (fixed-size histogram)
  - queue depth, workers occupied, CPU busy
  - wasted work, retry multiplier, cache hit rate.

### 9.5 Analysis

- **Recovery (option B, using the control as the reference; option C was measured and rejected, see decision log):** the control is the same config and seed with no failures. A second is healthy when (1) every request arriving in it succeeded exactly when it succeeded in the control, (2) end-to-end p99 is no higher than the control's highest per-second p99, and (3) every tier's queue is no higher than its highest per-second queue in the control. The run recovered at the start of the first second from which every later judged second is healthy; otherwise it is stuck. If the control itself fails requests, the verdict is "overloaded". The judged range ends where the client's longest possible request (all tries and backoffs) would still be unfinished.
- **Timeline:** rule functions over the metrics. At most about 10 one-line entries, each with a time and a number.
- **Fixes:** a fix is a candidate when the signal it targets showed up in the run. Every candidate is re-run with the same seed and ranked by: recovered, then recovery time, then requests affected. The top fixes get the 5-seed confidence check. Fixes tested that did not help are listed too, collapsed.

### 9.6 Sweep

- **`SweepSpec`:** base config, axes from the scenario's data, and seeds.
- **`SweepRunner`:** sends cells to the worker pool and reports progress as they finish. Changing settings cancels stale jobs.
- **`SweepResult`:** the grid of `SweepCell`s.
- **`TippingPoint`:** per row, the value where results flip from recovered to stuck. Rows that flip more than once are flagged.
- **Drill-down:** re-runs a cell's settings, giving an identical result, and replays it inline.

### 9.7 UI

Follows the mockups:
- A scenario picker and an editable failure sentence at the top, then three tabbed steps.
- One reusable `RunPlayer`: topology with arrows, playback, chart tabs (Throughput, Load & retries, Latency, Errors, Workers & CPU) and the timeline.
- `RunPlayer` is used in step 1, inline under the map in step 2, and in compare mode in step 3. A settings drawer opens from the header.

### 9.8 Hosting

**here.now, with a free account**, so sites are permanent; the 24-hour expiry applies only to anonymous sites. Deployed through its publish API. P0 checks that `.js` files and module workers are served correctly; the fallback is Vercel.

### 9.9 Milestones (agreed)

Review stops: after **P0**, **P3** and **P7**. Every other milestone still reports its check results.

| # | Milestone | Check before moving on |
|---|---|---|
| P0 ✅ | Skeleton and deploy smoke test | Hosted page loads in a clean browser; the module worker responds. **Passed 2026-10-23:** headless Chromium shows "Worker OK" with no console errors; the worker is served as `text/javascript`; 5 tests, 100% coverage |
| P1 ✅ | Engine core | Matches queueing theory (M/M/1, M/M/c, Erlang C) within tolerance; Little's law holds; invariants hold; deterministic; arrivals identical across settings; events/s benchmark |
| P2 ✅ | Cache, DB, failures, retry-storm preset | Retry storm stuck with 3 retries, recovers with 0; cache hit rate matches the analytic model of an LRU cache with Zipf-distributed keys |
| P3 ✅ | Analysis | A run with no failure matches the control; recovered and stuck runs classified correctly; timeline numbers present in the metrics. Decide whether option C holds or we fall back to B |
| P4 ✅ | Run player and page | Visual check against the mockups; page stays responsive |
| P5 ✅ | Sweep and map | Tipping-point tests; replaying a cell gives the cell's exact result; measured map time |
| P6 ✅ | Fixes | Identical arrivals before and after a fix; ranking order; visual check |
| P7 ✅ | README and final deploy | Full walkthrough on the hosted URL in a clean browser |
| S1, S2, C1 | Per the build order | Known-pattern tests for each |

### 9.10 Quality bar

- **Correctness and testing first.** Simple, readable code; nothing speculative.
- **Document** the code where it isn't obvious, and every modelling **assumption** (marked `ASSUMPTION:` in comments, and collected in the README).
- **Coverage over 90%** for engine, analysis, sweep and UI, enforced by Vitest thresholds.
- **Accuracy tests:** engine and analysis results are checked against analytic models of real systems: M/M/1, M/M/c (Erlang C), M/G/1 (Pollaczek–Khinchine), Little's law, the LRU hit rate under Zipf-distributed keys (Che approximation), and the retry amplification bound.

## 10. Decision log

| Date | Decision | Why |
|------|----------|-----|
| 2026-10-21 | Working agreement: options and tradeoffs first, you decide, no code before the plan is agreed | Set in the kickoff message |
| 2026-10-21 | Time budget 2.5–3 h | Leaves room for depth while staying well inside the 8 h limit |
| 2026-10-21 | Deliver as a hosted URL plus the repo and README | Keeps reviewer effort as low as possible (R3) |
| 2026-10-21 | Framing: builds intuition, does not predict production | Avoids overclaiming |
| 2026-10-21 | Simulation runs in Web Workers | Keeps the page responsive; sweeps can be cancelled and can run in parallel |
| 2026-10-21 | Rank fixes by measured effect | Fixes are verified, not generic |
| 2026-10-21 | Random values derived from stable keys (request, attempt, tier) | Before and after see identical traffic and identical random values |
| 2026-10-22 | Theme 1; one topology in depth first; C1 only after it works end to end | Depth over breadth (R6) |
| 2026-10-22 | Topologies, scenarios and fixes are data; the engine is a stable core | Scale across scenarios without touching the engine |
| 2026-10-22 | Map axes fixed per scenario: traffic × retries (retry storm), traffic × outage length (database, cache) | Each scenario gets the axes that answer its question; simpler UI |
| 2026-10-22 | Recovery = exact match with a no-failure control run (option C); natural-range fallback (option B) | Shows the fix restores the original shape; no arbitrary threshold |
| 2026-10-22 | Run view shows throughput, latency, errors, workers occupied and CPU busy | Workers occupied vs. CPU busy shows threads exhausted while CPU looks idle |
| 2026-10-22 | Build order: retry storm (M1–M8) → S1 with drill-down and confidence → S2 → C1 | Cut from the bottom if out of time |
| 2026-10-22 | Deeper trace-back and the drag-and-drop builder are revisited after V1 | Avoid UI clutter; see V1 first |
| 2026-10-22 | S1 uses one map with a Slow / Dead toggle | One map keeps it simple; the toggle shows slow has the bigger stuck region |
| 2026-10-22 | Parallel calls built only when a topology needs them | Don't build ahead of need; C1 will be the engine change that adds them |
| 2026-10-23 | Stack: TypeScript + Vite + React; Vitest for tests | Widely known, mature, native worker support, static build |
| 2026-10-23 | One queue per instance, with a load balancer choosing the instance | Enables instance-level faults and load-balancer behaviour |
| 2026-10-23 | Open-loop traffic | Real traffic doesn't slow down when the system does; this is required for stuck states to emerge |
| 2026-10-23 | Compute the run, then replay it in the UI | Deterministic and simple; no benefit to real-time simulation |
| 2026-10-23 | UI: three tabbed steps (option B) with a prominent scenario picker and an editable failure above them | User preference; choosing the failure is the first action |
| 2026-10-23 | Every "watch a run" replays inline in the current step, using one reusable run player | No navigating between steps to see a run |
| 2026-10-23 | Topology shows arrows labelled with requests/s (thickness = load), with instances drawn inside each tier | Makes the flow, and where retries pile up, followable |
| 2026-10-23 | Throughput and load are separate charts: "Throughput" (sent vs succeeded, end to end) and "Load & retries" (first attempts vs retries vs capacity, per tier) | Different scopes and scales; mixing them hid the success line |
| 2026-10-23 | Mockups approved | — |
| 2026-10-23 | Cache hit rate is an output of capacity, TTL, key count and popularity skew | Needed for a cold cache and the stampede to emerge |
| 2026-10-23 | Load balancer modelled as a routing policy (round-robin); an explicit load-balancer tier is deferred | Simplest model that supports instance-level faults |
| 2026-10-23 | CPU option B: cores are a second limit on each instance | CPU% becomes a real measurement; adding threads stops looking like a free fix |
| 2026-10-23 | Encapsulate simulated things and sweeps as objects; settings and results stay plain data | Good abstractions, easy to extend; data crosses the worker boundary |
| 2026-10-23 | Cache-aside for V1 | Most common pattern; clearest stampede |
| 2026-10-23 | Hosting on here.now with a free account | Permanent with an account; the user's choice |
| 2026-10-23 | Milestones P0–P7 approved; review stops after P0, P3 and P7 | — |
| 2026-10-23 | Quality bar: correctness first, simple code, documented assumptions, over 90% coverage, accuracy tests against analytic models | User requirement |
| 2026-10-23 | Sub-agents build independent modules in parallel (analytic models, utilities, presentational UI); the main session integrates and commits | User suggestion, to speed up implementation |
| 2026-10-23 | Recovery uses option B with the control run as the reference (no tunable tolerance), replacing exact per-request matching (option C) | Measured: after recovery the cache holds slightly different keys until TTL churn evens them out, so a few requests harmlessly miss where the control hit; exact matching labelled clearly recovered runs as stuck (stray mismatches until second 116 of 120) |
| 2026-10-23 | Map axis B: the retry-storm map varies API → DB retries only; other calls do not retry | Retries at every layer multiply ((r+1)³), so every retry count tipped at the same traffic; one varied call gives a staircase (1 retry tips at 220 rps, 2 at 140, 3+ at 120) |
| 2026-10-23 | Continue past the 3-hour budget to finish P4–P7 | User decision at the P3 review |
| 2026-10-23 | UX round 1: timeline plays along with the replay; clicking a topology box edits that tier, "Edit all settings" sits by the topology (header button removed); chart scope via a "Showing" dropdown; map cells darker, smaller, no text, with a full legend | User feedback after the P7 review |
| 2026-10-23 | Histogram quantiles interpolate within a bin | Rounding to the bin centre put p99 up to ~11% off; now under 2% on known distributions |
| 2026-10-23 | Q5 option B: "drop expired" also re-checks the caller's deadline when an attempt gets a CPU core (a deadline-aware handler), as well as when it gets a worker | Real handlers typically check the deadline when they start, and with more workers than cores "start" means "gets a core". Measured on the stuck retry storm: the fix went from helping on 0 of 5 seeds to 5 of 5 (recovers 7 s after the failure ends at seed 42, 440 failed vs. 12,687) |

## 11. Time log

| Session | Duration | What was done |
|---------|----------|---------------|
| 1 | _please fill in_ | Kickoff, requirements, risks, V1 scope (planning) |
| 2 | ~15 min | P0: skeleton, tests and coverage gate, here.now deploy script, hosted worker smoke test passed |
| 8 | ~50 min | UX round 1: live timeline that plays along and restarts per run, slowdown units, settings opened from topology boxes plus "Edit all settings", scope dropdown, darker compact text-free map with legend; Q5 option B (sub-agent); side-by-side layout mockups (canvas) |
| 7 | ~40 min | P6 + P7: fix mechanisms and catalogue (sub-agent), fix step with seed checks and before/after maps, README with measured accuracy table, browser walkthrough of all three steps |
| 6 | ~45 min | P4 + P5: map axis B; view-model layer, RunPlayer, app shell (scenario picker, failure editor, step tabs, settings drawer), tipping-point step with inline replay; worker pool and sweep (sub-agent, 57 tests). Checked in Chromium at 1280 px and 375 px: first run immediate, 60-cell map in 3.8 s, no horizontal overflow |
| 5 | ~30 min | P3: recovery assessment, timeline rules, diagnosis signals, analysis tests (18, 100% lines). Measured option C and switched to the fallback |
| 4 | ~25 min | P2: cache-aside, cache tiers (LRU + TTL, Zipf keys, warm start), slow/dead/per-instance faults, cache flush; web-chain topology and retry-storm preset as data. Stuck state emerges untuned: stuck with retries, recovers with 0. Hit rate matches Che within 1 point |
| 3 | ~40 min | P1: engine core (two sub-agents built the analytic models and the utilities in parallel). 179 tests; matches M/M/1, M/M/c, M/G/1, M/D/1, E3/M/1 within 2–5%; Little's law within 2%; benchmark 1.4–2.1M events/s |
