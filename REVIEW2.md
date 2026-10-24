# Adversarial review, round 2 (2026-10-24)

Five reviewers went over the live site, each from the point of view of someone new to distributed
systems:
1. first-visit think-aloud (demo tour, steps 1–3, the three built-in failures)
2. "Build your own system", end to end
3. accuracy: everything the app says, checked against fresh simulations
4. every flow and edge case
5. accessibility and layout

Their raw findings were merged, duplicates folded together, and the most serious claims
re-checked by hand against the code or a fresh run. Those are marked **verified**. The others
carry the reviewer's evidence (screenshots and scripts are in the session scratchpad,
`review2-*` folders). **Raised by** counts how many reviewers found the same problem
independently.

## Verdict

**The problem comes across; the fixes and the built systems don't, yet.**

What works: a newcomer understands that the system stays broken after the failure ends. The
demo tour, the guided pause, the Throughput chart and the diagram badges carry that well. The
preset numbers, tipping maps and fix rankings all match the README.

What doesn't:
- **Step 3 teaches the wrong lessons in several places.** Fix explanations contradict their own
  results. The recommended fix looks like it makes things worse. A fix can be marked "helped"
  while failing more users.
- **Queue systems are judged wrongly.** A draining backlog is called "stuck" and "still failing",
  and their story describes a retry cascade a queue prevents.
- **The builder has a crash and silent data loss.** One input crashes the tab, and a built system
  is lost on reload or Cancel.

No console errors in normal use; no NaN, undefined or blank screens apart from the crash and the
locale case below.

---

## 1. Fix first: the app says something false (accuracy)

| # | Finding | Raised by | Status |
|---|---|---|---|
| 1.1 | **Queue systems are called "stuck" or "still failing" while the backlog is draining and no user fails.** Judging stops at run end minus the longest a user request can take (~111 s). A backlog that drains at 115 s is "stuck: it never caught up". Example: Server → Queue → DB, front door slows down, 100 req/s. Backlog 3,638 → 209, falling steadily; 0 user failures after 52 s; verdict "never recovered: still failing at the end". Map cells inherit this. | accuracy | **verified** |
| 1.2 | **A fix can win only because it moves the judging window.** "One layer · 65 s" changed no retry that ever fired, and its backlog is identical second by second. Only `judgedUntilMs` moved, because client retries and timeout change "the longest a user request can take". | accuracy | reviewer script |
| 1.3 | **0% errors during a total outage.** User outcomes are counted when a request *finishes*, and failing takes ~21 s. At 45 s users send 203 req/s, 0 succeed and 0 have "failed" yet, so the Errors chart and the Client box read 0% and "healthy". This is the stretch the tour points at. | accuracy | **verified** |
| 1.4 | **"Helped" includes fixes that hurt users.** `fixHelped` accepts "recovers faster *or* fewer failures": Cap retries on a 1 s Gateway failure is ranked first with ✓ while failing 43 vs 0. The seed check also counts "the original recovered by itself" as "the fix didn't help". So Bound queue shows ✓ next to "Helped in only 4 of 5 runs, so the result depends on luck" (cache restart). "One layer", at 1 of 5 runs, gets the same ⚠ as 4 of 5. | flows, accuracy, newcomer | **verified** (code) |
| 1.5 | **Fixed "How it helps" text contradicts the result next to it.** Retry budget: "so the pile drains" next to "still stuck". Coalesce, the best fix for cache restart: "the loop usually goes on" next to "recovers in 1 s, 5 of 5". Cap retries: "repeats at most double the calls" while the DB runs at 10× normal. No fix says *why it didn't help here*, though the README does ("the other layers still multiply the load"). | newcomer, accuracy | reviewer evidence |
| 1.6 | **The recommended fix looks 5× worse.** "DB load at its peak 3.3× → 18.1×" counts requests the DB *turned away* (2,697 of 2,844/s). The step 3 chart is scaled to that spike, which flattens the real storm to a strip. A newcomer reads "the good fix quadruples the load". | accuracy, newcomer | **verified** |
| 1.7 | **Queue stories claim a retry cascade the queue prevents.** "Every layer asks again… users' apps up to twice, the load balancer once…": the queue already answered them, and retries are 0.27% of DB arrivals. "Everyone asks again" also appears in runs with 0 retries (cache restart at 80–120 req/s). | accuracy, builder | reviewer evidence |
| 1.8 | **"Overloaded even without the failure" is drawn as Stuck and called the tipping point.** For built systems without a cache the traffic range goes to 1.5× capacity, so half the map is plain overload. Step 2 then says "everything looks healthy until a failure like this happens", while step 1 says "overloaded even without the failure". | accuracy | code |
| 1.9 | **"First attempts" includes repeats from the layers above.** On the DB chart the blue band alone is 1.6× capacity, which reads as "it isn't the retries". The Client box says "198 rps sent" while its arrow says "1213 rps incl. 1015 retries". | accuracy, newcomer | reviewer evidence |
| 1.10 | **Four overload numbers for one run** (1.3×, 3.1×, 3.2×, 3.3×). The details panel shows the whole-run peak (3.2×) at 33 s, before it happens. | newcomer, accuracy | reviewer evidence |
| 1.11 | **Times that look like events:** "Never recovered · 99 s" (the end of the judged range) in every scenario. A failure the editor allows to end at 100 s gets "was still going on when the run ended" (judging stops at 98.9 s). | newcomer, accuracy | reviewer evidence |
| 1.12 | **Smaller inaccuracies:**<br>• the overloaded story says "requests fail anyway" when the no-failure run fails nothing;<br>• the timeline's wasted-work share comes from the whole incident but is quoted as "after the failure";<br>• step 2 always says "Every layer asks again";<br>• queue fixes ignore dead-lettered messages (150 → 352 counts as "no change");<br>• a zig-zag map row is reported as one tipping point;<br>• the "more consumers" con is contradicted when the app server is slow;<br>• the front-door slowdown factor is sized for one traffic level. | accuracy, builder | reviewer evidence |

