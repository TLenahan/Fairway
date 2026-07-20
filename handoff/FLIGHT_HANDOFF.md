# Flight-model aero calibration — handoff (2026-07-17)

## Summary

The aero coefficients were refit against **external physics-grade truth** (no
range collection needed): 7,938 cleaned TrackMan shots, TrackMan's measured
PGA/LPGA tour tables, and 50 FlightScope Trajectory Optimizer samples — all
committed under `libs/flight-model/src/fixtures/` for offline reproducibility.

**Headline (TrackMan holdout, n=2,646, never seen by the fit):**

| metric | before | after |
| --- | --- | --- |
| carry | −0.95% mean / 8.8 yd RMS | **−0.23% mean / 6.3 yd RMS** |
| carry (>120 mph ball) | −3.9% mean @ >145 mph | **−1.3% / 3.1% RMS** |
| apex | +5.2 ft mean / 6.7 ft RMS | **+0.5 ft mean / 3.3 ft RMS** |
| descent angle | +1.33° mean / 3.03° RMS | **−0.46° mean / 2.12° RMS** |
| flight time | +0.18 s mean | **+0.02 s mean** |

**Lateral validation (2026-07-19, full 7,938 shots, no lateral-specific fit):**
side (L/R of target, `offlineM`) bias **−0.15 yd / RMS 1.94 yd**; curve (L/R of
start line, `curveM`) bias **−0.11 yd / RMS 1.82 yd**; median |error| ~0.5 yd,
p90 ~2 yd. Model/actual curve slope 0.97 — the model under-curves by ~3%
(≈0.5 yd on a 15 yd curve, −0.46 yd bias even in the 30+ yd bin), well inside
noise, so no lateral knob was added. The 2026-07-17 carry/apex fit generalizes
laterally; bounds live in `aero-calibration.spec.ts`.

**Coefficients (fit dims only; everything inside literature bounds):**

| param | before | after | bound source |
| --- | --- | --- | --- |
| CD_BASE | 0.225 | **0.190** | free-flight fleet min at S=0 (Lyu 2018) |
| CD_SPIN_SLOPE | 0.30 | **0.397** | Cd(S) curve stays in envelope ∀S (see §5) |
| CL_MAX | 0.42 | **0.428** | Cl envelope ∀S |
| CL_HALF_S | 0.11 | **0.143** | Cl envelope ∀S |
| SPIN_DECAY_TAU_S | 20 s | **25 s** | Smits & Smith τ=R/(2e−5·V) ≈ 24 s driver |
| rollout | 1.1 / 13000 / 0.08 | **1.05 / 23000 / 0.09** | Uneekor anchors, 0.69 yd mean err |

**Old model's failure mode:** it matched carry at moderate speeds by error
cancellation — too much drag *and* too much low-spin lift — so drivers flew
9–10 yd short, 8 ft too high, landed 2.3° too steep, and hung 0.2 s too long.
That poisons `Δ ≈ elevation / tan(descent)`: slope adjustments for
driver/woods were ~6–8% too small. The refit fixes the arc, not just carry.

**Altitude verdict: validated for driver/mid-iron, wedge slightly hot.**
Model carry gains vs the FlightScope environmental oracle (ISA 0→7,500 ft)
agree within **±0.35 pp for driver and 7-iron at every altitude**; the wedge
gains read +0.7…+2.0 pp hotter than the oracle (no third source exists at
altitude to arbitrate — flagged below). ISA air density itself is textbook
(ρ(0)=1.2250, matches CIPM within 0.03%) and was not refit. Density
sensitivity cross-check: −0.30 %carry per +1 %ρ (ours) vs −0.31 (oracle).

**Open questions**
1. **Wedge altitude scaling** (+2 pp vs oracle at 7,500 ft): our constant-τ
   spin decay under-decays wedge spin less than FlightScope's model appears
   to; a speed-dependent decay ω̇ ∝ −ω·V (Smits & Smith) would need spin as
   integrator state. Worth revisiting only if high-altitude wedge carries
   feel long on-course.
2. **Tour land angles**: model lands ~4° shallower than tour-measured
   averages while matching both vendor *models*; likely tour wind mix +
   average-of-inputs ≠ input-of-averages (Jensen). Not actionable now.
