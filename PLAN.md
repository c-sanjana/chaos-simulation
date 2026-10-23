# PLAN.md

Single source of truth for this project. If this file and the conversation disagree, this file wins until we agree to change it.

**Status:** Requirements, risks and V1 scope agreed. Architecture proposed; waiting for decisions. No code yet.

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
| M1 | Simulation engine | Simulates every request individually, using a priority queue of timed events. Random values are derived from stable keys (request, attempt, tier). Runs in Web Workers. Mechanisms: worker pools held while waiting on downstream calls, timeouts, retries with backoff and jitter, bounded or unbounded queues, work continuing on requests the caller already gave up on, cache hit ratio and refill on success, failing fast vs. responding slowly, long-tailed service times |
| M2 | Modelling tests | (a) comparison with queueing theory (M/M/1, M/M/c and Erlang C formulas, Little's law); (b) invariants, such as conservation of requests, pool limits, retry multiplier bounds; (c) known failure patterns: a blip leaves the system stuck with retries and lets it recover without them, a slow DB is worse than a dead one, the cache doesn't recover while the DB is saturated |
| M3 | Preset topology | Client → Gateway → API → Cache → DB, stored as data. Every setting is editable: traffic rate; per tier: instances, workers, queue limit, service time, timeout, retries, backoff, jitter; cache hit ratio |
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

- **Q1.** Where to host, and whether the repo must be public for it. Decide with the stack.
- ~~Q2~~ Decided: one map with a Slow / Dead toggle.
- ~~Q3~~ Decided: parallel calls are built only when a topology needs them (C1).

## 9. Plan: architecture, technical choices and milestones

High-level architecture agreed: static site; UI on the main thread; a pool of Web Workers, each running complete simulation runs; four layers (engine, analysis, data, UI). Details still being settled: UI layout (mockups: https://claude.ai/artifact/6cV8WhmMWanmYvRVQUj1te), sweep and attempt objects, how the cache, DB and load balancer are modelled, the CPU model, and hosting (here.now under evaluation).

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

## 11. Time log

| Session | Duration | What was done |
|---------|----------|---------------|
| 1 | _please fill in_ | Kickoff, requirements, risks, V1 scope (planning) |
