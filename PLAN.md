# PLAN.md

Single source of truth for this project. If this file and the conversation disagree, this file wins until we agree to change it.

**Status:** Requirements confirmed. Waiting for the project idea.

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
| R7 | Theme 5 only: judged mainly on measured performance against baselines, with benchmarks, methodology and reference implementations |

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
| A4 | The reviewer needs nothing but a browser: no installs, accounts or API keys | Confirmed (follows from A3) |
| A5 | The reviewer may spend only 10–15 minutes, so the first minute has to show the most interesting behaviour | Assumed |
| A6 | The tech stack is up to us | Assumed |

### What a hosted URL implies (to be weighed once the idea is known)

- **Client-only static site** (for example GitHub Pages, Netlify or Vercel): no server to keep running, no secrets, no running cost, and it works the same in a year. This is the simplest option if the idea allows it.
- **Anything with a backend or LLM calls** adds uptime, cost, abuse and key-exposure risks. It would also need a fully working offline or cached path to satisfy R3 and A4.
- The URL has to stay up for the whole review period, so we should test it from a clean browser before submitting.

## 3. Open questions

- Q1. Where to host, and does the repo need to be public for that host (for example GitHub Pages on a free plan)? To decide once the stack is chosen.

## 3a. Risks (under discussion; agreed items marked)

| # | Risk | Mitigation | Status |
|---|------|------------|--------|
| 1 | Running out of time | Scope in tiers: must-haves first, then expand as time allows. Build a working core early | Agreed |
| 2 | Simulated behaviour doesn't match real systems | Presets ship sensible settings that are fully editable; nothing is auto-picked or auto-tuned. Modelling correctness is enforced by tests at three levels: comparison with queueing theory, invariants, and known failure patterns | Agreed |
| 3 | Overclaiming accuracy | Model the production mechanisms that drive these failures; state what is not modelled in the README, not in the UI | Framing open |
| 4 | Sweeps too slow | Back-of-envelope estimate done; confirm with a benchmark in milestone 1. Run the simulation in Web Workers | Open (worker choice) |
| 5 | Fix suggestions look scripted | Every suggested fix is a setting change that actually gets re-run. Rank fixes by relevance to what the run showed | Ranking method open |
| 6 | Too much on screen | Show one question at a time, in order. Advanced settings, extra charts and long text are collapsed or toggleable | Agreed |
| 7 | Trace-back balloons | V1: a short, readable timeline of detected events. Iterate from there | Agreed |
| 8 | Hosted URL fails | The user will test the hosted URL repeatedly; low concern | Agreed (low) |
| 9 | Before/after runs not comparable | Seeded random draws tied to each request, so the original and the fix see identical traffic and identical random values. Covered by a test | Agreed; details go in the architecture section |

## 4. Idea

_Waiting for your idea._

## 5. Requirements check

_To be filled in once the idea is in: each requirement marked met, partly met, not met or over-built._

## 6. Plan

_To be agreed: scope (in and out), architecture, technical choices, risks, milestones and the check for each milestone._

## 7. Decision log

| Date | Decision | Why |
|------|----------|-----|
| 2026-10-21 | Working agreement: options and tradeoffs first, you decide, no code before the plan is agreed | Set in the kickoff message |
| 2026-10-21 | Time budget 2.5–3 h | Leaves room for depth while staying well inside the 8 h limit |
| 2026-10-21 | Deliver as a hosted URL plus the repo and README | Keeps reviewer effort as low as possible (R3) |

## 8. Time log

| Session | Duration | What was done |
|---------|----------|---------------|
| 1 | — | Kickoff, requirements confirmed, PLAN.md created |
