# WORK PACKAGES

Each package = one Nx lib (or the app) = one parallel worktree/subagent stream. All Phase-1 packages build against the **frozen `@golf/types`** (CONTRACTS.md) and mock the others with fixtures, so they don't block each other. `nx affected -t typecheck lint test` scopes CI per stream.

Dependency graph and worktree table are in README §2–3. Below is the per-package brief.

---

## WP0 — Workspace, contracts, scaffolding · `main` · **blocks everything**
**Provides:** the Nx workspace, the app shell, every empty lib with tags + boundaries, `libs/types` fully implemented, migration harness, store skeleton.

- Scaffold Nx integrated monorepo (`apps/` + `libs/`), package manager per your convention (pnpm target: `node-linker=hoisted` in `apps/fairway/.npmrc` for Metro; else Yarn workspaces).
- Create `apps/fairway` as an Expo **custom dev client** app (`@nx/expo:app` preferred). Config plugin + `app.json`: `NSLocalNetworkUsageDescription`, Bonjour placeholder service, and the native modules `react-native-tcp-socket`, `react-native-udp`, `expo-sqlite`, `expo-secure-store`. `eas.json` dev-client/build/update profiles (BUILD_SPEC §2). Confirm a dev-client build boots on device.
- Create empty libs with tags (`type:*`, `scope:golf`) and turn on `@nx/enforce-module-boundaries` with the README §2 rules. Add a deliberate illegal import and confirm lint fails, then remove it.
- Implement **`libs/types`** fully from CONTRACTS.md (Zod schemas + `z.infer` types + `categoryToSensorMode`). Export from `index.ts`. Path alias `@golf/*` → `libs/*/src/index.ts` in `tsconfig.base.json`.
- Stand up `libs/data` migration harness (schema versioning) and `libs/store` skeleton (empty slices typed to the CONTRACTS interfaces). Seed default clubs list (Driver, irons, wedges, Putter).
- **AC:** workspace builds; `@golf/types` exports all schemas; boundary violation fails lint; migrations run clean; dev-client boots. **Freeze `libs/types` and commit before opening Phase-1 worktrees.**

---

## WP1 — `libs/monitor` (`@golf/monitor`) · `claude/monitor` · networking
**Consumes:** `@golf/types`. **Provides:** `MonitorService`.
**Reference:** port `reference/protocol.js` (FrameParser + encode + decodeShot) and `reference/discover.js` to TS; use `reference/test-217.js` as the integration behavior; `reference/sample-shot.json` as the decode unit test. Protocol spec: BUILD_SPEC Appendix A.

- **FrameCodec:** 8-byte header `[0x99 0x01][0x28 0x28][BE uint32 len][JSON]`; streaming parser handling TCP segmentation + multi-message segments + resync on `0x2828`; `encode(eventId, command, reqId, param)`.
- **Discovery:** UDP socket (broadcast) on `:43265`; validate beacon; emit `DiscoveredDevice`. Also support saved-IP direct connect.
- **ControlChannel** (TCP `:43266`): run the init sequence **omitting command 217** (A.4), then the 51/203 poll loop (~300 ms) as arm+keepalive, `req_id` incrementing.
- **EventChannel** (TCP `:43267`): parse pushes; decode `event_id 192 / command 1` → `ShotDataEX1Schema.parse` → `decodeShot` (raw→SI, **assurance-null rule**) → dedup on `shotGuid` → emit `shot`. Also handle `192/4` device state and `command 51` ball-position → `ballDetected`. (Listen for shots on both ports; decode wherever they arrive.)
- **Connection state machine** with auto-reconnect + backoff (Mini sleeps); surface `localNetworkDenied` distinctly. `setClub(mode, clubType?)` / `setHandedness` send the appropriate control commands (only round-trip when the mode actually changes).
- **AC:** decodes `sample-shot.json` to the exact expected SI values (face/loft/lie/faceImpact = `null`); connects to a real Mini and streams deduped `MeasuredShot`s; recovers from power-cycle; denying Local Network yields `localNetworkDenied`, not a hang. Node-runnable protocol tests pass.

---

## WP2 — `libs/data` (`@golf/data`) · `claude/data` · persistence
**Consumes:** `@golf/types`. **Provides:** `DataStore`.
- `expo-sqlite` schema per BUILD_SPEC §7 (clubs, sessions, shots with measured SI columns + assurance columns + computed columns + `raw_json`, analyses). Versioned migrations.
- Typed DAO implementing `DataStore` exactly. Store measured SI as-is; nullable columns for null metrics and for `flight` until computed. `attachFlight` fills computed columns later.
- Dedup safety net: `shot_guid` unique constraint.
- **AC:** all `DataStore` methods round-trip; nulls persist as NULL (not 0); a discarded shot is retained with the flag; `listShotsByClub` works across sessions; migrations upgrade cleanly. Test with fixture `MeasuredShot`/`FlightResult`.

---

## WP3 — `libs/flight-model` (`@golf/flight-model`) · `claude/flight-model` · pure physics
**Consumes:** `@golf/types` only. **Provides:** `FlightModel`. **Spec:** FLIGHT_MODEL.md (authoritative — cited aero, do not invent coefficients).
- Implement `simulate(LaunchConditions, Environment) → FlightResult`: RK4 integration under gravity + drag + Magnus lift; air **density from altitude** (barometric/ISA); sidespin/rollspin curvature; spin decay; landing + rollout; emit full `path` + all scalars; `computed: true`.
- Fully unit-tested standalone (no device, no DB, no RN). Document coefficient sources in comments.
- **AC:** passes the validation targets in FLIGHT_MODEL.md; identical launch yields materially different carry at 6,000 ft vs sea level; sidespin produces lateral curvature of the correct sign; `path` monotonic in `t`, `y≥0`, ends at ground.

