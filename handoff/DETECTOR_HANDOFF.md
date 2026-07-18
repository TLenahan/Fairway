# HackMotion Swing Detector — Rework Handoff

**Status: acceptance met on all committed captures, chips included.** 60/60
launch-monitor-confirmed shots with wrist coverage detected and joined — 39
full/partial swings plus all 21 chips/bump-and-runs down to a 2.4 m duff
(zero false negatives); zero detections on the negatives session (zero false
positives); putts deliberately below the detection floor.
`capture-replay.spec.ts` locks these numbers in CI.

## Headline results (default `SwingDetectorOptions`, join window ±1.5 s)

| | count |
|---|---|
| True positives (wrist swing ↔ Mini shot) | **60 / 60** |
| — full/partial swings (wedge/7i/driver) | 39 / 39 |
| — chips & bump-and-runs (2.4–31 m) | 21 / 21 |
| False negatives (covered Mini shot, no swing) | **0** |
| False positives (negatives session) | **0** |
| Putt labels ignored (by design, see floor analysis) | 5 |
| Practice swings (hitting context, no ball — correct behavior) | 18 |
| Label-only shots skipped (sensor dead, no wrist data) | 88 |

Join latency (Mini label − wrist impact zone): **+0.15 … +0.90 s** across all
60 (median ≈ +0.55 s; chips +0.38 … +0.67 s). The ±1.5 s window has ≥ 0.6 s
of margin on both sides. The Mini's processing latency previously measured
(~0.5–0.8 s) is confirmed.

## The algorithm that shipped

`SwingDetector` is a hold-free phase machine over a **pending-queue** that can
*rewind*: buffered samples re-enter the machine when a candidate turns out to
have mis-framed the motion. Everything below was forced by a specific failure
in the captures — none of it is speculative.

1. **Envelope**: smoothed (80 ms, device-time window) absolute angular rate,
   max of both IMUs. Hinge rate is never used for detection (lag-held swings,
   waggles).
2. **Anchoring**: a takeaway triggers when the envelope crosses `enterDegS`
   (100 °/s) out of a lull; the anchor is the **deepest lull in the trailing
   1 s**, and the address pose is the averaged sub-`stillDegS` window before
   it. Consecutive rehearsal swings re-anchor in the 24–54 °/s lulls between
   them (measured on the wedge session's swish-swish-hit chains).
3. **Swing angle θ**: signed magnitude of the **cumulative world-frame
   rotation-vector sum** of the hand IMU, sign = projection on the takeaway
   direction (frozen after ~25°). No 180° geodesic fold; stays monotone when
   the backswing's rotation axis drifts (the +530.7 s wedge shot's rerouted,
   wristy backswing broke a fixed-axis projection; the vector sum handled it —
   and the downswing cancels the sum back through ~0 at the impact zone even
   when the *pose* at impact sits 90–120° from address, which it really does).
4. **Top** = θ reversal by `reversalMarginDeg` past `minTopDeg` (15°,
   machinery floor). Dwell inside `topEpsDeg` = top pause. **Impact zone** =
   θ crossing back through 0, coincident with peak speed. **Finish** = quiet,
   or a finish-reversal rebound (enables chained swings), followed by a 0.5 s
   **confirm hold** — if the envelope surges past 1.2× the candidate's own
   peak inside it, the "swing" closed on fidget while the real one was still
   coming → rewind and retry.
5. **Rewind-and-retry (`dieWithRetry`)**: when a candidate dies (timeout,
   failed gates, surge), it re-anchors at the deepest lull inside its lifetime
   that lies **before its fastest moment** — preferring lulls whose pose sits
   near the last learned address. Both constraints are load-bearing: the
   global-min lull is usually the post-impact settle (after the shadowed
   swing), and the deepest pre-peak lull is often the transition dip at the
   top (which frames the downswing as a climb).
6. **Trough re-anchor**: an unproven candidate whose envelope fell into a
   relative trough (< `relLullDegS`, < 0.6× its running max, pose near
   address) and surged back out re-anchors at the trough — this is how swings
   rising out of continuous 100–300 °/s pre-shot shuffle (never below the
   enter gate for 1.6 s) get a clean frame.
7. **Address learning**: `lastAddressQB` updates only from *idle* holds
   (≥ 800 ms, away from the finish pose), a candidate's own anchor when it was
   still (< 30 °/s), and each valid swing's proven address. A pause-at-the-top
   drill holds still mid-candidate and must never redefine "address" — that
   poisoning broke pause detection until the idle gate was added.
8. **Re-address vs pause-at-top**: sustained sub-`stillDegS` dwell mid-
   backswing aborts the candidate only if the pose is near the last address
   (club lowered / re-grip) or nothing swing-like happened; a dwell far from
   address is a top pause and stays armed.