## 2. Crashes, dead ends and lost work

| # | Finding | Raised by | Status |
|---|---|---|---|
| 2.1 | **Built systems: the step 2 traffic range is computed from capacity alone, so the user's own traffic can be off the map.** Client → App server at 100 req/s gets 1,000–5,500 req/s: off the map, every cell stuck, minutes to fill. At a field's own maximum (100 copies) the map simulates ~70k req/s and **the tab crashes**. Tiny values give a 0.004–0.013 req/s axis. | builder | **verified** (code) |
| 2.2 | **A built system is lost on reload, on Cancel, and on "Use the example system instead"**, with no warning and no undo. Nothing is saved. | builder, flows | **verified** (code) |
| 2.3 | **The settings drawer can't re-run a built system that has no timeout or no cache expiry.** It shows "0" with a minimum of 1, so Re-run silently does nothing. The error is below the fold. | flows | **verified** (code) |
| 2.4 | **"Use this topology" resets a customised failure and the step; changing the failure discards drawer edits on a built system.** | flows, builder | code |
| 2.5 | **"Change failure" does nothing while the builder is open** (it turns into "Close"; the editor appears later). | flows, builder, a11y | code |
| 2.6 | **Invalid values are dropped silently** (Traffic 0 snaps back on blur) while Run stays enabled; "Re-run" with no changes does nothing visible. | flows, builder | reviewer evidence |
| 2.7 | **Blank page under an unusual browser language setting** (`en-US@posix`: `toLocaleString()` throws) and no error boundary. Rare for real users, but nothing is shown at all. | newcomer, accuracy, a11y | code |
| 2.8 | **Long runs** (5,000 req/s × 600 s, both within limits) take 81 s with no progress and no cancel. | flows | reviewer evidence |

## 3. A newcomer can't follow it (comprehension)

| # | Finding | Raised by |
|---|---|---|
| 3.1 | **The story panel hides its explanations.** Rows show headlines ("The app server gives up, everyone asks again · 1 s"). The sentence that teaches the cascade is only in a hover tooltip and screen-reader text. Touch users never see it. | newcomer |
| 3.2 | **⚠ / ✓ / ✕ and the numbers on fix tabs are never explained on screen**, and the ranking looks backwards: ✓ Bound queue 16 s with 209 failed, above ⚠ Timeout 9 s with 0 failed. "Bound …" is cut off. | newcomer, a11y, flows |
| 3.3 | **Tour stops 8–10 describe results that aren't there yet.** The map is at 21 of 60 runs. Stop 9 says "Bound queue holds up" while Timeout is selected and the tabs reorder under the popover. Stop 10 shows maps that don't exist yet. At stop 3 (32 s) users haven't retried yet; they start at 33 s. | newcomer, a11y, flows, accuracy |
| 3.4 | **Cutting retries makes things worse and the comparison panel doesn't say why** ("More requests failed for users"). The next lesson is right there but unspoken: the other layers still multiply the load. | newcomer |
| 3.5 | **Step 3 maps have no colour key; "stuck" is colour alone** (orange vs dark blue is 1.36:1 in brightness). | newcomer, a11y |
| 3.6 | **The Latency chart says "user gives up after 3 s" while both lines sit at 21 s.** That is the wait including every retry, and nothing says so. | newcomer |
| 3.7 | **Jargon left unexplained:** p99, workers, rps, seed 42, "retries 5 / 3 / 1", Coalesce, Jitter, Drop expired, "4 of 5 random runs". | newcomer |
| 3.8 | **Step 2's sentence ignores the clicked cell; the tipping point is never drawn on the map.** Step 2 and 3 replays have no story; the events panel changes name between steps. | newcomer |
| 3.9 | **Finishing the tour lands mid-replay** with the verdict hidden again. | newcomer |

## 4. Builder usability

