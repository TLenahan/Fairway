# Fable Ultracode Agent — HackMotion Shot-Detection Algorithm

You are a **Fable model running in ultracode mode**. Optimize for the most exhaustive, correct result — token cost is not a constraint. Use adversarial self-verification and loop until the acceptance bar is met or you have precisely characterized why a residual case is irreducible.

## Mission

Build the swing/shot-detection algorithm for a golf app's **HackMotion wrist sensor** (a BLE dual-IMU unit worn on the lead wrist). This is the app's **primary shot detector**. The bar is absolute:

- **Zero missed real shots** (100% recall on launch-monitor–confirmed shots).
- **Zero false positives** (no detection on waggles, club pickups, walking, re-grips, teeing up, or idle).

These pull against each other; getting both is the entire challenge. You have real, ground-truth-labeled range data to tune and validate against — use it relentlessly.

## Two hard rules (non-negotiable, from the product owner)

1. **Never infer ball contact from the wrist.** The wrist detects a *swing*; only the launch monitor confirms a *ball was struck*. The "impact zone" you compute is a swing-geometry landmark and a join key — never a claim of contact.
2. **Never treat a practice swing as a real shot.** A detected swing that does NOT join a launch-monitor shot is a practice/rehearsal swing. It should still be *detected as a swing*, but nothing downstream may treat it as a ball-strike.

## The three-way classification (read carefully — this defines success)

For every wrist swing the detector emits, and every launch-monitor ("Mini") shot label in the data:

- **True positive:** a detected swing that joins a Mini shot (impact within the join window). **Every Mini shot MUST have one. A Mini shot with no detected swing is a FALSE NEGATIVE — the cardinal sin. Target: 0.**
- **Practice swing:** a detected swing with no nearby Mini shot, occurring in a *hitting* context. This is **correct** — detect it, label it practice. NOT an error. Do not suppress these.
- **False positive:** a detected swing during a *negatives* session or clear idle (waggle, pickup, walk, re-grip, tee-up). **Target: 0.**

The distinction between "practice swing" (fine) and "false positive" (bad) is context, so score them separately:
- Measure **false negatives** across ALL captures (every Mini shot must be caught).
- Measure **false positives** strictly on the **negatives-only session(s)** and on long idle stretches (where the golfer is provably not swinging).

## Repo orientation

You are in a golf-app monorepo (Nx/yarn workspaces). The wrist code lives in `libs/wrist/src/`:

- `record-codec.ts` — `parseFrame(bytes)` decodes a raw 0x90 BLE frame into records (quaternions + motion channels); `shockOf(record)` = max|channel|.
- `quaternion.ts` — quaternion/rotation helpers (`rotationAngle`, `quatToRotVec`, `qMul`, `qConj`, `relativeQuat`, `markleyAverage`, `RAD_TO_DEG`, etc.). w-first Hamilton convention.
- `calibration.ts` — anatomical calibration (`calibrateFlatRaise`, `anatomicalAnglesDeg`). Angles are meaningful only when a capture was recorded with calibration applied.
- `swing-detector.ts` — **the file you are rewriting.** Currently an "address-armed phase machine" that (incorrectly) REQUIRES a still address hold before it will detect. `detectSwings(samples, options, {holds, phases})` is the batch entry point.
- `replay.ts` — **your harness.** `parseCapture(text)` → `{meta, samples, shots, contexts}`; `replayCapture(parsed, options, joinWindowMs)` runs the detector and joins detected swings to Mini shot labels, returning `{swings:[{swing, matchedShot}], unmatchedShots, holds, phases}`. `unmatchedShots` = false negatives.
- Types/contracts: `libs/types/src/wrist.ts` (`WristShot`, `WristKeyframe`, `WristHold`, `WristPhaseEvent`, `WristCalibration`). Extend if needed but keep consumers compiling.

Run things (ALWAYS from this worktree, not main — see Environment):
- Typecheck: `npx tsc --noEmit -p libs/wrist/tsconfig.json`
- Test: `npx jest --config libs/wrist/jest.config.ts`
- Replay a capture in a throwaway spec: `parseCapture(readFileSync('captures/<file>.ndjson','utf8'))` then `replayCapture(...)`. Delete throwaway specs before finishing.

## Data format (v2 NDJSON, in `captures/*.ndjson`)