9. **Clock discipline**: all durations on the unwrapped `tsA` (64 kHz). A
   host-clock gap > 1 s is a stream break: in-flight state aborts, the unwrap
   resyncs (the driver session's real 34.5 s BLE outage wraps `tsA` ~34×
   unobserved — timing across it would be garbage).
10. **Chip band** (added with the labeled chip capture): a candidate whose top
   is below the full-band floor validates instead through θmax ≥ 15°, peak ≥
   250 °/s, AND impact-neighborhood shock ≥ 6000 lsb. Sub-full amplitudes
   overlap putts/waggles/handling kinematically — only strokes that disturbed
   the IMU hard (ball/turf) validate. Shock here is an impact-PLAUSIBILITY
   floor, never a contact claim: the Mini join remains the only ball truth.
   Costs, quantified below in the floor analysis.
11. **Shock-triggered rescan**: a shock spike ≥ 6000 with no swing in flight
   (idle/backswing) rewinds 2.5 s and reprocesses at a 45 °/s enter gate —
   a duffed bump-and-run's whole backswing can run below the normal 100 °/s
   trigger. Re-analysis trigger only; 2 s cooldown.
12. **Peak/shock tracking is impact-windowed**: after the impact zone, the
   downswing peak and impact shock only update within `maxPeakLagMs` — the
   golfer raking the next ball one second after a chip must not update the
   swing's "peak" (it was failing the coincidence gate on 4 real chips).
13. **Small-stroke frame protection**: sub-top wiggles inside a STILL-anchored
   frame restart the climb in place instead of abandoning the anchor; a wrong
   takeaway-direction guess flips the θ sign once instead of dying (pre-shot
   fidget freezes the sign opposite to a tiny stroke); the trough re-anchor
   requires θ ≤ 20° (at chip scale the pose stays near address through the
   whole backswing, so the pose test alone would cannibalize the frame); the
   time-based axis freeze needs ≥ 12° accrued so drift cannot claim the axis.

### Validation gates (finalize)

A candidate validates through the FULL band or the CHIP band, plus the
common gates (coincidence, tempo, follow-through, ratio) — values = defaults:

