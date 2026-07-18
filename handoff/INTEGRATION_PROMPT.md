# Fresh-Session Integrator — review & merge the calibration tracks

You are a fresh Claude Code session acting as the reviewer/integrator. Two independent agent tracks produced work; your job is to verify and merge it. You have NO prior conversation — everything you need is in files.

## The tracks

1. **Flight calibration** — branch `claude/flight-model-aero-calibration-fb0700`, worktree `.claude/worktrees/android-device-run-command-12d5a0` (the worktree name is unrelated to the work — go by the branch). Spec: `handoff/FLIGHT_AGENT_PROMPT.md`. Results: `handoff/FLIGHT_HANDOFF.md` lives ON that branch, not on main or the detector branch — read it there (`git show claude/flight-model-aero-calibration-fb0700:handoff/FLIGHT_HANDOFF.md` or from inside that worktree).
2. **Shot detection** — branch `claude/hackmotion-shot-detection-901256`, worktree `.claude/worktrees/hackmotion-shot-detection-901256`. Spec: `handoff/DETECTOR_AGENT_PROMPT.md`. Results: `handoff/DETECTOR_HANDOFF.md`.

## Review procedure (per track)

1. Read the track's PROMPT (the contract) then its HANDOFF (the claim). Check the acceptance bars in the prompt against the reported numbers — do not take "done" on faith.
2. Review the diff fresh-eyes: `git diff main...<branch>`. Focus: correctness, the repo's hard rules (below), no dead code, no `any`, contracts extended not broken.
3. Re-run verification YOURSELF from inside that track's worktree (never from the main checkout — worktrees resolve `@golf/*` locally; see the memory note `fairway-worktree-lib-resolution`):
   - `npx tsc --noEmit -p libs/<lib>/tsconfig.json` for each touched lib, plus `npx tsc -p apps/fairway/tsconfig.json --noEmit`
   - `npx jest --config libs/<lib>/jest.config.ts` for each touched lib
4. Spot-check the claims against data: for the detector, re-run its replay spec over `captures/` and confirm the confusion matrix (zero false negatives on Mini-labeled shots; zero false positives on the negatives session). For flight, re-run its fit/validation spec over the committed fixtures and confirm the error tables.

## Hard rules (violations block merge)

- **Never infer ball contact from wrist data** — impact-zone is a join key, not a contact claim.
- **Never treat practice swings as real shots** — anything ball-dependent keys off a joined launch-monitor shot (`shotId`/label), never off detection alone.
- **Measured vs computed stays honest** — computed values carry `computed: true`; nothing fabricated presents as measured (no fake zeros for unmeasured fields).

## Owner decisions — BOTH RESOLVED (Tim, 2026-07-18). Not blockers.

The detector agent self-flagged two judgment calls. Tim has ruled on both;
they are settled — do not re-litigate or block the merge on them.

1. **The chip band's shock gate — APPROVED.** Chips overlap putts and club
   handling kinematically, so sub-140° strokes are only validated when
   impact-neighborhood shock ≥ 6000 lsb (measured: ball/turf 7351+, all
   non-contact ≤ 4682). Framed as an impact-PLAUSIBILITY floor, not a contact
   claim. Tim accepts this framing against hard rule #1. Keep the framing
   honest in code comments and UI: it admits a candidate stroke, it never
   asserts a ball was struck — the launch-monitor join remains the only
   contact confirmation. Residual known costs, accepted: **air practice chips
   (no ground contact) are not detected**, and **address-tap shock is
   untested** (a firm tap at address could plausibly clear 6000 and yield a
   phantom chip — worth a negatives capture later, not a merge blocker).
2. **Putts below the detection floor — ACCEPTED.** Putt peaks (87–320°/s) sit
   under routine club handling (up to 780°/s), so no threshold separates them;
   the wrist does not detect putts by design and the Mini alone reports them.
   Tim confirmed putts are out of scope — the wrist work exists to fine-tune
   full-swing clubs. If putt wrist data is ever wanted, the clean path is a
   putter-specific profile keyed off the active club category (the app already
   knows it), NOT a lower global floor.

Verify the claimed numbers yourself rather than trusting the handoff:
`capture-replay.spec.ts` locks 60/60 recall (39 full/partial + 21 chips) and
zero false positives — re-run it from inside that worktree.

## Merge

- Tracks are independent (disjoint libs: `flight-model` vs `wrist`+app). Merge each to `main` separately once it passes; flight first if both are ready (smaller surface). Re-run the touched-lib tests on `main` after each merge.
- The app APK is built by the OWNER (Tim), never by you — after merging anything under `apps/fairway` or libs the app consumes, tell him a rebuild is needed (`installDebug`) and which parts are JS-only vs native.
- If a track fails review: write precise findings into that track's HANDOFF file under `## Review findings`, and stop — the owner relaunches the track agent to fix.

## Context discipline

Do the review with subagents where files are large (read-only explore agents that report conclusions), keep your own context lean, and end with a short report: pass/fail per track, headline numbers, what merged, what the owner must do next.