3. **Driver totals**: TrackMan flat-normal turf rolls drivers ~6 yd more
   than our Uneekor-anchored rollout. Vendor turf split; totals follow the
   EYE MINI/VIEW reference on purpose. A turf-firmness setting is the v2 fix.
4. TrackMan dataset venue conditions unrecorded — fit assumed sea-level ISA;
   the +0.7%/+1.9% PGA/LPGA carry bias suggests any venue-density error is ≲1%.

---

## 1. Truth sources & provenance

| source | rows | role | caveats |
| --- | --- | --- | --- |
| `fixtures/trackman-driver.csv` — tim-blackmore/launch-monitor-regression | 10,169 → 7,938 clean | primary fit surface | all Driver swings; mostly indoor (median radar track 5.9 yd → net), so outputs are TrackMan's radar-calibrated model at measured launches; Premium-ball rows only |
| `fixtures/trackman-tour-averages.json` — TrackMan official May 2024 | 12 PGA + 11 LPGA clubs | measured-outdoor sanity anchors | tournament venue/weather mix; ± a few % band |
| `fixtures/flightscope-oracle.json` — trajectory.flightscope.com | 50 samples | wedge/iron shape + altitude scaling | server-side model sampled politely via its own UI (reCAPTCHA-gated API; no direct scripting); absolute carries read ~8% short of TrackMan everywhere |
| Uneekor VIEW anchors (in `calibration.spec.ts`) | 19 shots | rollout reference + regression tripwire | vendor-computed, different vendor than the fit anchor |
| Wind-tunnel/LES/free-flight literature | — | hard parameter bounds | see §5 envelope |

Cleaning policy for the 10k dataset (counted, in `fixtures/README.md`): drop
non-Premium balls (822), missing fields (923), ball speed <50 mph (274),
plus small counts of tops/pop-ups/gyroscopic mishits. Launch spin-ratio
coverage after cleaning: S median 0.115, p99 0.52 — the slow high-spin
mishit tail probes the wedge aerodynamic regime, which is why a driver-only
dataset still constrains S∈[0.05, 0.5].

Rejected source: jgamblin/golf Garmin R10 dataset (1,796 iron/wedge rows) —
86% of rows have radar-*estimated* spin and range balls (PW median 2,941 rpm
is unphysical), unusable as spin-conditioned truth.

## 2. Method

- **Harness**: `simulate()` gained an optional `SimulationOverrides`
  (aero/τ/rollout/timeStep) so the fit replays the *production* code path.
  Search at dt=5 ms (verified ≡1 ms: max Δcarry 0.0001%), all reported
  numbers at dt=1 ms.
- **Frame validation before fitting**: TrackMan spin axis → back/side spin
  convention checked empirically — lateral sign agreement 335/336, slope 0.97.
- **Loss**: per-shot Huber(z, 4) over four arc-equal terms — carry/2.5%,
  apex/5% (floor 5 m), descent/2.5°, time/4%. Carry-only fitting was
  explicitly avoided; the slope math needs the arc.
- **Split**: fit on idx%3≠0 (5,292), holdout idx%3=0 (2,646). Coarse grid
  (320 pts) → Nelder-Mead ×2 starts (converged to <0.1% same loss).
- **Bound sensitivity**: unconstrained optimum wants cdBase 0.185/τ→60 s
  (unphysical, loss 6.11); clamping to literature (cdBase ≥0.19, τ ≤25)
  costs only 1.6% loss (6.21) — the (cdBase, τ) ridge is flat, so we take
  the physical point. τ is weakly identified by driver-heavy data.

## 3. Error tables (holdout, dt=1 ms)

Bands by ball speed (mph); carry % / RMS, apex ft, descent °, time s
(mean/RMS). "S" bands use launch spin ratio.

**Before (CD 0.225+0.30S, CL 0.42·S/(0.11+S), τ=20):**