One host clock (`Date.now()` ms) across all line types:
- `{"type":"meta", formatVersion:2, startedAtMs, ...}` — one header.
- `{"type":"frame", t, d}` — `d` is base64 of a raw 46-byte HackMotion record. Decode with `parseFrame`. ~one record per frame.
- `{"type":"context", t, calibrated, club:{id,name,category,loftDeg}|null}` — active club + whether calibration is applied. Emitted at start and on every club change.
- `{"type":"shot", t, shotGuid, clubId, carryM, ballSpeedMs}` — a launch-monitor shot that landed during recording. **This is the ground-truth label.** A wrist swing whose impact time is within ~1.5 s of a `shot` struck a ball.

## Sensor facts (verified against real captures — do not re-derive, but DO re-confirm on the new data)

- **Sample rate is variable, ~41–50 Hz** (not fixed). Never assume a fixed rate; time everything off the device clock.
- **Device clock:** each record carries `tsA`, a u16 at **64000 Hz** that wraps (~every 1.02 s). Unwrap it (the detector already does). Within a continuous frame stream it is perfectly synced (host/device span ratio ≈ 1.000). **All swing-phase durations MUST be timed on this device clock, never on BLE arrival time** — arrival is batched/jittery.
  - **BUT: a large frame outage breaks the unwrap.** A real capture has a **34.5 s gap** (BLE stall/reconnect during idle) — the u16 wrapped ~34× unobserved, so the naive unwrap under-counts and the whole-session ratio reads ~1.07 instead of 1.000. **Detect a host-time gap (> ~1 s between consecutive frames) and treat it as a clock-resync boundary:** reset the detector to idle across it and do not trust device-time deltas that span it. Timing within each continuous segment is exact; timing across a gap is not. (In the sample this gap fell in idle so no swing spanned it, but do not assume that always holds.)
- **Two IMUs:** `qA` = forearm, `qB` = hand (both absolute orientations, w-first, de-scaled from Q14). `relativeQuat(qA,qB)` = the wrist hinge.
- **`shock`** = max|motion channel|, **saturates near 16384 on hard contact** (turf/ball). Useful *context* only — per hard rule #1, never use it to assert contact.

## Findings you MUST build on (each cost a real debugging cycle — do not rediscover)

1. **The geodesic angle from address FOLDS at 180°.** A full swing rotates the hand IMU past a half-turn, so a geodesic "rotation from address" maxes at 180 and folds back — the top vanishes. On real data, chips read ~75–130° but full/driver swings pinned at 180. **Fix: use an UNWRAPPED, SIGNED swing angle** — establish the swing axis from the incremental rotation over the first ~200–250 ms of takeaway, then integrate incremental rotation projected onto that axis. This passes through 180° cleanly. Validated: unwrapped gave ~75° chips → ~240° full swings, monotonic through the backswing.
2. **The address HOLD must NOT be mandatory for detection.** Golfers hit naturally without holding still first. The current detector requires a ~1.5 s hold and therefore detected **0 swings** on a real hitting session. **Detection must trigger on the swing envelope alone**, freezing the address reference from whatever brief quiescence precedes the takeaway. The hold is a **DRILL-MODE-ONLY** enhancement (it enables a "hold still → GO" cue and a clean pre-swing angle snapshot). Keep the hold path, but as an optional layer, not a gate.
3. **Trigger on ABSOLUTE IMU rate** (max angular speed of qA and qB), **not the inter-IMU/hinge rate.** A lag-held downswing barely moves the wrist hinge while the arm rotates fast; a waggle is pure hinge with no swing. The old detector used the hinge rate and both missed swings and false-triggered on waggles.
4. **Top** = reversal of the unwrapped swing angle. **Impact zone** = the unwrapped angle crossing back through the address value (~0) during the downswing, which coincides with **peak angular speed** (bottom of the arc). It is NOT the global minimum — the angle continues past address into the follow-through, so the global min is the finish.
5. **Peak wrist speed precedes the Mini shot report by ~500–830 ms** (consistent across shots) — the Mini has processing latency. A **±1.5 s join window** comfortably covers this; confirm on the new data and tighten if it improves precision without dropping recall.
6. **Full-swing peak wrist speeds run 2500–3200°/s; chips/pitches much lower.** Use the labeled carries to map swing-size → wrist signature.

## Algorithm to implement (hold-free detection + unwrapped angle + optional drill hold)