| gate | default | rationale (data) |
|---|---|---|
| `minTopValidDeg` (full band) | **140°** | full/partial shots: θmax 225–287°; tallest negatives-session motion: 77°. Smaller strokes go through the chip band. |
| `minPeakDegS` (full band) | 450 °/s | weakest full shot (topped driver) peaks 1051; putts ≤ 320. |
| `chipMinTopDeg` (chip band) | 15° | labeled chips θmax ~20–150 (the 2.8 m duff's true backswing is ~15–25°); machinery `minTopDeg` matches it |
| `chipMinPeakDegS` (chip band) | 250 °/s | labeled chips peak 272–920; putts ≤ 320 overlap — shock separates |
| `chipShockLsb` (chip band + rescan) | 6000 lsb | ball/turf-struck chips: impact shock 7351–15999; ALL non-contact motion in every capture (putts ≤ 2605, walking ≤ 4171, air practice chips ≤ 4682): ≥ 1.28× margin each way |
| `maxPeakLeadMs` / `maxPeakLagMs` | 700 / 400 ms | impact zone must coincide with peak speed. Real-shot peak-to-impact offsets: −404 … +78 ms. The junk candidate that consumed the +530.7 s swing read +1290 ms. |
| `minFollowDeg` | 8° | follow-through must pass address; real shots reach −29 … −245°. One real shot measured −11° under an older θ (gate was 12 and cost a shot — hence 8). |
| `downswingSpeedRatio` | 0.5 | near-vestigial. The compressed punch swing (+548.4 s) has backswing/downswing peaks 1804/1078 in its (mis-binned) frame — any ratio ≥ 0.6 kills a real shot. FP separation moved to `minTopValidDeg`. |
| `minBackswingMs` / `maxBackswingMs` | 150 / 3000 | real range 388–890 ms after θ-small trimming (the backswing is measured from the last time θ ≤ 15°, so pre-shot fidget inside the frame isn't billed as backswing) |
| `minDownswingMs` / `maxDownswingMs` | 80 / 700 | real range 246–442 ms |

## Per-category results

| category | shots covered | recall | peak °/s | backswing ms | downswing ms |
|---|---|---|---|---|---|
| 60° wedge (50–112 m) | 12 | 12/12 | 1585–2255 | 602–888 (one 2347*) | 290–442 |
| 56° wedge (67–132 m) | 8 | 8/8 | 1078–2400 | 388–839 | 291–375 |
| 7-iron (0–221 m, incl. topped + 6 m shank) | 15 | 15/15 | 1861–2195 | 741–818 | 246–331 |
| Driver (50–232 m, incl. two mishits) | 4 | 4/4 | 1051–1917 | 779–809 | 303–414 |
| 60° chips / bump-runs (2.4–9 m) | 7 | 7/7 | 370–695 | 424–640 | 316–435 |
| PW chips (19–31 m) | 6 | 6/6 | 802–920 | 660–769 (one 1510) | 308–422 |
| 7i bump-and-runs (2.8–7 m) | 8 | 8/8 | 272–522 | 354–632 | 345–494 |
| Putts | 5 | **ignored by design** | 87–320 (one never exceeded 80) | — | — |

\* the +563.1 s frame includes pre-shot shuffle; the join is clean (Δ 0.39 s)
but its `backswingMs` overstates. Same caveat on the punch swing's
`peakAngularSpeedDegS` (1078 reported; envelope peak 1804 — the reversal-lag
mis-binning is inherent when the reversal confirms after the true impact).

**False negatives: none.** **False positives: none.** The one FP that appeared
during tuning (walking motion at +23.6 s of the putt session, θmax 77°,
peak 590 °/s, shock 2409) is rejected in both bands: below the full-band top
floor AND below the chip-band shock floor.

## Detection-floor analysis

- **The floor is now defined by CONTACT PLAUSIBILITY, not amplitude.** Chips
  down to a 2.4 m duff overlap putts/waggles/handling on every kinematic axis
  we measured (peak, top angle, tempo). What separates them in the data is the
  impact-neighborhood shock: ball/turf strikes read 7351–15999 lsb; the
  loudest non-contact motion anywhere in the captures reads 4682. The chip
  band admits sub-140° strokes only above 6000 lsb.
- **Putts remain below the floor by design.** Putt strokes peak at 87–320 °/s
  (one never exceeded 80) with shock ≤ 2605 — kinematically inseparable from
  handling AND below the shock floor. The Mini alone reports them; the 5 putt
  labels are excluded from the recall denominator and asserted undetected in
  `capture-replay.spec.ts`.
- **Quantified costs of the shock-gated low band:**
  1. *Low-amplitude practice swings without ground contact are not detected*
     (θ < 140° and shock < 6000 — e.g. three air practice chips in the chip
     session, shock 1753–4682, correctly not reported). Full-scale practice
     swings are unaffected (validated by θ alone).
  2. *A putt struck hard enough to saturate shock could register as a swing.*
     Not observed (putt shocks ≤ 2605), but a firm putt off a mat may differ —
     needs a putt-heavy negatives capture to bound.
  3. *Address taps* (soling the club hard behind the ball) are an untested
     shock source. No tap in any capture reached 6000, but no session was
     recorded specifically to stress this. The structural gates (backswing →
     top → crossing at speed, coincidence, follow-through) still have to pass,
     so a tap alone cannot validate — but tap-then-waggle patterns should be
     in the next negatives session.

## Caveats / notes for the integrating engineer

- **Phase-event stream**: `takeaway`/`top`/`impactZone` only emit once a
  candidate exceeds ~30° (`emitTakeawayDeg`) — walking/fidget emits nothing,
  and sub-30° chip-band strokes surface as swing events alone (no phases). `aborted` closes
  any candidate that had emitted `takeaway`. Rewinds can emit events whose
  `tMs` step backwards briefly (a retried candidate re-announces takeaway with
  an earlier underlying sample); consumers should key on event order, not
  wall-clock monotonicity. `finish` (and `onSwing`) can trail the impact zone
  by up to ~0.5 s when the finish-reversal path takes the confirm hold.
- **`addressHeldMs` may be 0** — detection is hold-free. The drill GO cue
  (`WristHold.armed`) still requires `holdRequiredMs` of stillness away from
  the finish pose, exactly as before.
- **CPU**: the rewind machinery replays ≤ 5 s of buffered samples per retry
  and retries advance strictly forward; pathological shuffle produced ~8
  chained retries (~2k quaternion ops) worst-case in the captures — noise on
  any phone.
- The three v1 captures (no labels) contain full-speed test swings, not
  negatives; they are smoke-tested for non-crashing and plausible detections
  only.

## Open questions / requested data

1. **A dedicated negatives session**: club pickups, teeing up, re-grips,
   walking with the club, practice waggles, and — now specifically — hard
   address taps and firm mat putts (the shock-floor stressors). Today's only
   true negatives set is the putting session.
2. **Pitches at 20–60 m** — the gap between the chip band's 31 m ceiling and
   the full band's 50 m floor is uncovered by labels (such shots should pass
   the full band comfortably, but data beats belief).
3. **A held-drill session** (hold ≥ 1.5 s → GO → swing) to validate the
   drill-mode arming UX end-to-end on real data.
4. Left-handed golfer capture would validate that nothing silently assumes
   handedness (θ is sign-symmetric by construction, but data beats belief).
