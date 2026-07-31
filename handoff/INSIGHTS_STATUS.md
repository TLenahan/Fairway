# Fairway Insights — Project Status

**As of 2026-07-30 (evening).** Everything described below is merged to
`main` — the insights branches carry no unmerged work.
Companion docs: [INSIGHTS_AUDIT.md](INSIGHTS_AUDIT.md)
(Phase 0 audit + decisions), [GOPRO_CAPTURE.md](GOPRO_CAPTURE.md) (camera
feasibility + bench plan), BUILD_SPEC / CONTRACTS (pre-Insights docs).

## Phase scoreboard

| Phase | Status |
|---|---|
| 0 — Audit + core extraction | **Done.** The `@golf/*` lib layer already was the extraction; audit + reuse matrix in INSIGHTS_AUDIT.md |
| 1 — Mac hub MVP | **Code-complete.** Awaiting the first live-hardware run |
| 2 — Capture clients + clips | **GoPro path complete end to end** — seam, driver, UI playback; awaiting a body. RN capture app not started (ring-buffer spike is its gate). **No batch mode (Tim).** |
| 3 — Pose pipeline | Not started (Python/uv worker, MediaPipe) |
| 4 — Analytics engine | **Done.** `@golf/insights`, 122 tests incl. planted-effect acceptance + negative control |
| 5 — Insights UI / drills / LLM / MCP | **Done.** Coach narrative layer, findings feed, drill library + prescription loop, and the MCP server are all built and running |
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
points the hub at a scratch data dir (DB + coach resources + clips) for testing. DB at `~/.fairway/hub.db`
(same `@golf/data` migrations as the phone, schema v11). The UI has session
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

The engine's wrist inputs come from the wrist-coach keyframes when a swing
produced them (`libs/insights/src/projection.ts`) — those calibrated angles
are the only source of the peak-down extension the cast/flip signature is
mined from, so `flipFlag` and the `'delivery'` low-smash cause were dead
until the projection read them. Raw keyframe angles are the fallback for
swings without a coach block, and stay null until a calibration run.

**Drill library + prescription loop** (`@golf/program`): six curated drills
in `libs/program/content/drills.json` (versioned). `prescribe()` turns
findings into `TrainingBlock`s — one primitive shared by finding-driven
prescriptions and calendar program work — gated so a pure bias never earns
a drill (§6.6) and skipped when a tolerance band cannot be derived from the
user's own great-shot baseline (§6.10). `evaluateBlock()` graduates only
when both the target metric moved and the linked outcome improved.
Persisted via migration v9 (`training_blocks`). The coach's drill
allow-list derives from this library, so the two can never diverge.
The loop RUNS: `GET /api/insights` triggers `runProgramLoop`, which
persists new prescriptions and resolves closed windows, returns findings
and blocks in one payload, and feeds the same object to the coach. It is
safe on a GET only because it is idempotent by construction (prescribe
skips covered findings; evaluation only resolves closed windows) — the
integration test asserts a second run prescribes nothing. Blocks appear
in the UI's Training panel.

**Coach recap in the UI**: `GET /api/recaps` + a Coach panel under the
Session controls — headline, prose, issues/strengths/drills/caveats, with a
live "writing today's recap…" state that polls until it lands (a coach run
outlives the request that starts it) and a visible error state. Drill ids
resolve to display names server-side.