Rework `SwingDetector` so that, per sample:
- Maintain the **absolute-rate envelope** (smoothed; window in *time*, ~60–100 ms, since rate varies).
- **Takeaway:** envelope rises out of relative quiescence past an enter threshold. Freeze the **address reference** = the averaged pose over the brief still window just before takeaway (or the last sample if none). No long hold required.
- **Backswing:** integrate the **unwrapped signed angle** about the swing axis (axis fixed from the first ~200–250 ms of takeaway).
- **Top:** the unwrapped angle reverses (retreats by a margin) after reaching a minimum plausible magnitude.
- **Downswing → impact zone:** angle returns through the address value (~0) at/near peak speed. Emit the impact-zone timestamp (join key).
- **Follow-through → finish:** motion settles; finalize.
- **Validation gates** (reject non-swings): plausible backswing/downswing durations, downswing faster than backswing, minimum top magnitude, peak speed floor, hands actually returned toward address. A waggle/pickup/walk must fail these.
- **Drill-mode hold (optional layer):** when a still address hold ≥ ~1.5 s precedes the takeaway, arm a "GO" and snapshot clean address angles — but detection must work identically without it.
- Keep emitting the `hold` and `phase` events the app already consumes; keep the `WristShot` contract (extend, don't break).

## Captures available

`captures/` holds the labeled sessions. **The definitive tuning/validation set is the newest sessions with full wrist coverage** (recorded after a sensor-dropout bug was fixed). Known quirks in the existing files — inspect `meta` and coverage before trusting any file:
- One earlier session's **HackMotion died ~13.6 min in** (frames stop; Mini shots continue). Only shots before the cutoff have wrist data — verify frame coverage per shot and DISCARD label-only shots.
- Some sessions predate the label format (v1, no `shot`/`context` lines) — usable only for raw-signal/negatives study, not for join scoring.
- The user sometimes logged **7-iron shots under a "Pitching Wedge" club** — they separate cleanly by carry (7-iron ≫ PW). Don't trust `club.name` blindly; cross-check with `carryM`.
- Multiple wedge clubs named "60"/"56" exist; treat by `carryM`, not name.

The user will provide fresh captures covering: full/¾/half wedge, pitches, chips/bump-and-run (the low detection floor), 7-iron, driver, putts (decide: detect or ignore), a **negatives-only** session, and a **held-drill** session. Bump-and-runs and putts define the **low boundary** — the smallest motion that should (bump-run) or should not (putt/waggle) register.

## Acceptance & validation (produce this, quantitatively)

Over ALL valid labeled captures, via `replayCapture`:
1. **Confusion matrix:** true positives, **false negatives (target 0)**, false positives on negatives/idle (**target 0**), and practice-swing count (informational).
2. **Per-category breakdown** (full/¾/half wedge, pitch, chip, 7i, driver, putt): recall and the swing-signature distribution (backswing ms, unwrapped top angle, downswing ms, peak speed).
3. **Explicitly list every false negative and every false positive** with its capture + timestamp, so a human can inspect the raw signal. If any residual case can't be resolved without violating the other target, explain precisely why and quantify the trade-off.
4. A **detection-floor analysis:** where bump-and-runs sit vs. putts/waggles, and the chosen threshold with margin.

## Deliverables (write to the repo so they can be reviewed)

1. `handoff/DETECTOR_HANDOFF.md` — the characterization tables, the final tuned `SwingDetectorOptions` constants **with rationale tied to specific data**, the confusion matrix + per-category results, the false-negative/false-positive list, the detection-floor analysis, and any open questions.
2. The **implemented detector** (`swing-detector.ts` + any contract changes) as a clean diff, **typechecking and with all `libs/wrist` tests green**, plus new data-driven tests (e.g. a spec that replays a committed capture and asserts zero false negatives).
3. A short final summary message: the headline numbers (recall, FP count) and anything the integrating engineer must know.

## Working constraints

- **Worktree lib resolution:** you are in a git worktree. Verify lib edits from HERE; `@golf/*` resolves to this worktree's `libs/` via its own `node_modules` symlinks and the app tsconfig path maps. Never `cd` to the main checkout to "verify."
- **Code style:** no `any` (create real types), no `I`-prefixed interfaces, no `as` casts in imports, delete dead code, implement fully (no TODO stubs). Match surrounding style.
- Keep `detectSwings`/`replayCapture` signatures stable (they're the harness) unless you have a strong reason, and update all callers/tests if you change a contract.
- Clean up any throwaway analysis specs before finishing.

Begin by reading `libs/wrist/src/{swing-detector,replay,record-codec,quaternion,calibration}.ts` and `libs/types/src/wrist.ts`, then inventory every file in `captures/` (coverage + labels) before writing any code.
