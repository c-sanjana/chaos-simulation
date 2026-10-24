# Chaos Simulation Lab

**Live demo:** https://ivory-tassel-sxy5.here.now/ (runs entirely in your browser; nothing to install)

An interactive simulation of how distributed systems fail, how failures spread, and **the tipping
point where a system stops recovering on its own**. You can then try a fix and see, on identical
traffic, whether it actually helps and whether it moves the tipping point.

> Built for intuition, not prediction. The mechanisms are real and tested against queueing theory;
> the numbers are illustrative. See [What is modelled](#what-is-modelled-and-what-isnt).

## The first minute

The page opens on a **retry storm**. A database slows down 8× for just 5 seconds, at a traffic
level it normally handles easily. Every layer retries, differently, as real systems often do:
users' apps ask again up to 5 times, the Gateway retries the app server 3 times and the app server retries the
DB once (all editable per layer). Two other presets fail elsewhere in the stack: **Cache restarts
empty** (the cache goes down for 5 s and comes back cold, so every lookup stampedes the DB) and
**Gateway slows down** (the front door slows 50× for 20 s and users' retries pile onto it). Any
part can fail (slow down, go down, lose one server, or for the cache restart empty), and several
failures can be combined. On a first visit a one-minute guided demo follows the retry storm on
the default system: it plays the replay forward and pauses at each moment that matters (calm
traffic, the database slowing down, repeats piling up, the failure ending, stuck for good), then
shows the tipping point and a fix that holds up, introducing each part of the page as it goes
(stops about results say "Getting results…" until they are on screen). Finishing it leaves the
replay paused at its end with the verdict. Skip it, or replay it any time with the **?** button at
the top right; started with other settings, the demo sets them aside and puts them back
afterwards. **Words** beside it explains the jargon (req/s, timeout, retry, p99, workers, queue,
random run #), and ☾ switches to dark mode (the page stays light unless you choose dark).

1. **What happened.** The system never recovers, even though the failure is over. The side panel
   builds up as the replay reaches each moment, as pictures more than text: one row per step with
   an icon, a few words and the key number ("Database 8× slower · 5 s"), a meter of load against
   capacity, and blocks showing how many times each layer asks again. The newest row also shows
   the sentence that explains it; older rows show theirs on **Why?**. The verdict is revealed only when the replay gets there, and the first replay pauses
   just after the failure ends: "the database is back to normal speed; watch whether the system
   recovers". Below it, the measured details as a row of icons in order (those during the failure
   tinted), the newest spelled out underneath; **List** shows them all as text. With numbers from
   the run:
   - DB p99 exceeds the app server's 1 s timeout, and every layer starts asking again.
   - Retries push DB load past its capacity (1.3× in the second it happens; every number is the
     value at the moment shown, and whole-run peaks say so).
   - A stuck run says "Still stuck" at the end of the run, not at a time that looks like an event.
   - The point of no return: the failure is over, but retries keep the DB overloaded, so the
     backlog can never drain.
   - Most DB work is for requests the app server had already given up on, and the cache empties because
     nothing refills it.

   After you change a setting and re-run, once the replay reaches the end a "Compared with your
   last run" panel shows what you changed (chips) and how the results moved, each as a dot moving
   from before (grey) to now (blue) with a ▲/▼ change (failed requests, retries sent, peak load on
   the most overloaded part, busy workers, messages dropped behind a queue), and a plain takeaway.
   After changing only retries it says why, from the run: "Users retried less, so more failures
   reached them directly. It was still stuck because users' apps (1×), the Gateway (3×) and the
   App server (1×) still multiply the load."

   The diagram marks the injected slowdown (⚡), overloaded parts (⚠) and failing calls (✕), with
   a key. End-to-end latency is measured as how long users waited for an answer, errors
   included, so it rises when requests fail instead of looking fast.
2. **Where's the tipping point?** The same failure, re-run at 60 combinations of traffic and how
   long the failure lasts. Each cell is a full simulation, and you can click one to replay it
   inline. For the retry storm: a slowdown of up to 2 s always recovers; 3 s tips at 160 req/s,
   5 s at 100 and 8 s at 80, so the default 200 req/s is far past it. Stuck cells carry a ✕, each
   row's tipping point is drawn as a bar, and "too much traffic even without the failure" has its
   own hatched colour: it is never called a tipping point. A noisy row says "around X–Y req/s".
3. **Does a fix help?** Candidate fixes are chosen from what the run showed. Each one is a single
   setting change, re-run against the same traffic and the same failure, and ranked by what
   actually happened. Every fix that helped is then checked to see whether it holds up: on 5 random
   seeds, and with a slowdown twice as long. Fixes that hold up rank first (✓); the others are
   marked ⚠ "helped only sometimes", or ✕ when they helped in only 1 of 5 runs (luck); a key under
   the tabs explains the marks and numbers, and the first fix says why it is first. Each fix says
   what happened, **why it worked or didn't here** (measured: e.g. "Users' apps (5×), the Gateway
   (3×) and the app server (1×) still retry, so the database still had up to 3.2× the work it can
   handle after the failure ended"), how it works, why it was suggested, and its pros and cons
   (including cost and drawbacks measured in the run; a pro or con the run contradicts is left
   out). Choosing a fix shows it before and after side by side, with what it
   changed labelled on the diagram, and whether the tipping point moved; click any cell of either
   map to replay that cell before and after.

### Build your own system

**✎ Build your own system** (top right) opens a canvas with the current system drawn on it. Drag
components from the palette (or use their **Add** buttons, which leave a gap so arrows stay
visible): **client, load balancer, app server, cache, database, queue**. Each starts with
realistic defaults, and every setting can be changed in the panel beside the canvas, in plain
words. Connect parts by dragging from a box's handle to another box, or by keyboard with
**Calls…** and **Connect**; select an arrow to set its timeout and retries. Removals can be
undone. Problems are listed in plain words with how to fix them ("App server has a cache but
nothing to ask when the cache doesn't have the answer: connect it to a database or another
component"), the count is on **Use this topology**, and once there are none it runs all three
steps on the system, keeping the current failure if its parts are still there.

- **Remembered in this browser.** The built system, what runs on it (failure, traffic, settings
  edits) and the drawing are saved in localStorage and come back on reload. Cancel keeps a changed
  drawing for next time; "Use the example system instead" can be undone.
- **One set of words.** The settings drawer uses the builder's labels and limits, and can say "no
  timeout" and "entries never expire". For a built system it says "Your system" and "Reset to how
  you built it".
- **Chains for now.** Each part calls one next part, plus one cache for an app server. Branching (an
  app server calling several parts, a load balancer splitting over several pools) is next.
- **Scenarios are picked by what each part is:** the database slows down; the cache restarts
  empty; the front door slows down enough to serve about half the traffic (described per request,
  e.g. "takes ~250 ms a request instead of ~4 ms"); the work behind a queue slows down.
- **The map is centred on your traffic.** Whole numbers in round steps from about a third of the
  client's traffic to about twice it, widened to take in the capacity estimate (without cache help)
  when it is nearby, stopping at 1.25× that estimate for a system without a cache (further right
  is plain overload), never above 5,000 req/s. The example system at 200 req/s gets 50–400.
  A run of more than 3 million requests (5,000 req/s × 600 s) is refused in plain words.
- **The queue is an asynchronous message queue.** The sender is answered as soon as the message is
  stored. Consumers take messages in order and call the next part with its timeout and retries; a
  message that still fails is dropped ("dead-lettered"). Users never see a backlog, so the story,
  the timeline and the diagram show it: messages waiting, consumers busy, how late the work is.
  A "twice as many consumers" fix is offered when messages pile up; it is often a lesson in
  itself, because when the part behind the queue is what's slow, more consumers just send it
  more work at once.
- **Accuracy.** A drawn topology compiles to exactly the data the presets use. The example system
  redrawn on the canvas simulates identically to the preset (same results, request for request).
  The queue is checked against queueing theory (M/D/1 and M/M/c waits, throughput, backlog growth
  and drain time; see "How we know it's right").

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
second counts as healthy when all of these hold:
1. every request succeeded exactly when it succeeded in the control;
2. p99 latency is within the control's own range;
3. every tier's queue is within the control's own range;
4. every message queue's backlog is within the control's own range (its senders are answered at
   once, so users alone would call a backlog that never drains "recovered");
5. no message queue drops more messages than in the control's worst second.

The run has recovered from the first second after which every judged second is healthy. Otherwise
it is stuck. If the control itself fails requests, or a message queue falls further and further
behind even without the failure, the verdict is **overloaded**. No tolerance is hand-tuned: the
bounds come from the control run.

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
- asynchronous message queues: bounded depth, a pool of consumers calling the next part with
  retries, dead-lettering, durable messages (a queue that goes down keeps what it holds)

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
- a queue's consumers need no worker or CPU of the queue's own, and handing a message over takes no
  time; delivery is "at least once" (a sender that times out and retries stores the message twice);
  a dead-lettered message is counted and dropped, not reprocessed;
- per-instance busyness in the diagram is drawn at the tier average.

## Design rationale

The full record is in [PLAN.md](PLAN.md): requirements, risks, scope, the decision log and the
time log. The main calls:

- **Depth over breadth.** One topology done well (Client → Gateway → App server → DB, with a cache-aside
  cache) before adding more. The drag-and-drop builder, multi-region, LLM explanations and other
  scenarios are recorded as "revisit after V1".
- **Simulate every request, not aggregated traffic.** This is what makes per-request
  determinism, inline replays and agreement with queueing theory possible. The cost, sweep
  speed, is handled with Web Workers.
- **Everything is data except the engine.** Topologies, scenarios (timed failure schedules),
  fixes (setting changes) and map axes are plain data. A new scenario needs no engine change.
- **Fixes must be runnable.** Advice that can't be expressed as a setting change is left out.
  Fixes that were tried and didn't help are still shown; they teach as much as the winners.

  With the default retries at every layer (5 / 3 / 1), the measured results at the default seed
  (recovery time after the failure ends, failed requests):
  - **Retry storm** (stuck, 12,561 failed): only bounding the DB queue holds up (16 s, 209 failed;
    5 of 5 seeds; still helps with a 10 s slowdown). A 3× longer timeout recovers in 9 s with 0
    failed but not with a longer slowdown, and "retry at one layer only" helps on 1 of 5 seeds;
    the app marks both ⚠. Changing a single call's retries (budget, cap, jitter) no longer helps:
    with three layers retrying, the others still multiply the load. The same 10% retry budget on
    **every** layer does help: 8 s, 538 failed, 3 of 5 seeds, and the tipping point at a 5 s
    slowdown moves from 100 to 240 req/s (⚠: not with a 10 s slowdown). Each retry fix's panel is
    labelled "one layer" or "whole stack" and shows the end-to-end multiplication: up to 48× the
    calls reach the DB while it fails (users' apps 6 × Gateway 4 × App server 2); a one-layer budget
    takes that to 26×, a budget on every layer to 1.3×.
  - **Cache restarts empty** (stuck, 12,747 failed): coalescing cache misses (1 s, 0 failed; 5 of
    5) and bounding the DB queue (23 s) hold up; a longer timeout helps only sometimes.
  - **Gateway slows down** (stuck, 10,361 failed): bounding the queue (7 s, 0 failed; 5 of 5) holds
    up; a retry budget at every layer (6 s) and retrying at one layer only also help at the default
    seed. This preset's 2× longer slowdown happens
    to recover by itself, so the longer-slowdown check is skipped there (it can't tell anything).

  With a single retrying layer (App server → DB 3 times, the original preset; kept in the tests) the
  default run is stuck on all 5 seeds, with 12,687 failed requests:
  - **Helped on 5 of 5 seeds, and still helps with a 10 s slowdown:**
    - bounding the DB queue: recovers in 2 s (242 failed);
    - a retry budget: 3 s (306 failed);
    - dropping expired requests at the DB: 7 s (440 failed; 5–7 s across seeds). Wasted DB work
      falls from 90% to 18% of the run's DB compute; what remains is requests that started
      computing before their caller's deadline and finished after it.
  - **Helped on 5 of 5 seeds, but not with a 10 s slowdown:** a 3× longer App server → DB timeout:
    3 s (147 failed). It works only because this slowdown is short: with a 10 s slowdown it stays
    stuck, with more failures (14,813) than no fix at all. It also makes the app server wait longer for the DB (3 s) than the Gateway waits for the
    app server (2 s), so all 147 failures are Gateway timeouts. The app marks it ⚠.
  - **Helped on 1 of 5 seeds:** capping retries at 1: 13 s (841 failed). One
    retry at 200 req/s sits right on the tipping point.
  - **Did not help (0 of 5 seeds):**
    - jitter: it spreads retries out but doesn't reduce them, and this is a capacity problem, not
      a synchronisation one;
    - coalescing cache misses: it cuts DB reads by 43%, which isn't enough;
    - more app server instances: the app server isn't the bottleneck.
- **The map varies how long the failure lasts.** Measured: with retries at one layer the tipping
  point steps with the retry count (1 retry tips at ~200–220 req/s, 2 at 140, 3 at 120, whichever
  layer retries), but once two or more layers retry, every mix tips at about the same traffic, so a
  retries axis would show identical rows. Failure length gives a readable staircase for a failure
  in any component. The cascade is real but capped by nested timeouts: 5 / 3 / 1 retries could in
  principle send one request to the DB 48 times, yet the DB peaks at 3.2× its capacity, because
  users' apps give up after 3 s while the inner layers are still retrying.
- **Recovery is judged at the latency histogram's resolution.** A second counts as healthy if its
  p99 is in the same histogram bin as the no-failure run's highest (or lower): a 0.2 ms difference
  inside one ~12% bin once turned a 1 s cache outage into "recovered 62 s after".

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