**MCP server** (`@golf/mcp` + `apps/hub/src/mcp`): the practice history as MCP
tools, so Claude Desktop / Claude Code can ask about it directly. Eight tools —
`list_clubs`, `list_sessions`, `query_shots`, `get_bucket_status`,
`get_baseline`, `get_findings`, `get_training_blocks`, `get_recaps`. Point a
client at `tools/fairway-mcp.sh` (the config snippet is in the script's header).

Three properties hold it together:

- **Read-only, enforced by the driver.** It runs as its own process with a
  read-only better-sqlite3 connection to `~/.fairway/hub.db`, so a write fails
  at the driver rather than depending on every tool remembering not to. That
  is what makes it safe for a model to call these speculatively: exploring
  "what happened to my 7 iron" cannot prescribe a training block as a side
  effect. Prescribing stays in the hub, driven by real shots arriving.
  The hub need not be running; both processes can be live at once.
- **The engine is the only source of numbers.** Tools project and filter
  what `analyzeShots` computed — `query_shots` even reports the engine's
  own per-shot projection, so a listed shot's wrist angles are the calibrated
  ones `flipFlag` was decided from, not the raw fallback.
- **Strict arguments.** An argument no tool declares is rejected, because
  silently dropping a filter (`club` instead of `club_id`) answers a different
  question than the one asked, with full confidence.

The transport is hand-rolled (`protocol.ts` + `stdio.ts`, 10 conformance
specs). `@modelcontextprotocol/sdk` is ESM-only and the hub is CJS end to end
via swc-node — a dynamic import of it is rewritten to `require` and fails at
runtime. A tools-only server needs four methods (`initialize`, `tools/list`,
`tools/call`, `ping`), which costs less than threading an ESM seam through the
app; the same trade `@golf/analysis` made with its SSE client. If it ever needs
resources, prompts, sampling or a non-stdio transport, make the hub
dual-format rather than growing that file. Tool failures come back as results
with `isError`, not JSON-RPC errors, so the model sees a rejected argument and
can fix it instead of the client swallowing it.

**Capture seam** (`apps/hub/src/capture`, schema v11 `clips`): the hub side of
Phase 2 — where a swing clip comes from, where it lands, and how it gets back
out. No capture client exists yet; this is the contract one will plug into.

The load-bearing idea is that **capture is retrospective**. Both candidate
sources hold a rolling pre-roll — the phone's ring buffer, the GoPro's
Hindsight — and are triggered *after* the ball is struck, at monitor time T. So
the hub already knows which shot it is asking about when it asks. A clip is
therefore **assigned** to its shot, never joined to it: the hub mints a
`CaptureRequest` naming the shot, the camera returns bytes quoting that id.
Contrast the wrist sensor, which streams on its own clock and must be matched
by nearest-neighbour (±1.5 s in `@golf/store`). The rule that falls out is that
a clip with no live request is **rejected, not guessed at** — a clip filed
against the wrong swing is worse than a missing one, because every pose metric
Phase 3 derives from it would be attributed to a swing that did not produce it.

A camera's whole loop is two calls:

```
GET  /api/clips/pending                              → live requests
POST /api/clips?request=<id>&durationMs=&fps=&width=&height=[&impactOffsetMs=]
GET  /api/clips?shotId=<id> | ?sessionId=<id>        → the UI's read side
GET  /api/clips/<id>/file                            → Range-capable playback
```

Polling rather than pushing because the hub cannot reliably reach a camera: a
phone on the range moves between networks, and the GoPro is driven by a client
inside the hub process. Both can ask; neither can be told. Requests are
in-memory and single-use with a 120 s TTL — an unfulfilled ask is not history,
and two files cannot both be the clip one request asked for.

Two invariants worth not breaking:

- **Ingest never claims `sync: 'fine'`.** Whatever offset a client sends is
  derived from when it was told to stop, which is the trigger-time estimate by
  definition. Only a later impact-audio pass earns `fine`, through
  `setClipImpactOffset` (Phase 0 audit, decision 6). `impactOffsetMs` is
  nullable because 0 is a real answer — impact on the first frame — and cannot
  double as "unknown".
- **Bytes live under the data dir; the row stores a relative path**, so a
  `FAIRWAY_DATA_DIR` move does not orphan every clip. The read side re-checks
  that a path stays inside the clips directory: a row is only as trustworthy as
  whatever wrote it, and serving arbitrary files off the hub's disk is not a
  risk worth taking on that.

Cameras are configured, not assumed:
`HUB_CAMERAS=phone:face_on,gopro:down_the_line@172.24.106.51`. Unset means no
cameras and therefore no requests — a hub with nothing pointed at the bay should
not spend every shot asking an empty room for a clip. The optional `@address` is
what splits the two kinds of camera: a phone finds the hub itself, a GoPro can
be told nothing, so the hub runs the client for it and that client needs to know
which body to talk to. It rides on the camera entry rather than in a second
variable so there is still exactly one list of what is pointed at the bay.

**GoPro driver** (`apps/hub/src/capture/gopro`, on the assumption the HERO 12
does Hindsight at 1080p120 — Tim, 2026-07-30): the first camera client, running
inside the hub. Per shot it locks the pre-roll with `shutter/start`, records
3.5 s forward, stops, waits out the encode, pulls the save over USB, trims it
and uploads it against the request that asked for it. `camera.ts` is the Open
GoPro 2.0 HTTP transport, `trim.ts` the ffmpeg shell-out, `driver.ts` the loop;
the camera and ffmpeg are the only things the tests fake.

It talks to the seam over loopback HTTP even though the registry is an object
away, so the contract has one shape rather than two — and so the driver could
move to a box next to the camera without changing.

Three things it will not do, all the same rule as the seam's own — a clip filed
against the wrong swing is worse than a missing one:

- **It refuses a request older than the pre-roll can reach back to.** Hindsight
  is a window ending at the trigger, so a request answered ~8.5 s late (15 s
  buffer, 5 s of run-up wanted, margin for the monitor's own lag) would save
  what happened AFTER the swing and file it as the swing.
- **It refuses a clip with under 1.5 s of measured run-up**, however the trim
  came out — a clip with no backswing in it is not a swing clip.
- **It does not trigger while Hindsight is down.** A save drops the buffer while
  the camera writes it; until status 106 is back, triggering would hand back a
  clip with no pre-roll at all.

**Everything is measured from the END of the file**, which is the only instant
in it the hub knows: the moment it said stop. The start is unknown twice over —
the buffer may not have been full, and `-c copy` snaps the cut back to the
previous keyframe, so the clip is some unknown amount longer at the front than
the trim asked for. So the driver asks for a generous tail and then computes
`impactOffsetMs = probedDuration - (stopTime - requestTime)`. Keyframe slop
lands in the pre-roll where it belongs, and the offset is right without anyone
knowing where the cut fell. The residual — the stop command's round trip, and
the monitor's own latency before `requestedAt` — is exactly what keeps every
clip `coarse` until the audio pass.

Operational notes: **ffmpeg is a hard dependency** (`brew install ffmpeg`); the
driver preflights it and refuses to start without it, because otherwise every
capture would pull 200 MB over USB and have nothing to do with it. An
unreachable camera is *not* fatal — the same watchdog that handles the ~15 min
idle self-disarm covers a cable plugged in after the hub started, so there is
one recovery path rather than three. Trimmed clips live under the data dir; the
untrimmed originals stay on the camera's card (~120 MB a shot), so clear it
between range trips.

**Clip playback in the UI**: a shot row with clips offers one button per view;
the player opens at impact (`#t=`) and reports duration, fps, frame size and how
well the sync is known. Clips are polled while a session is live rather than
pushed — one lands seconds after its shot, and none of that touches the store.

**Replay harness**: `apps/hub/src/services.spec.ts` drives the whole loop
headless (real monitor decode on fake TCP/UDP via `@golf/monitor/testing`,
real wrist service replaying `captures/*.ndjson`, real SQLite). All hub
logic is developed against it. The capture seam has its own
(`apps/hub/src/capture/testing.ts`) — real endpoints, registry, SQLite and clip
files, shared by the endpoint and driver specs. The driver runs against it on a
fake clock that only moves when the driver sleeps, so a nine-second capture
costs jest nothing and every derived timing is exactly reproducible.

## Waiting on Tim

1. **Live hardware run** — EYE MINI + HackMotion powered, `FairwayHub.app`,
   hit balls. First run shows one macOS Bluetooth prompt. The noble wrist
   transport has never touched the real sensor.
2. **API key** for the first real coach recap (path above).
3. **HERO 12 bench** when it arrives: `brew install ffmpeg`, firmware update,
   then `node tools/gopro-bench.mjs setup|clip|cycle|soak --ip <cam>` per
   GOPRO_CAPTURE.md, then the hub itself with
   `HUB_CAMERAS=gopro:down_the_line@<cam-ip>`. The driver is built on the
   assumption item 1 passes (Tim); the bench now verifies that path rather than
   deciding whether to write it. Buy the second body only on a clean pass.

**Historical import is cancelled, not pending** (Tim, 2026-07-30): there is no
build on the phone, so `fairway.db` would be empty. The hub's own history is
the only history. Nothing is waiting on that file — do not re-add it.

## Next build steps (in order)

1. **Phase 3: the pose worker** — Python (`uv`, FastAPI, MediaPipe) + §5.4
   metrics, reading clips off the seam and writing impact offsets back through
   `setClipImpactOffset`. This is now the front of the queue: the GoPro path
   produces clips, and nothing yet reads one. The impact-audio pass that earns
   a clip `sync: 'fine'` belongs here too — every GoPro clip is `coarse` by
   construction, and it is the only thing that can change that.
2. **RN capture app** — ring-buffer spike first (chunked HEVC segments vs
   native AVAssetWriter), live per-shot clips only, no batch. The spike is the
   gate and needs a device; its outcome does not change the hub contract, only
   what fulfils it. Nothing else waits on this — the GoPro is a complete
   second view on its own.
3. **Second GoPro body** for the two-view station, on a clean bench. The driver
   is already per-view: two entries in `HUB_CAMERAS` with two addresses start
   two of them, each answering only its own requests.

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
- **Schema v11 `clips`; a clip is assigned to its shot, never joined to it**
  (see above). The FK to `shots` is real and NOT NULL, and `impact_offset_ms`
  is the table's only nullable column — a clip exists because the hub asked a
  camera for a *known* shot's pre-roll, so the only thing genuinely unknown at
  write time is where impact sits in the file. Clip bytes are not a `@golf/*`
  concern: the seam is hub-edge, same as the BLE, monitor and MCP transports.
- **Assume the HERO 12 does Hindsight at 1080p120** (Tim, 2026-07-30) — the
  driver was built on that assumption rather than waiting on the bench. The
  frame rate is the only thing item 1 can kill; the loop is rate-agnostic.
- **The GoPro driver measures from the end of the file, never the start**
  (see above). Keyframe snapping and a part-full buffer both move the start and
  neither moves the end, so anchoring there is what makes the impact offset
  survive not knowing where the cut landed.
- **Coach = Managed Agents** in `@golf/coach` + hub edge client; recaps
  reuse `AnalysisVerdict`/`analyses` so the phone renders them unchanged.
- **MCP server is read-only and hand-framed** (see above). Tools live in
  `@golf/mcp` (pure, DataStore injected); the stdio transport lives at the hub
  edge — the same lib/edge seam as the BLE and monitor transports.
  Launched by `tools/fairway-mcp.sh`, deliberately NOT an nx target: nx writes
  a banner to stdout and for a stdio server stdout IS the protocol.
- **No phone import** (Tim, 2026-07-30) — nothing runs on the phone, so
  there is nothing to import.
- **EYE MINI spec correction**: the device never reports carry/offline —
  flight-model computed; face angle exists but is assurance-gated.
- **Vibrate 0xcb**: wired end-to-end, hardware-unverified, parked (Tim).

## Known gaps / debts

- Hub handedness is a constant (`right`) in `apps/hub/src/main.ts` —
  settings surface pending.
- **Every GoPro number is unverified against a real body.** The pre-roll (5 s),
  the forward hold (3.5 s) and the staleness margin (1.5 s) are reasoned, not
  measured; the encode budget (30 s) and the buffer-refill assumption come from
  GOPRO_CAPTURE.md's cadence math, which is thin at fast shot spacing. Bench
  item 3 is what tunes them.
- The camera's card is never cleared by the hub — it keeps the untrimmed
  originals (~120 MB a shot). Clear it between range trips or Hindsight runs
  out of room to save into.
- No CI. `yarn nx run-many -t test,typecheck,lint` is the manual gate
  (17 projects, 644 tests — re-run green as of this commit).
- Nx cannot build a project graph while sibling git worktrees are checked
  out: each one holds a second copy of every `libs/*` project.json and the
  duplicate names fail the whole graph. `.nxignore` excludes
  `.claude/worktrees`, which is what makes the gate runnable from the main
  checkout. A worktree still needs its own `yarn install` before it can run
  anything; the main checkout is installed.
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
