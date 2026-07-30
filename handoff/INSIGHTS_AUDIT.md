# Fairway Insights — Phase 0 Audit Report

Date: 2026-07-30. Read-only audit of the Fairway monorepo (worktree `wedge-drill-issues-fa9fc6`) against the Fairway Insights build spec. No files were modified. All paths repo-relative; claims verified by reading code.

## 1. Headline: the extraction already happened

The spec's "create monorepo; extract `@fairway/core`" is substantially done. Fairway is an Nx + yarn-4 workspaces monorepo with 11 `@golf/*` libs and a frozen zod contract layer (`libs/types`, documented in `handoff/CONTRACTS.md`). The platform-agnostic core the Mac hub needs — flight model, EYE MINI protocol, HackMotion math + shot detection, data model, store pipeline, stats — already exists as pure TypeScript with Node-environment Jest suites (34 spec files across libs). There is no package-manager migration and no `packages/core` extraction to do; `@fairway/core` ≙ the existing `@golf/*` layer.

## 2. Reuse matrix

| Lib | Node verdict | Hub work needed |
|---|---|---|
| `@golf/flight-model` | **reuse-as-is** | none |
| `@golf/wrist` | **reuse-as-is** (math, detector, replay) | new `WristBleTransport` impl (noble) |
| `@golf/monitor` | core pure; barrel blocks import | split barrel + Node `TcpFactory`/`UdpFactory` (net/dgram) |
| `@golf/data` | **reuse-as-is** via `SqlDatabase` seam | better-sqlite3 adapter (pattern already proven in tests) |
| `@golf/store` | **reuse-as-is** (pure vanilla zustand) | none — the whole live pipeline comes for free |
| `@golf/analytics` | **reuse-as-is** | extend for §6 (do NOT build a parallel engine) |
| `@golf/drill` | **reuse-as-is** | extend (this IS the spec's "drill library") |
| `@golf/analysis` | **reuse-as-is** | inject Node fetch + keychain `getApiKey` |
| `@golf/viz` | math under `src/lib/*` portable | components are RN-only → rebuild views in React DOM on the same math |
| `@golf/ui` | `colors.ts` portable | components RN-only → new renderer primitives |
| `apps/fairway` | composition root, not a lib | replicate composition in hub main (see §6) |

Key interfaces (authoritative in `libs/types`):

- **FlightModel** (`libs/types/src/flight.ts:42`): `simulate(launch, env)` → `FlightResult { path[], carryM, totalM, apexM, descentDeg, flightTimeS, offlineM, curveM, landing, rolloutM, computed: true }`. Metric units; `computed: literal(true)` is the computed-vs-sensor flag. Curve validation is codified as regression tests: side RMS 1.94 yd, curve RMS 1.82 yd vs the committed TrackMan fixture set (`libs/flight-model/src/aero-calibration.spec.ts:102`; fixtures: `trackman-driver.csv` 7,938 cleaned rows, `flightscope-oracle.json`, tour averages). The spec's "byte-identical on a recorded fixture set" acceptance is satisfiable by running these existing suites from the hub context.
- **MonitorService** (`libs/types/src/device.ts:35`): `startDiscovery/connect/setClub/setHandedness` + events `device|connection|state|ballDetected|shot(MeasuredShot)|error`. `EyeMiniMonitor` (`libs/monitor/src/monitor-service.ts:80`) takes injected `{ tcp: TcpFactory, udp: UdpFactory }` (`libs/monitor/src/transport.ts`) — a Node transport is a small net/dgram adapter. **Blocker:** `libs/monitor/src/index.ts:5` re-exports `rn-transport.ts` (the only RN-coupled file), so the barrel drags react-native-tcp-socket/udp into any plain-Node import. Fix: subpath export split (`.` = core, `./rn` = RN transport), additive so the RN app keeps building.
- **WristService** (`libs/types/src/wrist.ts:199`): scan/connect/calibrate/vibrate + events incl. `swing(WristShot)`, `phase`, `hold`. `HackMotionWristService` takes an injected `WristBleTransport` (`libs/wrist/src/ble-transport.ts:23` — 4 methods); the RN impl lives at the app edge (`apps/fairway/src/services/rn-ble-wrist-transport.ts`), the cleaner seam pattern to mirror for noble. Detector regression: `capture-replay.spec.ts` replays 4 committed range captures — 60/60 swings matched, 0 false positives on putting.
- **DataStore** (`libs/types/src/data.ts`): DAO over a 4-method `SqlDatabase` seam (`libs/data/src/database.ts:8`) with hand-rolled migrations (`libs/data/src/migrations.ts` — tables `clubs, sessions, shots, analyses, drill_reps`). Shots persist SI fields with the NULL-never-0 assurance rule, incl. `face_impact_h_mm/v_mm` (the strike-location slot already exists, sensor-sourced).
- **Store pipeline** (`libs/store/src/create-store.ts`): shot dedupe by `shotGuid`, implicit quick-session, wrist↔shot join (nearest-neighbor on host arrival ±1.5 s, both arrival orders), drill-rep judging + late carry attach, wrist-death detection. Pure TS over injected contracts; 743-line spec with in-memory fakes — the ready-made pattern for hub tests.

## 3. Spec corrections — reality diverges from the spec text

These need Tim's input before the affected phases; none block the Monday slice.

1. **Swing-program coaching agent (Managed Agents API): does not exist in this repo.** The only AI integration is `@golf/analysis` calling plain `POST /v1/messages` via a hand-rolled SSE client (`libs/analysis/src/anthropic-client.ts:8`; models `claude-sonnet-5` default, `claude-opus-4-8` deep — `libs/analysis/src/models.ts:5`). No Managed Agents usage, no daily session export, anywhere. Key stored only in expo-secure-store (`apps/fairway/src/services/api-key.ts`). → Is the Managed Agent in another repo, or is Phase 1's "reform-program handoff" actually building on `@golf/analysis`?
2. **Off-season training feature: absent.** Grep for winter/off-season/training-plan/program across apps+libs returns nothing. Closest is the wedge drill (runtime-computed `computeDrillPlan`, no static plan files). → Other repo, or net-new (which simplifies §6.12 to "design it once, here")?
3. **EYE MINI sniffer / EYE XO2:** the sniffer is already folded into `@golf/monitor` (origin scripts preserved in `reference/`); zero XO2 traces here. `~/Documents/divot` is an unrelated BLE club-sensor hardware project. → Does the extended sniffer repo exist elsewhere?
4. **EYE MINI measured channels — spec's list is wrong.** Raw `ShotDataEX1` (`libs/types/src/shot.ts:11`) contains **no carry/offline fields**; carry/offline/curve are always flight-model outputs (`computed: true`). Measured = ball speed/VLA/HLA/spin + club data (speed, path, **faceangle** — device-reported but assurance-gated to null in practice, attack/loft/lie, face impact H/V), each nulled when its assurance is 0. Smash is computed in-app (`libs/monitor/src/shot-decoder.ts:72`), confirming the spec's rule.
5. **Motor "proven" is overstated.** The 0xcb vibrate path is wired end-to-end (`libs/wrist/src/wrist-service.ts:109` → `apps/fairway/src/services/drill-feedback.ts:204-232`, incl. motor-quiet-through-impact policy) but docs still flag it decoded-from-capture, hardware-unverified; motor spin-up latency and shock-gate interference uncharacterized. Needs one bench test.
6. **No intent/warmup/great/round anywhere.** Shots carry only `clubId`. The only intent-adjacent data is per-club `SwingTag` (`full|three_quarter|half|chip`) and free-text names ("9 iron draw"). The (club, intent) bucket key, warmup tagging, great-shot classification, and the `baselines/findings/prescriptions` tables are all net-new schema — real Phase 1 migration work in `@golf/data`.
7. **Strike-location CV:** no CV code in-repo (as the spec expects — separate effort). The optional-field slot exists via EYE MINI `faceImpactHMm/VMm`.

## 4. Monorepo proposal

Keep Nx + yarn workspaces exactly as-is. Add:

```
apps/hub          Electron. main: Node tcp/udp transport, noble WristBleTransport,
                  better-sqlite3 SqlDatabase adapter, job queue, WS server (phones).
                  renderer: React DOM, reusing @golf/viz math + @golf/ui colors.
apps/capture      RN thin capture client (Phase 2).
workers/analysis  Python, uv-managed, FastAPI on localhost (Phase 3).
libs/insights     §6 analytics engine — pure functions extending @golf/analytics
                  primitives (dispersion/gapping/contact stay where they are).
libs/mcp-server   Phase 5.
```

Small existing-code changes (all additive; RN app keeps building): split the `@golf/monitor` barrel; hoist app-trapped logic the hub needs into libs as touched — top candidates: `src/lib/format.ts` (unit/format conventions), `src/services/wrist-capture.ts` (NDJSON v2 writer), the self-labeling capture wiring (`app-services.ts:82-130`), drill feedback policy math (`drill-feedback.ts` — policy is pure; only audio/haptics calls are platform).

## 5. Open decisions (§7) — decided

1. **Hub shell: Electron.** Confirmed by audit: every core lib already runs under Node-env Jest; hub main is composition + adapters. Risk concentrates in noble + macOS Bluetooth permissions inside Electron — stand up day one per the spec.
2. **Ring buffer:** unchanged — spike chunked-HEVC vs native AVAssetWriter in Phase 2 week 1.
3. **DB layer: better-sqlite3 via the existing `@golf/data` seam + its migration system. No Drizzle** — deviation from the spec's recommendation. Adopting Drizzle would create a second schema/migration source diverging from the phone DAO over the same tables; the audit's cardinal finding is that duplication, not tooling, is the risk. New Insights tables (§6.11) land as `@golf/data` migrations.
4. **Python interop:** long-lived FastAPI worker on localhost, `uv`-managed (accept rec).
5. **Live-mode transport:** MJPEG-over-WS v1 (accept rec).
6. **Fine-sync fallback:** accept coarse-only with `syncFlag` when impact audio is unreliable; revisit flash-sync only if real sessions show chronic audio failure.

## 6. Monday (Aug 3) critical-slice assessment

| Slice item | Status |
|---|---|
| EYE MINI ingest on Mac | Small: Node `TcpFactory`/`UdpFactory` + barrel split; protocol fully spec-tested against fake transports |
| HackMotion stream | Riskiest: noble transport + Electron BLE entitlements — sequence first |
| SQLite per-shot join | Mostly free: `@golf/store` pipeline + `@golf/data` + better-sqlite3 adapter |
| Flight-model byte-identical check | Run existing fixture regressions from hub context |
| Replay harness | Largely exists: `libs/wrist/src/replay.ts` + 8 committed captures (v2 format interleaves wrist frames + EYE MINI shot labels on one host clock) + monitor fixtures; hub harness = wire through hub composition |
| Minimal session UI | Club picker logic exists (store actions); **intent picker is net-new** (schema first, §3.6) |
| Motor buzz from UI | Wired; needs the bench verification (§3.5) |
| Historical import | Phone DB and hub share the same DAO/migrations — import = copy `fairway.db` + run migrations; may trail into the week per spec |

## 7. Risks and cleanups noted (not fixed — read-only audit)

- **Bug:** `settingsOf` (`apps/fairway/src/services/settings.ts:75-86`) rebuilds the persisted settings without `wristCalibration`, so any settings write persists calibration as null — saved calibration survives only in memory. (Flagged as a separate fix task.)
- No CI anywhere; recommend a `nx affected -t test,typecheck,lint` gate before hub work starts.
- `parseCapture` silently ignores unknown/future NDJSON line types — fine for replay tooling, needs validation before reuse as a hub ingest path.
- `handoff/CONTRACTS.md` predates `@golf/wrist` and `@golf/drill`; update it if it stays authoritative.
- HackMotion: OTA UUIDs are do-not-write (bootloader trap); several vendor opcodes undecoded; firmware update could silently shift the 46-byte record layout (no schema guard); one BLE central at a time; 5-min idle sleep — the noble transport must own reconnects.
- Frozen `AnalyticsEngine` interface is 2-arg but concrete `summarizeSession` takes `clubs?` (app works around via `typeof`); reconcile when touching contracts.
- `@golf/analytics` exports its fixture-only `shot-builder` from the public index; `deviationDeg` sign convention undocumented beyond "radial/ulnar"; `IMPACT_OFFSET_MS` untuned pending hardware sessions; 4 of 8 captures not asserted by any test (keep-or-promote decision).