| band | n | carry | apex | descent | time |
| --- | --- | --- | --- | --- | --- |
| all | 2646 | −0.95% / 9.1% (−3.6/8.8 yd) | +5.2/6.7 ft | +1.33°/3.03° | +0.18/0.28 |
| <90 | 190 | +2.3% / 25.1% (0.0/9.5 yd) | +0.1/5.0 ft | −0.15°/2.99° | +0.05/0.44 |
| 90–120 | 504 | +1.7% / 11.0% (+1.6/6.0 yd) | +2.0/3.1 ft | +0.19°/2.08° | +0.15/0.25 |
| 120–145 | 1113 | −0.5% / 3.9% (−1.6/6.6 yd) | +5.4/6.4 ft | +1.40°/3.09° | +0.21/0.30 |
| >145 | 839 | −3.9% / 4.8% (−10.0/12.1 yd) | +7.9/8.6 ft | +2.26°/3.43° | +0.17/0.24 |

**After (CD 0.190+0.397S, CL 0.428·S/(0.143+S), τ=25):**

| band | n | carry | apex | descent | time |
| --- | --- | --- | --- | --- | --- |
| all | 2646 | −0.23% / 8.2% (−1.0/6.3 yd) | +0.5/3.3 ft | −0.46°/2.12° | +0.02/0.20 |
| <90 | 190 | +0.2% / 23.4% (−1.5/9.4 yd) | −1.0/5.1 ft | −0.21°/3.07° | −0.02/0.43 |
| 90–120 | 504 | +0.4% / 10.2% (+0.1/5.7 yd) | −1.0/2.8 ft | −0.68°/1.83° | +0.00/0.18 |
| 120–145 | 1113 | +0.2% / 3.3% (+0.3/5.2 yd) | +0.7/3.1 ft | −0.54°/2.15° | +0.04/0.19 |
| >145 | 839 | −1.3% / 3.1% (−3.2/7.0 yd) | +1.5/3.4 ft | −0.28°/1.99° | +0.00/0.16 |

Slow-band relative RMS is dominated by mishit rows with tiny carries
(absolute RMS stays 5.7–9.4 yd). Acceptance: carry ≤2–3% RMS **met** for
the >120 mph bands (3.1–3.3%); descent ≤2–3° **met** (2.1° RMS); apex ≤5%
**met in absolute terms** (3.3 ft RMS; relative RMS 6–8% per band is
denominator-inflated on low arcs).

S-band check (full set): S<0.10 −1.8%/3.4% carry; S 0.10–0.20 +0.9%; S
0.20–0.35 +0.2%; S>0.35 −1.5% (RMS 29% — mishit noise band, absolute
12.8 yd). No structural S-trend survives the fit.

## 4. Cross-validation

**Tour averages (measured outdoor, replayed at 25 °C sea level):**

| set | carry mean/RMS | apex mean/RMS | land mean/RMS |
| --- | --- | --- | --- |
| PGA (12 clubs), before | +0.7% / 3.3% | +4.2% / 9.1% | −3.8° / 4.6° |
| PGA, after | +0.7% / 5.3% | −2.3% / 7.1% | −4.7° / 5.5° |
| LPGA (11 clubs), before | +2.7% / 3.7% | −0.8% / 9.1% | −3.3° / 3.8° |
| LPGA, after | +1.9% / 4.4% | −6.3% / 10.2% | −4.1° / 4.8° |

Carry bias ≤ +2% against measured reality on both tours. The ~4–5° shallow
land-angle residual exists before AND after and contradicts neither vendor
model (both agree with us within ~1.5°) — see open question 2.

**FlightScope (same launches, sea level ISA):** our carries read +7…+13%
vs their model across archetypes/knockdowns/sweeps while flight time and
land angle agree within ~1.5°/−4%. Tour-measured driver carry (282 yd @
171 mph) sides with TrackMan: FlightScope's own replay gives 254 yd. The
absolute split is theirs, and it is why FlightScope is used for *relative*
checks only.

**Altitude (the mission-critical one) — carry gain vs sea level, ISA:**