| # | Finding | Raised by |
|---|---|---|
| 4.1 | **"Add" places boxes in touching cells, so every arrow and label is hidden under the boxes** while the footer says "Ready to simulate". | builder, a11y |
| 4.2 | **"Start from the example" loads a different system from the example** (100 req/s, retries 2/1/1, 1,024 workers), and its status line still says "Server". | builder |
| 4.3 | **Long chains truncate names in the run diagrams** until parts look identical ("App s…", "App s…"); arrow captions read "no retrie". | builder, a11y |
| 4.4 | **Problems are listed below the fold** while the button above is disabled; the builder page is 922–1004 px tall. Messages say what's wrong but not how to fix it. A blank name in a loop reads "→ App server → Database → .". | builder |
| 4.5 | **The builder and the settings drawer use different words for the same settings** (Copies/Instances, Typical time/Service time median, …). For a built system the drawer still says "Preset" and "Reset to preset". | builder, flows |
| 4.6 | **Deleting can't be undone** (only Clear can). Delete acts on the *selected* item, not the focused one. | builder, a11y |
| 4.7 | **Number fields:** invalid text shows red while the footer says "Ready"; median = p99 is accepted by the fields but rejected by the problem list. The canvas is 16 px wider than its frame. | builder |

## 5. Accessibility and layout

| # | Finding | Raised by |
|---|---|---|
| 5.1 | **The builder can't be used at phone width**: the settings panel covers the canvas. Steps 1 and 3 scroll sideways at 390 px. | a11y |
| 5.2 | **"Calls…" (the only keyboard way to connect boxes) connects on the first arrow key press, then focus is lost.** | a11y |
| 5.3 | **Focus drops to the page after most big actions** (open/close builder, Use, Clear, Re-run, tour Done); "Simulating…" isn't announced. | a11y |
| 5.4 | **Live updates are silent where they matter and noisy where they don't.** The story and verdict aren't announced. The events list reads 7 events in 1.7 s. A focused diagram box re-reads its numbers 53 times in 25 s. | a11y |
| 5.5 | **Step 3 has 129 tab stops (120 map cells) before the fix tabs; fix tabs ignore arrow keys.** Charts have no text or table alternative. | a11y |
| 5.6 | **Labels cut off or covered at 1440 and 1280 px:** "incl. 1015 retrie", "⚠ overloaded" over "CPU 100%", fix badges wrapping over arrows. "Shown on the right" is wrong at 1024 px, where the story starts below the fold. | a11y, flows |
| 5.7 | **Smaller issues:**<br>• faint graphics (pending cells 1.22:1; "before" line 2.61:1);<br>• autoplay at 16× ignores reduced-motion;<br>• header placed inside `<main>`;<br>• comparison table without column headers;<br>• 9–11 px monospace text;<br>• mouse-only instructions ("drag", "on the right", "Press ?"). | a11y |

## 6. Speed and state

| # | Finding | Raised by |
|---|---|---|
| 6.1 | **Changing steps throws away finished work.** The step 2 map restarts from 5 of 60, step 3 recomputes all 9 fixes and forgets the chosen one, and step 1 restarts the replay and hides the comparison. | flows |
| 6.2 | **Step 3 takes ~27 s before the before/after replay appears:** it re-simulates a run the ranking already did, queued behind 120 map cells. | flows |
| 6.3 | **Small failure-editor issues:** no cap on "Add another failure" and overlapping windows stack into an orange block; "Starts at" accepts 600 s in a 120 s run; the tour forgets an open, unsaved failure editor. | flows |

## What works well (all reviewers)

- **The core lesson lands.** The tour, the guided pause, Throughput dropping to 0 while traffic
  stays at 200, and the diagram badges.
- **The presets are accurate.** Numbers, tipping maps and fix rankings match the README; the
  tour's claims hold.
- **No errors in normal use.** No console errors, NaN or overflow at 1440×900. The tour restores
  the viewer's state. Rapid clicking is safe.
- **The builder basics work.** Drag and drop works, with the live "✕ Only an app server looks
  things up in a cache" hint. The problem messages are clear. Queues are drawn clearly. Only
  scenarios that apply are offered.
- **Text contrast passes in both themes.** Visible focus everywhere, the drawer and tour are
  proper dialogs, and accessible names are written in plain language.

## Suggested order

1. **Correctness:** items 1.1–1.11 and 2.1. Judge every run the fixes are compared on over one
   common window. Count user outcomes by arrival. A fix must not fail more users. Rewrite fix
   text by outcome. Make queue stories queue-aware. Plot work done separately from work turned
   away. Give overload its own map colour.
2. **Lost work and dead ends:** 2.2–2.7. Save the system, align the drawer with the builder,
   keep failures across "Use", add an error boundary.
3. **Comprehension:** 3.1–3.9. Show story sentences, a fix legend and "why it didn't help", a
   tour that waits for results, a step 3 map key.
4. **Builder polish:** 4.1–4.7.
5. **Accessibility and layout:** 5.1–5.7.
6. **Speed and state:** 6.1–6.3. Cache results by config, so steps keep their work and step 3
   reuses step 2's map.

## Decisions for the user

- **Queue still catching up at the end of the run (1.1):** extend the run until it settles, or
  say "still catching up, about N s more"? The first is accurate but runs longer; the second is
  honest and fast.
- **Overload on the map (1.8):** a third colour, "too much traffic even without the failure"?
  And should built systems without a cache use a narrower traffic range?
- **Saving work (2.2):** remember the built system in this browser (localStorage), in the URL
  (shareable link), or both?
