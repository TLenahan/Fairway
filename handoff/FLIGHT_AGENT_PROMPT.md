# Fable Ultracode Agent — Flight-Model Aero Calibration (no range data required)

You are a **Fable model running in ultracode mode**. Optimize for the most exhaustive, correct result — token cost is not a constraint. Adversarially verify your own fit; loop until the acceptance bar is met or a residual is precisely characterized.

## Mission

Calibrate the golf app's ball-flight model against **physics-grade external truth** — public measured-flight datasets and vendor trajectory oracles — so that computed **carry, total, apex, and descent angle** are accurate across the full launch space (60° wedge → driver, including low-spin knockdowns) and across **altitude (0–8,000 ft)**. No range collection from the owner: the entire fit and validation happens from external sources.

**Why descent angle and apex matter as much as carry:** the product computes slope "plays-like" adjustments downstream via `Δ ≈ elevation / tan(descentAngle)`. Two models can match carry with different arcs; only matching the ARC (apex + descent + flight time) makes slope math correct. Carry-only fitting is failure.

## Setup — work in a FRESH worktree off main

Another agent is concurrently working in the `hackmotion-shot-detection` worktree. Do NOT work there. From the repo root (`/Users/tlenahan/Documents/fairway`):

```
git worktree add .claude/worktrees/flight-calibration -b claude/flight-calibration main
```

Work entirely inside that worktree. Note the repo gotcha: worktrees resolve `@golf/*` through their own `node_modules` symlinks; verify lib edits from INSIDE the worktree (run jest/tsc there), never from the main checkout. If `apps/fairway/tsconfig.json` lacks a path map for a lib you change, that's a known trap — but you likely only touch `libs/flight-model`, which is mapped.

## The model you are calibrating

`libs/flight-model/src/` — RK4 integration under gravity + drag + Magnus lift, air density from altitude (barometric/ISA), spin decay, rollout:

- `coefficients.ts` — **the fit surface.** Cd/Cl are functions of spin ratio S = r·|ω|/V:
  - `Cd(S) = CD_BASE + CD_SPIN_SLOPE·S` (currently 0.225 + 0.3·S)
  - `Cl(S) = CL_MAX·S/(CL_HALF_S + S)` (currently 0.42, 0.11)
  - Literature bounds documented in the file (Bearman & Harvey 1976; Quintavalla 2002 USGA; Smits & Smith): Cd ≈ 0.21–0.31, Cl ≈ 0–0.35 over realistic S. Stay inside or justify.
- `spin.ts` — spin decay (affects late-flight lift → descent steepening; a real fit dimension).
- `air.ts` — density vs altitude (ISA). Treat as physics — validate, don't refit, unless evidence demands.
- `integrator.ts`, `simulate.ts` — trajectory; `rollout.ts` — ground roll (fit only after carry/arc is right).
- `constants.ts` — ball mass/diameter etc. Fixed physical facts; do not touch.
- Existing specs (`calibration.spec.ts`, `simulate.spec.ts`) encode current expectations — update alongside the refit with data-backed rationale.

The model is functional-form-correct; your job is **fitting the small coefficient set** (CD_BASE, CD_SPIN_SLOPE, CL_MAX, CL_HALF_S, spin-decay rate, and rollout params) to truth, then validating altitude scaling.

## Truth sources (in trust order — cross-validate between them)

1. **TrackMan measured data** — TrackMan radar tracks the real ball flight, so its carry/apex/land-angle are *measured reality*, the gold anchor. Start with: https://github.com/tim-blackmore/launch-monitor-regression (~10k rows claimed). **Step 1 of the whole project: fetch it and check the columns.** Fit-ready = ball speed + launch angle + spin + (carry, apex/height, descent/land angle). If columns are insufficient, hunt for alternatives (Kaggle golf launch/trajectory datasets; published TrackMan tour-average tables — small but authoritative anchors: per-club ball speed, launch, spin, height, land angle, carry).
2. **FlightScope Trajectory Optimizer** — parameterized oracle at https://trajectory.flightscope.com/ (their Environmental Optimizer handles altitude/temperature/humidity). Radar-company physics. Use it to (a) densify coverage where the measured dataset is thin (extreme wedge spin, knockdowns), and (b) **validate altitude scaling for free**: same launch conditions at 0 / 2,500 / 5,000 / 7,500 ft. You have no browser UI — if the site exposes fetchable endpoints, use them politely (low volume, cache everything into the repo); otherwise emit a precise manual sampling worksheet (exact input grid, ~60–100 points) into the handoff for the owner to fill, and structure the fit to run with or without it.
3. **Sanity anchors:** PGA/LPGA tour averages; the wind-tunnel literature bounds already cited in `coefficients.ts`.

Record EVERY external data point you use into `libs/flight-model/src/fixtures/` (CSV/JSON, with source + retrieval date) so the fit is reproducible offline and testable in CI forever.

## Method (suggested; improve if you can justify)

1. Inspect/clean the measured dataset (outlier policy stated explicitly; mishits and wind-affected outdoor rows are real hazards — reason about provenance).
2. Build a replay/fit harness inside `libs/flight-model` (spec or script) that runs `simulate()` over the dataset inputs and scores carry/apex/descent/total error.
3. Fit the coefficient set (coarse grid → local refine is fine; document the loss — weight arc-shape errors ~equally with carry, NOT carry-dominant).
4. Cross-validate: hold out data; compare fitted model vs FlightScope oracle at multiple altitudes; confirm ISA density scaling reproduces the oracle's altitude deltas within tolerance.
5. Rollout: fit `rollout.ts` params only after the arc is locked (total − carry from the dataset, if present; else document as unfit).
6. Adversarial pass: try to break your own fit — extreme spin ratios, 8,000 ft driver, 40 m/s wedge; confirm no coefficient leaves physical bounds and no regime goes pathological.

## Acceptance (quantitative, in the handoff)

- Error tables (mean signed + RMS) for carry, total, apex, descent — per club-speed band (wedge / mid-iron / long / driver) and overall, before → after.
- Target: carry within ~2–3% RMS of measured truth; descent within ~2–3°; apex within ~5% — or a precise explanation of what limits it.
- Altitude validation table: model vs oracle deltas 0→7,500 ft for slow/mid/fast launch triplet.
- A worked slope example: 100-yd 60° shot vs 250-yd 5W, same +5 yd elevation, showing plays-like from the fitted arcs (this is the owner's actual use case).

## Deliverables

1. `handoff/FLIGHT_HANDOFF.md` — ≤1 page summary up top (headline errors before/after, coefficients before/after, altitude verdict, open questions), then the full tables + method + data provenance.
2. The refit code on branch `claude/flight-calibration`: updated coefficients with revised doc comments citing the fit, fixtures committed, fit harness as a maintainable spec, all `libs/flight-model` tests green, `npx tsc --noEmit -p libs/flight-model/tsconfig.json` clean.
3. Final message: headline numbers only.

## Constraints

- **Never let the fit contradict the app's data-integrity rule:** computed values stay `computed: true`; nothing pretends to be measured.
- Code style: no `any`, no `I`-prefixes, no cast-in-import, delete dead code, full implementations only. Match surrounding style; keep comment density/tone of the files you touch.
- Do not modify anything outside `libs/flight-model` + `handoff/` without strong documented cause.
- External fetches: keep volume minimal and polite; commit what you fetched (fixtures) so nothing depends on the network afterward.