---

## WP4 — `libs/analytics` (`@golf/analytics`) · `claude/analytics` · local stats
**Consumes:** `@golf/types`. **Provides:** `AnalyticsEngine`.
**Mock strategy:** build against fixture `ShotRecord[]` (with and without attached `FlightResult`s) — no need to wait for WP2/WP3.
- Compute per-club and per-session `SessionSummary`/`ClubSummary` (CONTRACTS): `MetricStat` per metric with **measured `n`** (honor nulls — never average nulls as 0), dispersion geometry (center, ellipse, bias, spread), contact scatter, `pathFaceGapDeg`, spin stats, gapping (carry ladder, gaps, overlaps), and `baselineGap` when a baseline is supplied.
- Pure/deterministic; exclude `discarded` shots.
- **AC:** hand-checked means/sd over fixtures match; nulls excluded and reflected in `n`; dispersion ellipse + bias correct on a known pattern; gapping flags overlaps and oversized gaps.

---

## WP5 — `libs/analysis` (`@golf/analysis`) · `claude/analysis` · Claude client
**Consumes:** `@golf/types`, `@golf/analytics` (types). **Provides:** `AnalysisService`, `BaselineSet`.
**Mock strategy:** build against a mock `SessionSummary`. Domain-organized like the `regent/mono` API clients, Zod-validated.
- Secure key via `expo-secure-store` (never elsewhere); a lightweight validation call; clear "no key" path.
- **Payload builder:** send the **computed summary** + environment (mark which values are modeled) + relevant **baselines** + prior analyses — **never raw shot rows**. Scope-specific payloads for `session|club|trend|compare|diagnose|plan`.
- **Anthropic client:** `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`. **Streaming** (SSE) with `onDelta`. Request **structured output** and validate the parsed JSON with `AnalysisVerdictSchema`; also surface a short streamed narrative. System prompt = rigorous analyst (measured vs computed, small-n humility, cited baselines only, ruthless prioritization, drills tied to a measurable metric). Model constant: default `claude-sonnet-5`, deep = `claude-opus-4-8`. Map 401/429/5xx to typed errors.
- **Baselines:** load a curated, **cited** dataset (`Baseline[]`); `BaselineSet.get`. **Model never generates baseline numbers.** (Baseline *data* is provided by the owner — ship schema + placeholder; see note in README §4.)
- `chat()` for follow-up Q&A over the computed context.
- **AC:** with a valid key, produces a schema-valid `AnalysisVerdict` + narrative from a computed summary (no raw rows sent), streams progressively, persists via `DataStore.saveAnalysis`; bad/missing key → clear typed error; trend scope references change over time.

---

## WP6 — `libs/viz` (`@golf/viz`) · `claude/viz` · visualization
**Consumes:** `@golf/types`. **Provides:** pure components taking `FlightResult` / `SessionSummary` / `ShotRecord[]` props.
**Mock strategy:** build against fixture `FlightResult`s and summaries — no engine needed.
- **Trajectory (side):** `y` vs `x`; mark apex/carry/total/descent; ghost-overlay multiple shots.
- **Top-down (plan):** `z` vs `x`; target line, curved path, landing dot; derive shot-shape label.
- **Grouping (dispersion):** scatter landing points; ellipse + center + bias; respect `discarded` + null rule; outlier flagging.
- **Gapping:** carry-by-club ladder; overlaps + oversized-gap warnings.
- All views mark measured vs computed distinctly. SVG-based (`react-native-svg`/`victory-native`).
- **AC:** each view renders correctly from fixtures; overlay/ghost mode works; shot-shape label matches known draw/fade fixtures; dispersion excludes discarded shots.

---

## WP7 — `apps/fairway` · integration · **cross-domain wiring lives here only**
**Consumes:** everything. Depends on WP1–WP6 landing (screens can scaffold against mocks first; sub-screens can split across worktrees).
- **Store wiring:** `store` subscribes to `MonitorService` events → updates live slice → writes shots via `DataStore` → runs `FlightModel` per shot → attaches flight. Active-session + club selection (incl. create/switch club mid-session, reconfiguring sensor mode only on change).
- **Screens (expo-router):** connect/device; live capture (metrics with null rendering, ready indicator, computed distances marked, discard/flag); session + club management (quick-add club mid-session); session review (viz + stats); analysis (request per scope, streamed cards + narrative, follow-up chat); settings.
- **AC:** BUILD_SPEC Phase-1/2/3 acceptance criteria pass on device end-to-end: hit a ball → live metrics → persisted, tagged shot → flight-modeled distances → session stats + views → AI analysis.

---

## WP8 — polish · `claude/polish`
- CSV/JSON export (measured/computed separated, no secrets); trend charts across sessions; optional impact-image fetch (`/SCAMIMG/CURRENT/*.jpg`, use `shotImgPath` when present) attached to shots; reconnection hardening; iPad landscape layout; settings completeness (units at render-only, altitude presets feeding model + sensor, handedness).
- **AC:** BUILD_SPEC F8/F9 acceptance criteria pass.

---

### Parallelization summary
- **Serial:** WP0 → (freeze types) → Phase-1 fan-out → WP7 integration → WP8.
- **Parallel (Phase 1, six worktrees):** WP1, WP2, WP3, WP4, WP5, WP6 — none import each other; all against frozen `@golf/types` + fixtures. Merge order among them is arbitrary.
- **Prove first:** land WP0 + WP1 and verify on the real device (and `sample-shot.json`) before scaling the fan-out — it de-risks the one thing that can't be mocked (the physical device).
