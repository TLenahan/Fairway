# HackMotion Swing Detector — Rework Handoff

**Status: acceptance met on all committed captures.** 39/39 launch-monitor-confirmed
shots with wrist coverage detected and joined (zero false negatives); zero
detections on the negatives session (zero false positives); putts deliberately
below the detection floor. `capture-replay.spec.ts` locks these numbers in CI.

## Headline results (default `SwingDetectorOptions`, join window ±1.5 s)

| | count |
|---|---|
| True positives (wrist swing ↔ Mini shot) | **39 / 39** |
| False negatives (covered Mini shot, no swing) | **0** |
| False positives (negatives session) | **0** |
| Putt labels ignored (by design, see floor analysis) | 5 |
| Practice swings (hitting context, no ball — correct behavior) | 17 |
| Label-only shots skipped (sensor dead, no wrist data) | 88 |

Join latency (Mini label − wrist impact zone): **+0.15 … +0.90 s** across all
39 (median ≈ +0.55 s). The ±1.5 s window has ≥ 0.6 s of margin on both sides.
The Mini's processing latency previously measured (~0.5–0.8 s) is confirmed.

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
4. **Top** = θ reversal by `reversalMarginDeg` past `minTopDeg` (45°,
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

### Validation gates (finalize)

A candidate becomes a `WristShot` only if ALL hold (values = defaults):

| gate | default | rationale (data) |
|---|---|---|
| `minTopValidDeg` | **140°** | joined real shots: θmax 225–287°; tallest negatives-session motion: 77°; junk fragments 48–130°. ~1.6× margin both ways. **Re-derive when chip captures land — chips are expected at 75–130° and WILL need this lowered plus a compensating gate.** |
| `minPeakDegS` | 450 °/s | weakest real shot (topped driver) peaks 1051; putts ≤ 320. Deliberately loose — `minTopValidDeg` does the separating today, leaving headroom for chips. |
| `maxPeakLeadMs` / `maxPeakLagMs` | 700 / 400 ms | impact zone must coincide with peak speed. Real-shot peak-to-impact offsets: −404 … +78 ms. The junk candidate that consumed the +530.7 s swing read +1290 ms. |
| `minFollowDeg` | 8° | follow-through must pass address; real shots reach −29 … −245°. One real shot measured −11° under an older θ (gate was 12 and cost a shot — hence 8). |
| `downswingSpeedRatio` | 0.5 | near-vestigial. The compressed punch swing (+548.4 s) has backswing/downswing peaks 1804/1078 in its (mis-binned) frame — any ratio ≥ 0.6 kills a real shot. FP separation moved to `minTopValidDeg`. |
| `minBackswingMs` / `maxBackswingMs` | 150 / 3000 | real range 388–890 ms after θ-small trimming (the backswing is measured from the last time θ ≤ 15°, so pre-shot fidget inside the frame isn't billed as backswing) |
| `minDownswingMs` / `maxDownswingMs` | 80 / 700 | real range 246–442 ms |

## Per-category results

| category | shots covered | recall | peak °/s | backswing ms | downswing ms | top θ |
|---|---|---|---|---|---|---|
| 60° wedge (50–112 m) | 12 | 12/12 | 1585–2255 | 602–888 (one 2347*) | 290–442 | 225–266° |
| 56° wedge (67–132 m) | 8 | 8/8 | 1078–2400 | 388–839 | 291–375 | 234–287° |
| 7-iron (0–221 m, incl. topped + 6 m shank) | 15 | 15/15 | 1861–2195 | 741–818 | 246–331 | 237–267° |
| Driver (50–232 m, incl. two mishits) | 4 | 4/4 | 1051–1917 | 779–809 | 303–414 | 233–263° |
| Putts | 5 | **ignored by design** | 87–320 (one never exceeded 80) | — | — | — |
| Chips / bump-and-run | **0 — no wrist-covered labels exist** | — | — | — | — | — |

\* the +563.1 s frame includes pre-shot shuffle; the join is clean (Δ 0.39 s)
but its `backswingMs` overstates. Same caveat on the punch swing's
`peakAngularSpeedDegS` (1078 reported; envelope peak 1804 — the reversal-lag
mis-binning is inherent when the reversal confirms after the true impact).

**False negatives: none.** **False positives: none.** The one FP that appeared
during tuning (walking motion at +23.6 s of the putt session, θmax 77°,
peak 590 °/s) is what pinned `minTopValidDeg` = 140°.

## Detection-floor analysis

- **Putts are indistinguishable from waggles/handling on this sensor.** Putt
  strokes peak at 87–320 °/s with 20–224° of total hand travel; handling and
  walking motion in the same session reaches 780 °/s and 1167° of travel.
  There is no wrist-only gate that admits putts and rejects handling —
  detecting putts would violate the zero-FP requirement. Decision: **putts are
  below the floor; the Mini alone reports them.** The 5 putt labels are
  excluded from the recall denominator on that basis (they are asserted
  undetected in `capture-replay.spec.ts`).
- **Today's floor** sits between 77° (tallest non-swing) and 225° (smallest
  real swing) of validated top angle, i.e. the gate at 140° has ≥ 1.6× margin
  each way on the current data.
- **Chips/bump-and-runs are the open flank.** The PW chips (13–37 m) in the
  wedge session all fell after the sensor died, so zero labeled chip swings
  exist. Prior raw-signal study puts chip tops at ~75–130° — inside today's
  rejection band. When chip captures arrive, `minTopValidDeg` must come down
  and the FP margin re-established from (probably) peak-speed + tempo + the
  coincidence gate. Do not ship chips support without a fresh negatives
  session recorded the same day.

## Caveats / notes for the integrating engineer

- **Phase-event stream**: `takeaway` only emits once a candidate exceeds
  ~30° (`emitTakeawayDeg`) — walking/fidget emits nothing. `aborted` closes
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

1. **Chips & bump-and-runs with labels** — the low floor cannot be tuned
   without them (see above). Also pitches at 20–50 m.
2. **A dedicated negatives session**: club pickups, teeing up, re-grips,
   walking with the club, practice waggles — recorded as a session with zero
   Mini shots. Today's only true negatives set is the putting session.
3. **A held-drill session** (hold ≥ 1.5 s → GO → swing) to validate the
   drill-mode arming UX end-to-end on real data.
4. Left-handed golfer capture would validate that nothing silently assumes
   handedness (θ is sign-symmetric by construction, but data beats belief).