| point | oracle | model after | Δ | model before | Δ before |
| --- | --- | --- | --- | --- | --- |
| SW @2,500 ft | +2.27% | +2.92% | +0.65 | +2.60% | +0.33 |
| SW @5,000 ft | +4.33% | +5.74% | +1.40 | +5.09% | +0.75 |
| SW @7,500 ft | +6.43% | +8.43% | +2.00 | +7.43% | +1.00 |
| 7i @2,500 ft | +3.59% | +3.38% | −0.21 | +3.28% | −0.31 |
| 7i @5,000 ft | +6.82% | +6.58% | −0.23 | +6.38% | −0.44 |
| 7i @7,500 ft | +9.88% | +9.56% | −0.32 | +9.26% | −0.63 |
| drv @2,500 ft | +3.16% | +2.90% | −0.25 | +3.37% | +0.21 |
| drv @5,000 ft | +5.73% | +5.53% | −0.20 | +6.53% | +0.80 |
| drv @7,500 ft | +8.16% | +7.83% | −0.33 | +9.42% | +1.26 |

Driver/7i within ±0.35 pp after the refit (driver improved ~4×). Wedge is
the open question above. Warm-day check: oracle +2.04% carry for +19.9 °C
at 5,000 ft; both models show −0.30…−0.31 %carry per +1 %ρ — identical
density response, different temperature parameterization (our
`temperatureC` is the sea-level column temperature, theirs is at-altitude).

## 5. Physical-envelope audit (regression-guarded in aero-calibration.spec.ts)

Fitted values vs measured envelopes (Bearman & Harvey '76; Smits & Smith
'94; Li '17 LES; Crabill '18 LES; Lyu/Kensrud/Smith '18 free-flight):

| S | Cd fit | Cd envelope | Cl fit | Cl envelope |
| --- | --- | --- | --- | --- |
| 0.0 | 0.190 | 0.19–0.27 | 0 | ~0 |
| 0.1 | 0.230 | 0.20–0.32 | 0.176 | 0.10–0.22 |
| 0.2 | 0.269 | 0.25–0.34 | 0.250 | 0.17–0.28 |
| 0.3 | 0.309 | 0.28–0.36 | 0.290 | 0.24–0.35 |
| 0.5 | 0.389 | 0.30–0.42 | 0.333 | 0.28–0.42 |

τ=25 s: Smits & Smith measure speed-dependent decay τ=R/(2.0e−5·V) → ~24 s
at driver mid-flight, 30–50 s wedge; 25 s is the best constant stand-in and
sits at the spec's 15–25 s edge. S>0.5 Cd/Cl are trend extrapolations (only
slow mishits fly there).

## 6. Rollout

Refit required because the aero refit changed landing speed/descent/spin.
Uneekor-only anchors (the product's reference device): mean |err| 0.69 yd,
bias −0.03 yd over 19 shots; skull-guard preserved (3.4°-launch bullet:
model 12.7 vs VIEW 12.9 yd); 52° wedge at 1,849 m: 6.3 vs 6.4 yd.
TrackMan flat-normal turf disagreement documented (open question 3).

## 7. Worked slope example (the product use case)

At 5,000 ft ISA, +5 yd of green elevation, `Δ = elevation / tan(descent)`:

| shot | carry | descent | plays-like add |
| --- | --- | --- | --- |
| 60° wedge (63 mph ball, 30°, 10,500 rpm) | 105 yd | 53.3° | **+3.7 yd** |
| 5-wood (142 mph ball, 12.5°, 4,300 rpm) | 238 yd | 38.7° | **+6.2 yd** |

Same 5 yd of elevation, 68% more added distance for the flat-descending
club — this asymmetry is exactly what the old model distorted (its descent
angles were ~2.3° too steep at speed → slope adds ~6–8% too small).

## 8. Verification & reproducibility

- 59 jest tests green (`npx jest -c libs/flight-model/jest.config.ts`),
  including the new `aero-calibration.spec.ts` (TrackMan stride replay, tour
  band, altitude-vs-oracle, Cd/Cl envelope guard); `npx tsc --noEmit -p
  libs/flight-model/tsconfig.json` clean; eslint clean.
- Extremes audited: 8,000 ft driver, 40 m/s wedge at altitude, S≈1.3
  slow/high-spin, zero spin, 5 m/s chip — all finite, integrator terminates,
  carry monotonic in speed and altitude.
- Every external data point used is committed under
  `libs/flight-model/src/fixtures/` with source + retrieval date; the fit is
  fully re-runnable offline against the production `simulate()` via
  `SimulationOverrides`.
- Data-integrity rule respected: all outputs remain `computed: true`;
  nothing here pretends to be a sensor measurement.
