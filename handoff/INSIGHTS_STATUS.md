# Fairway Insights — Project Status

**As of 2026-07-30 (evening).** Branch `claude/fairway-insights-spec-09d80d`,
merged to `main`. Companion docs: [INSIGHTS_AUDIT.md](INSIGHTS_AUDIT.md)
(Phase 0 audit + decisions), [GOPRO_CAPTURE.md](GOPRO_CAPTURE.md) (camera
feasibility + bench plan), BUILD_SPEC / CONTRACTS (pre-Insights docs).

## Phase scoreboard

| Phase | Status |
|---|---|
| 0 — Audit + core extraction | **Done.** The `@golf/*` lib layer already was the extraction; audit + reuse matrix in INSIGHTS_AUDIT.md |
| 1 — Mac hub MVP | **Code-complete.** Awaiting first live-hardware run + historical import (needs the phone's `fairway.db`) |
| 2 — Capture clients + clips | Not started. **No batch mode (Tim).** Ring-buffer spike is the mandatory first task; GoPro HERO 12 may join per GOPRO_CAPTURE.md bench |
| 3 — Pose pipeline | Not started (Python/uv worker, MediaPipe) |
| 4 — Analytics engine | **Done.** `@golf/insights`, 117 tests incl. planted-effect acceptance + negative control |
| 5 — Insights UI / drills / LLM / MCP | Coach narrative layer, findings feed, and drill library + prescription loop done (early); the loop is not yet *called* by the hub; MCP server not started |
| 6 — Address station | Not started. Vibrate bench parked (harness recipe in memory; hardware unverified) |

## What runs today

**The hub** (Node process + localhost web UI — Electron dropped permanently):

```bash
yarn install                       # once per checkout
yarn nx run hub:build-ui           # bundle the renderer
./tools/make-hub-app.sh            # build FairwayHub.app (macOS Bluetooth TCC wrapper)
open apps/hub/dist-app/FairwayHub.app   # UI: http://localhost:4271, log: ~/.fairway/hub.log
```

Dev without BLE: `HUB_NO_BLE=1 yarn nx run hub:serve`. `FAIRWAY_DATA_DIR`
points the hub at a scratch data dir (DB + coach resources) for testing. DB at `~/.fairway/hub.db`
(same `@golf/data` migrations as the phone, schema v10). The UI has session
start/end, **focus-club picker**, **intent picker** (stock/draw/fade), live
shot log with warmup tags and wrist-join markers. EYE MINI auto-connects via
UDP discovery; HackMotion candidates appear for click-to-connect
(`@stoprocent/noble` — @abandonware/noble is dead on macOS 26).

**Session focus — one session, one club** (Tim, 2026-07-30). Every statistic
keys on (club, intent), so a session that wanders the bag leaves every
bucket short of the findings and certification gates. A session therefore
declares a focus club: `Start session` is disabled until one is picked, the
picker collapses to that club for the duration, and `Change focus…` ends the
session and opens a new one on the chosen club. The store holds the
invariant (`selectClub` rejects anything but the focus), so the rule is not
just a UI convention. Two deliberate exemptions:

- **Drill mode is exempt** — the wedge ladder is a club sweep by design.
- **Implicit quick sessions get a focus too**, taken from the club the first
  shot is stamped with. An unstarted session is a focused session the
  golfer did not declare, not an unfocused one.

`focusClubId` is nullable: sessions written before v10 and anything imported
from the phone are legitimately unfocused, and the coach is told so.

**Reform Coach** (Claude Managed Agents): activates when
`ANTHROPIC_API_KEY` env or `~/.fairway/anthropic_api_key` exists. On session
end the hub builds the daily export (contract v4: shots + intent/warmup +
flight + wrist coach blocks + the engine's insights block) and runs the coach agent — no-egress sandbox,
cross-day memory store, recap persisted to the `analyses` table. First run
provisions agent/environment/memory-store into `~/.fairway/coach.json`.

**Analytics engine**: served at `GET /api/insights` and shown in the UI's
Insights panel; also rides the coach payload as the `insights` block
(contract v4). `analyzeShots(shots, config)` from `@golf/insights` —
per-(club,intent) great-shot classification, reference/dispersion baselines,
certification, changepoint, findings (guardrailed), bias-vs-variance, carry
decomposition, dispersion index. All thresholds in
`libs/insights/src/config.ts`; several corridor/margin numbers are tunable
placeholders pending real-data calibration.

**Drill library + prescription loop** (`@golf/program`): six curated drills
in `libs/program/content/drills.json` (versioned). `prescribe()` turns
findings into `TrainingBlock`s — one primitive shared by finding-driven
prescriptions and calendar program work — gated so a pure bias never earns
a drill (§6.6) and skipped when a tolerance band cannot be derived from the
user's own great-shot baseline (§6.10). `evaluateBlock()` graduates only
when both the target metric moved and the linked outcome improved.
Persisted via migration v9 (`training_blocks`). The coach's drill
allow-list derives from this library, so the two can never diverge.

**Replay harness**: `apps/hub/src/services.spec.ts` drives the whole loop
headless (real monitor decode on fake TCP/UDP via `@golf/monitor/testing`,
real wrist service replaying `captures/*.ndjson`, real SQLite). All hub
logic is developed against it.

## Waiting on Tim

1. **Live hardware run** — EYE MINI + HackMotion powered, `FairwayHub.app`,
   hit balls. First run shows one macOS Bluetooth prompt. The noble wrist
   transport has never touched the real sensor.
2. **API key** for the first real coach recap (path above).
3. **Phone `fairway.db`** for historical import (same DAO both sides —
   import is a small follow-up once the file is on the Mac).
4. **HERO 12 bench** when it arrives: firmware update, then
   `node tools/gopro-bench.mjs setup|clip|cycle|soak --ip <cam>` per
   GOPRO_CAPTURE.md. Item 1 (Hindsight at 1080p120) is go/no-go; buy the
   second body only on pass.

## Next build steps (in order)

1. Call the prescription loop from the hub (compute on session end,
   persist blocks, evaluate open ones, surface them in the UI and coach
   payload) — the library and loop exist but nothing invokes them yet.
2. Historical import once the phone DB lands.
3. Phase 2: RN capture app — ring-buffer spike first (chunked HEVC
   segments vs native AVAssetWriter), live per-shot clips only, no batch;
   GoPro path folds in if the bench passes.
4. Phase 3: Python worker (`uv`, FastAPI, MediaPipe) + §5.4 metrics.
5. Phase 5 remainder: MCP server (`query_shots`, `get_baseline`,
   `get_findings`, …).

## Decisions log (with rationale, chronological)

- **Hub = Node process + localhost web UI, permanently** (Tim). One runtime
  for BLE/sqlite, no Electron ABI rebuilds; the HTTP/WS server doubles as
  the Phase 2 phone endpoint. TCC solved by the app-bundle wrapper.
- **better-sqlite3 through the existing `@golf/data` `SqlDatabase` seam +
  hand-rolled migrations; no Drizzle** — one schema system for phone + hub.
- **`@stoprocent/noble`** for BLE (macOS 26 requirement); BLE code isolated
  in one transport file per the wrist/monitor seam pattern.
- **Schema v8**: `shots.intent` (stock/draw/fade/untagged = quarantine),
  `shots.warmup` (first 5 per session, re-taggable),
  `sessions.default_intent`. v7 (`wrist_swings`) came from the reform
  branch, merged.
- **Schema v10 `sessions.focus_club_id`, one club per session** (Tim). A
  single club — not a family (wedge/iron/wood) — because buckets are
  per-club: an "iron session" mixing 7i and 9i still splits into two
  half-depth buckets and clears no gate any sooner. Nullable and no FK: the
  focus club may be archived later, and imported rows may name a club that
  never landed on the hub.
- **RN transports moved to app edge** (`rn-monitor-transport.ts`), making
  `@golf/monitor` Node-pure; its in-memory fakes are the shared replay
  harness (`@golf/monitor/testing`).
- **No batch capture mode** (Tim) — live per-shot clips only.
- **Coach = Managed Agents** in `@golf/coach` + hub edge client; recaps
  reuse `AnalysisVerdict`/`analyses` so the phone renders them unchanged.
- **EYE MINI spec correction**: the device never reports carry/offline —
  flight-model computed; face angle exists but is assurance-gated.
- **Vibrate 0xcb**: wired end-to-end, hardware-unverified, parked (Tim).

## Known gaps / debts

- Hub handedness is a constant (`right`) in `apps/hub/src/main.ts` —
  settings surface pending.
- Coach recap not yet shown in the hub UI (persisted to DB only).
- No CI. `yarn nx run-many -t test,typecheck,lint` is the manual gate
  (16 projects, 517 tests, green as of this commit).
- Main-checkout `node_modules` needs `yarn install` after this merge (new
  packages: `@golf/hub`, `@golf/coach`, `@golf/insights`, `@golf/program`,
  SDK deps).
- `IMPACT_OFFSET_MS` (wrist coach keyframes) still untuned; needs hardware
  sessions.
- **One recap per focused session, not per range trip.** Focus sessions
  mean a three-club range trip now ends three sessions, and `onSessionEnd`
  fires the coach each time — three narrower recaps instead of one. Each is
  internally coherent (one club, its own findings) and the memory store
  carries the day-level arc, so this is livable, but if Tim wants a single
  trip-level recap the fix is a day-scoped export: gather every session
  that started on the same local day and emit one payload with a block per
  focus. `runDailyCoachRecap` is single-session today.
- `config.wrist.flipExtensionMarginDeg` (3°) is a placeholder; it gates the
  `flipFlag` that low-smash cause disambiguation reads.
