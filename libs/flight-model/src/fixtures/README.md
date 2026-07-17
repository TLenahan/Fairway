# Flight-model calibration fixtures

External truth data used to fit and validate the aero coefficients
(`coefficients.ts`, `spin.ts`, `rollout.ts`). Everything here was fetched on
2026-07-17 and committed so the calibration is reproducible offline. All values
are external measurements or vendor-model outputs — never confuse them with
sensor data from this app (`computed: true` stays computed).

## trackman-driver.csv

TrackMan launch-monitor dataset from
<https://github.com/tim-blackmore/launch-monitor-regression> (`data.csv`,
10,169 rows, all Driver, mixed ball types, indoor + some outdoor capture).
TrackMan measures the launch (ball speed, launch angle/direction, spin rate,
spin axis) and — indoors, where the median tracked flight is ~6 yd into a net —
computes carry/apex/land-angle/time with its radar-calibrated flight model. So
rows are best treated as TrackMan-model *oracle* points at measured, realistic
launch conditions, not fully radar-tracked flights (`lastTrackYd` preserves the
tracked length per row; ~1,100 rows tracked > 50 yd).

Columns: `ballSpeedMph, launchDeg, launchDirDeg, spinRpm, spinAxisDeg, carryYd,
carrySideYd, apexFt, apexDistFt, landAngleDeg, flightTimeS,
landingBallSpeedMph, totalYd, lastTrackYd`. Carry is "Carry Flat – Length"
(flat-ground carry), side is the lateral landing coordinate.
Back/side spin decompose as `spin·cos(axis)` / `spin·sin(axis)`.

Cleaning policy (10,169 → 7,938 rows, counted drops):

| dropped | rule |
| ---: | --- |
| 923 | missing/unparseable required field (mostly spin axis) |
| 822 | ball ≠ "Premium" (limited-flight/soft range balls fly differently) |
| 274 | ball speed < 50 mph (topped/chipped mishits) |
| 96 | apex < 3 ft |
| 73 | carry < 20 yd |
| 16 | flight time < 0.5 s |
| 15 | \|spin axis\| > 80° (near-gyroscopic mishit) |
| 12 | launch angle outside [0°, 45°] |

Launch spin-ratio coverage S = r·ω/V: p25 0.087, median 0.115, p75 0.168,
p99 0.52 — the high-spin tail (slow, spinny mishits) probes the wedge regime.
Venue altitude/temperature are not recorded; the fit assumes sea-level ISA and
the residual carry bias is cross-checked against the other two sources below.

## trackman-tour-averages.json

TrackMan official PGA/LPGA per-club tour averages (May 2024 update), read from
TrackMan's own full-resolution table graphics. Radar-measured **outdoor**
averages across venues/weather — used as sanity anchors (± a few percent), not
fit targets. 12 PGA + 11 LPGA clubs: ball speed, launch, spin, max height,
land angle, carry.

## flightscope-oracle.json

50 trajectories sampled from the FlightScope Trajectory Optimizer
(<https://trajectory.flightscope.com>) through its own web UI: club archetypes
LW→driver, knockdowns, high-spin extremes, spin/launch/speed sweeps, and the
same three launches (SW / 7i / tour driver) at ISA 0 / 2,500 / 5,000 / 7,500 ft
plus one warm-day 5,000 ft point. Independent radar-vendor physics; absolute
carries run several percent shorter than TrackMan for identical launches (their
models disagree — documented in `handoff/FLIGHT_HANDOFF.md`), so its role here
is relative altitude scaling and wedge-regime arc shape, not absolute carry.
