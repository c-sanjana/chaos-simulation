# Chaos Simulation Lab

**Live demo:** https://ivory-tassel-sxy5.here.now/ (runs entirely in your browser; nothing to install)

An interactive simulation of how distributed systems fail, how failures spread, and **the tipping
point where a system stops recovering on its own**. You can then try a fix and see, on identical
traffic, whether it actually helps and whether it moves the tipping point.

> Built for intuition, not prediction. The mechanisms are real and tested against queueing theory;
> the numbers are illustrative. See [What is modelled](#what-is-modelled-and-what-isnt).

## The first minute

The page opens on a **retry storm**. A database slows down 8× for just 5 seconds, at a traffic
level it normally handles easily. On a first visit a 30-second guided tour points out each part
of the page (skip it, or replay it any time with **?** at the top right; ☾ beside it switches to
dark mode, and the page stays light unless you choose dark).

1. **What happened.** The system never recovers, even though the failure is over. The timeline
   explains why, with numbers from the run:
   - DB p99 exceeds the API's 1 s timeout.
   - The API retries, and retries push DB load to almost 5× its capacity.
   - The tipping point: the failure is over, but retries keep DB load at 3.7× capacity, so the
     backlog can never drain.
   - 98% of DB work is spent on requests users already gave up on.
   - API workers are 99% occupied while CPU sits at 6%.
2. **Where's the tipping point?** The same 5-second failure, re-run at 60 combinations of traffic
   and API → DB retries. Each cell is a full simulation, and you can click one to replay it inline.
   With 0 retries the system always recovers. With 1 retry it tips at 220 req/s, with 2 at 140,
   and with 3 or more at 120.
3. **Does a fix help?** Candidate fixes are chosen from what the run showed. Each one is a single
   setting change, re-run against the same traffic and the same failure, ranked by what actually
   happened, and re-checked on 5 random seeds. Each fix says in plain words what it changes, why it
   was suggested, what happened, and its pros and cons (including cost, and drawbacks measured in
   the run itself). Apply one to see before and after side by side and whether the tipping point
   moved; click any cell of either map to replay that cell before and after.

## Why this is interesting

Blog posts say "cap your retries", but not *at what point that starts to matter for your
system*. The behaviour shown here is a **metastable failure** (Bronson et al., HotOS 2021;
Huang et al., OSDI 2022): at the same traffic, the system has two stable states, healthy and
stuck, and a short trigger can flip it from one to the other permanently.

**Nothing in this tool is scripted.** The retry storm, the stuck state, the cache stampede and
the "workers busy, CPU idle" signature all emerge from a small set of modelled mechanisms:
- callers time out, but the server keeps working on abandoned requests;
- retries add load while the system is overloaded;
- worker pools are held while waiting on downstream calls;
- the cache refills only on successful reads.

## How it works

```
Browser (static site, no backend)
├─ UI (React): scenario, three steps, settings drawer
└─ Web Worker pool (one per spare core, max 8): each worker runs whole simulations
   ├─ engine/    discrete-event simulation of every request (pure TypeScript)
   ├─ analysis/  recovery verdict vs. a no-failure control run, timeline, signals
   ├─ sweep/     tipping-point maps
   └─ fixes/     fix catalogue (data), candidate selection, ranking
data/  topologies and scenarios as plain data
```

### The engine

The engine simulates every request individually, using a time-ordered event queue. A run is
bit-for-bit repeatable.

- **Traffic is open-loop.** Requests arrive as a Poisson process whatever the system's state, the
  way independent users behave. This is what lets a system stay stuck.
- **Tiers and instances.** A tier is a set of instances behind a round-robin load balancer. Each
  instance has its own FIFO queue, a worker pool and CPU cores. A worker needs a core to compute,
  and holds no core while waiting on a downstream call.
- **Calls.** Every call has a timeout, retries, exponential backoff and optional full jitter. A
  timed-out attempt is abandoned by its caller but keeps running at the callee; that time is
  recorded as **wasted work**.
- **Cache-aside caching.** The cache holds real keys with LRU eviction and a TTL, and requests ask
  for keys from a Zipf distribution. The hit rate is an *output*, not a setting.
- **Failures.** A tier, or one of its instances, can slow down (service time × N) or die (refuse
  immediately). A cache can also restart empty.
- **Identical randomness.** Every random value is a hash of (seed, stream, request id, attempt
  path, tier), never drawn in sequence. A fix therefore sees exactly the same traffic and the same
  service times as the original run; a test enforces this.

### "Recovered" means "back to how it behaves with no failure at all"

Each run is compared with a **control run**: the same config and seed with the failures removed. A
second counts as healthy when all three of these hold:
1. every request succeeded exactly when it succeeded in the control;
2. p99 latency is within the control's own range;
3. every tier's queue is within the control's own range.

The run has recovered from the first second after which every judged second is healthy. Otherwise
it is stuck. If the control itself fails requests, the verdict is **overloaded**. No tolerance is
hand-tuned: the bounds come from the control run.

<details>
<summary>Why not require every request to match the control exactly?</summary>

That was the first plan. Measurement showed that after a recovery, the cache holds slightly
different keys than in the control until TTL churn evens them out. So a few requests harmlessly
miss where the control hit, for up to a TTL, and exact matching labelled clearly recovered runs as
stuck. See the decision log in [PLAN.md](PLAN.md).
</details>

## How we know it's right

There are three layers of tests (over 450 in all, with over 99% line coverage across the engine,
analysis, sweep, fixes and UI):

1. **Agreement with queueing theory.** On long runs (~400k requests) the engine reproduces analytic
   results. These are the mean response times at the committed test seed:

   | System | Theory | Simulated | Error |
   |---|---|---|---|
   | M/M/1, 50% utilisation | 20.00 ms | 19.75 ms | −1.2% |
   | M/M/1, 80% utilisation | 50.00 ms | 48.65 ms | −2.7% |
   | M/M/4 (Erlang C), 75% | 45.28 ms | 44.66 ms | −1.4% |
   | M/G/1, lognormal service (Pollaczek–Khinchine), 72% | 16.74 ms | 16.65 ms | −0.5% |
   | M/D/1 (Pollaczek–Khinchine), 72% | 13.71 ms | 13.71 ms | −0.1% |
   | 8 workers on 2 cores (behaves as M/M/2), 75% | 22.86 ms | 22.62 ms | −1.0% |
   | Round-robin over 3 queues (E3/M/1, GI/M/1 theory), 80% | 34.59 ms | 34.49 ms | −0.3% |

   Every row happens to be negative at this seed, so this was checked. Across 8 seeds, M/M/1 at
   80% averages **+0.1%** error (spread −2.7% to +1.9%), and the random streams are uncorrelated
   (r = 0.001).

   Also checked:
   - Little's law holds within 2%.
   - Response-time percentiles match the exponential distribution.
   - The emergent cache hit rate matches the **Che approximation** for LRU caches and the
     TTL-cache formula, within 1 point.

2. **Invariants.**
   - Requests are conserved at every tier: in = succeeded + failed + rejected + dropped + in flight.
   - Worker and core limits are never exceeded.
   - Retries multiply exactly as expected: (r₁+1)(r₂+1) calls per request.
   - Backoff timing is exact.
   - Runs are deterministic, and traffic is identical across different settings.

3. **Known failure patterns.**
   - The retry storm leaves the system stuck with retries and recovers without them.
   - Each extra retry lowers the tipping point.
   - While stuck, retries dominate DB load and over 90% of DB work is wasted.
   - A dead cache sends every lookup to the DB, and a restart comes back cold.

`npm run bench` measures 1.4–2.1 million events per second. A 60-cell map (120 simulations) takes
about 4 s on a laptop.

## What is modelled and what isn't

**Modelled:**
- worker pools held during downstream calls, and CPU cores
- per-instance FIFO queues, bounded or unbounded, with round-robin load balancing
- timeouts, retries, exponential backoff and full jitter
- retry budgets
- work continuing on abandoned requests, and dropping expired requests
- cache-aside caching (LRU, TTL, Zipf keys, warm start, coalesced misses)
- slow, dead and per-instance failures, and cache restarts
- long-tailed (lognormal) service times

**Not modelled.** Each of these is a way real behaviour can differ:
- garbage-collection pauses
- CPU contention or context switching slowing a server as it gets busier, which would make real
  stuck states *worse*, so this model is optimistic
- network latency and packet loss
- autoscaling
- load-balancer algorithms beyond round-robin, and load balancers' own capacity and timeouts
- connection setup costs
- users abandoning or refreshing
- database writes and replicas

**Note on "drop expired requests".** A tier with this setting checks the caller's deadline twice:
when a queued request gets a worker, and again when it gets a CPU core, which is when a real
handler starts running and typically checks its deadline. The second check matters because the DB
has 64 connections but only 4 cores: most expired requests are found waiting for a core, not in
the queue. A request dropped at either point is never computed, so it wastes nothing. With only
the first check, this fix did not help in the default scenario (0 of 5 seeds); with both, it does
(5 of 5). See the decision log (Q5) in PLAN.md.

**Simplifications** are marked `ASSUMPTION:` in the code. The main ones:
- all of an attempt's compute happens before its downstream call;
- a slowdown applies to computes that start while it is active;
- a dead tier refuses new work but finishes work in progress;
- a tier that drops expired requests checks the deadline when a request starts computing, not
  during the computation, so a request that expires mid-compute still finishes (and is wasted);
- cache writes are instantaneous and free;
- per-instance busyness in the diagram is drawn at the tier average.

## Design rationale

The full record is in [PLAN.md](PLAN.md): requirements, risks, scope, the decision log and the
time log. The main calls:

- **Depth over breadth.** One topology done well (Client → Gateway → API → DB, with a cache-aside
  cache) before adding more. The drag-and-drop builder, multi-region, LLM explanations and other
  scenarios are recorded as "revisit after V1".
- **Simulate every request, not aggregated traffic.** This is what makes per-request
  determinism, inline replays and agreement with queueing theory possible. The cost, sweep
  speed, is handled with Web Workers.
- **Everything is data except the engine.** Topologies, scenarios (timed failure schedules),
  fixes (setting changes) and map axes are plain data. A new scenario needs no engine change.
- **Fixes must be runnable.** Advice that can't be expressed as a setting change is left out.
  Fixes that were tried and didn't help are still shown; they teach as much as the winners.

  The default retry storm (200 req/s, 3 API → DB retries) is stuck on all 5 seeds, with 12,687
  failed requests at the default seed. What each fix does (recovery time after the failure ends
  and failed requests are at the default seed):
  - **Helped on 5 of 5 seeds:**
    - bounding the DB queue: recovers in 2 s (242 failed);
    - surprisingly, a 3× longer API → DB timeout: 3 s (147 failed). With 3 s, the API never gives
      up during the 5 s slowdown, so it never retries;
    - a retry budget: 3 s (306 failed);
    - dropping expired requests at the DB: 7 s (440 failed; 5–7 s across seeds). Wasted DB work
      falls from 90% to 18% of the run's DB compute; what remains is requests that started
      computing before their caller's deadline and finished after it.
  - **Helped on 1 of 5 seeds:** capping retries at 1: 13 s (841 failed). One
    retry at 200 req/s sits right on the tipping point.
  - **Did not help (0 of 5 seeds):**
    - jitter: it spreads retries out but doesn't reduce them, and this is a capacity problem, not
      a synchronisation one;
    - coalescing cache misses: it cuts DB reads by 43%, which isn't enough;
    - more API instances: the API isn't the bottleneck.
- **The map varies one call's retries.** With retries at every layer they multiply, (r+1)³, so
  every retry count tipped at the same traffic and the map was a single step. Varying API → DB
  retries gives a readable staircase.

## Time spent and how AI was used

- **Planning:** about [to be confirmed] of conversation. This covered requirements, risks, scope,
  mockups and architecture.
- **Implementation:** about 3.5 hours across milestones P0–P7. See the time log in PLAN.md.

This was built with Claude (Claude Code) as a pair. The author set the direction and made every
product and design decision: theme, scope, the recovery definition, map axes, layout and quality
bar. Claude proposed options and trade-offs, wrote the code and tests, and ran parallel
sub-agents for independent modules (the analytic models, low-level utilities, presentational UI
components, the worker pool and sweep, and the fix catalogue). Claude also verified results,
including flagging and measuring where its own first plan (exact-match recovery) didn't hold.

## Running it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # all tests
npm run coverage   # tests + coverage report (gate: 90%)
npm run bench      # engine throughput
npm run deploy     # build and publish to here.now (set HERENOW_API_KEY and HERENOW_SLUG)
```
