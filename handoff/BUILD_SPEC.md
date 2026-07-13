# Build Spec: "Fairway" — Uneekor EYE MINI Companion App (Expo / React Native)

> **You are a senior React Native / Expo engineer. Build the app described below.** The hardest part of this project — reverse-engineering the launch monitor's wire protocol — is **already done and verified against real packet captures**. The full protocol is specified in this document (see Appendix A). **Do not attempt to rediscover it, do not add authentication, do not use any Uneekor SDK (there isn't one).** Implement exactly what's specified. Where this doc marks something UNKNOWN, treat it as a config value or pass-through, don't block on it.
>
> **Repo structure:** ships as an **Nx monorepo** (`apps/fairway` + domain `libs/*`). Read **README.md** for the structure, the worktree-based subagent workflow, and the dependency graph; **CONTRACTS.md** for the frozen `libs/types` interfaces (Zod); **WORK_PACKAGES.md** for the parallelizable build units; **FLIGHT_MODEL.md** for the physics engine. This file is the product/feature reference — the "what." The domain modules named below (MonitorService, DataStore, FlightModel, AnalyticsEngine, AnalysisService, viz) each map to an Nx lib and a work package.
>
> Work in phases (see §9). Get Phase 1 (connect + live shots + persistence) fully working and verified against the sample shot fixture before moving on. Ask before introducing heavy dependencies not listed here.

---

## 1. What this app is

A native iOS/iPad app (Expo, custom dev client) that connects directly over the local network to a **Uneekor EYE MINI** golf launch monitor, captures every shot in real time, organizes shots into practice **sessions** and user-defined **clubs**, computes shot statistics locally, and offers **AI session analysis** via the user's own Anthropic API key.

The EYE MINI does all ball/club computer-vision solving onboard and broadcasts computed shot data over the LAN as plaintext JSON. This app is a client for that data. No PC, no Uneekor software, no cloud dependency for core function.

**Primary user:** a single golfer (the app owner) practicing at home into a net/simulator. Right-handed, plays at ~6,000 ft elevation. Data-integrity–obsessed: measured data must never be silently conflated with computed estimates.

**Platform priority:** iPad first (landscape, primary practice device), iPhone second. iOS only for v1. Android is a possible later target — keep the networking layer platform-agnostic but don't spend effort on Android now.

---

## 2. Non-negotiable engineering rules

These come from hard-won constraints. Violating them causes silent failure or corrupt data.

1. **This app CANNOT run in Expo Go.** It needs native TCP and UDP sockets. Build a **custom dev client** (`expo-dev-client`) via EAS and a config plugin. All native modules below require a prebuild/dev-client.
2. **iOS Local Network permission is mandatory and silently fails without it.** iOS 14+ blocks all LAN discovery/connection until the user grants Local Network access. You MUST set `NSLocalNetworkUsageDescription` and, because the device advertises over UDP broadcast + we connect to a raw IP, also declare a Bonjour service placeholder. Without this, UDP broadcast reception and the first TCP connect return nothing with no error. Handle the permission prompt explicitly on first connect and surface a clear "Local Network access is required" state if denied.
3. **Store measured data in raw SI units exactly as received.** The wire sends integers scaled ×1000 (e.g. `ballspeedx1000: 26092` = 26.092 m/s). Persist the SI float (m/s, degrees, rpm). Convert to display units (mph, yards) only at render time. Never store the display value as the source of truth.
4. **Respect the assurance/null rule.** Every club metric arrives with a companion `assurance_*` confidence (0–100). **If `assurance_X == 0`, metric X was not measured — store it as `null`, never as `0`.** A face angle of `0.0°` and "face angle not captured" are completely different, and conflating them corrupts every downstream average. This applies to storage, stats, display, and export.
5. **Deduplicate shots on `shotguid`.** The Mini re-pushes the same shot multiple times on the socket. Two shots are the same iff their `shotguid` (composite of Data1/Data2/Data3) matches. Ignore duplicates.
6. **Measured vs. Computed vs. Derived must be visually and structurally distinct.** Ball/club kinematics from the sensor are MEASURED. Carry/total/apex/descent are COMPUTED by our flight model (the sensor does NOT send them — see §5). Smash factor, per-session averages, dispersion are DERIVED. Tag each in the schema and label computed values in the UI (e.g. a small "est." marker) so the user always knows what the sensor actually saw.
7. **Never hardcode the Anthropic API key.** It's user-supplied, stored in `expo-secure-store`, and never written to SQLite, logs, or exports.

---

## 3. Tech stack (use these unless you have a strong reason)

- **Expo SDK (latest stable)** with **TypeScript** (strict mode). Custom dev client via **EAS Build**.
- **Networking (native modules, require dev-client):**
  - `react-native-tcp-socket` — raw TCP client for the control (:43266) and event (:43267) channels.
  - `react-native-udp` — UDP socket to receive the discovery broadcast on :43265.
- **Persistence:** `expo-sqlite` (relational; we need to query shot history for stats and analysis). Write a thin typed data-access layer; do not scatter raw SQL through components.
- **Secure storage:** `expo-secure-store` for the Anthropic API key.
- **State management:** `zustand` (lightweight). One store slice for connection/live-shot state, one for the active session. Persisted app data lives in SQLite, not the store.
- **Navigation:** `expo-router` (file-based) or React Navigation — your call, expo-router preferred.
- **Charts:** `victory-native` or `react-native-svg`-based custom (dispersion scatter, gapping bars). Keep charts in their own components.
- **HTTP:** built-in `fetch` for impact images (§ Appendix A.6) and the Anthropic API.

Keep the **protocol layer pure and dependency-light** so it can be unit-tested in Node against the sample fixtures. The provided reference files (`protocol.js`, `discover.js`, `test-217.js`) already implement and validate framing, discovery, and decoding — port/adapt them; don't reinvent.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ EYE MINI  (192.168.1.x on the LAN)                        │
│   UDP :43265  broadcast beacon (device announce)          │
│   TCP :43266  control  (we send commands, Mini acks)      │
│   TCP :43267  event    (Mini pushes state + shots)        │
│   HTTP :80    /SCAMIMG/CURRENT/*.jpg  impact images       │
└───────────────┬─────────────────────────────────────────┘
                │  LAN
┌───────────────▼─────────────────────────────────────────┐
│ App                                                       │
│  ┌─────────────────────────────────────────────────────┐│
│  │ MonitorService (singleton, EventEmitter)             ││  ← pure-ish TS, testable
│  │  • DiscoveryListener (UDP)                            ││
│  │  • ControlChannel (TCP :43266) → init + poll/keepalive││
│  │  • EventChannel  (TCP :43267) → frames → shots        ││
│  │  • FrameCodec (encode/decode 8-byte framed JSON)      ││
│  │  • ShotDecoder (raw→SI, assurance-null rule)          ││
│  │  • dedup(shotguid), connection state machine          ││
│  │  emits: 'device', 'state', 'ballDetected', 'shot',    ││
│  │         'connection', 'error'                         ││
│  └──────────────────────┬──────────────────────────────┘│
│           zustand store  │  (live shot, connection status)│
│  ┌──────────────────────▼──────────────────────────────┐│
│  │ SessionManager  → writes shots to SQLite, tags club  ││
│  │ StatsEngine     → per-club / per-session aggregates  ││
│  │ FlightModel     → carry/total/apex (COMPUTED, labeled)││
│  │ AnalysisService → builds prompt, calls Anthropic API ││
│  └──────────────────────┬──────────────────────────────┘│
│                    SQLite (sessions, shots, clubs)        │
│  UI (expo-router screens, zustand-driven)                 │
└───────────────────────────────────────────────────────────┘
```

**Connection lifecycle:** discover (or use saved IP) → open :43266 → send init sequence (Appendix A.4, **omit command 217**) → open :43267 and listen → start the 51/203 poll loop as arm-and-keepalive → on `event_id 192 / command 1` decode+dedup+emit shot. Auto-reconnect with backoff if a socket drops (the Mini sleeps). Poll cadence ~300 ms.

---

## 5. The distance problem (read this — it's the subtle one)

**The sensor sends kinematics only: speed, spin, launch angles, club delivery. It does NOT send carry, total, apex, descent angle, or flight time.** In Uneekor's own software those are computed client-side. So this app must compute them, and **elevation matters a lot** — the user is at ~6,000 ft (the device reports `altitude ≈ 1849 m` in its state), where the ball flies materially farther than at sea level.

Requirements:
- Implement a **`FlightModel`** module: input = measured launch conditions (ball speed, launch angle (VLA), launch direction (HLA), back/side/roll spin) + environment (altitude → air density, optionally temperature). Output = carry, total, apex height, descent angle, flight time, offline/lateral.
- Use a real projectile model with aerodynamic drag and lift (Magnus) as functions of spin and speed, numerically integrated, with **air density derived from altitude**. Do not use a flat "×1.1 for altitude" fudge. A standard golf-ball drag/lift model integrated with RK4 or small-step Euler is acceptable; document the coefficients and their source in comments.
- **Every FlightModel output is COMPUTED, never MEASURED.** Store separately, label in UI, and exclude from any claim of "sensor data." The user must always be able to tell measured from modeled.
- Environment is configurable with presets (see Settings, §6-F9): e.g. "Home ~6,000 ft", "Perry Park ~7,500 ft", plus a custom altitude field. This altitude feeds both the FlightModel and the sensor's altitude setting.
- Keep the model isolated and unit-tested so its assumptions can be audited independently. If exact-match to Uneekor's numbers proves impossible, prefer a transparent, documented model over a tuned black box.
- **Full module contract, view projections, and the analysis design are in §10** — build the FlightModel to the `FlightResult` output contract in §10.1, and build the trajectory / top-down / grouping / gapping views as projections of it (§10.2). Note: the device computes carry/total for its own E-Ink display but does **not** transmit them over the network (verified across the entire capture — no distance field exists on the wire), which is exactly why this model is required.

---

## 6. Feature requirements

Each feature lists acceptance criteria (AC). Build to the AC.

### F1 — Device connection & management
- Discover the Mini via its UDP broadcast beacon; show discovered device (model, serial, IP, firmware). Allow saving an IP for direct connect (skip discovery).
- Clear connection state machine surfaced in UI: `disconnected → discovering → connecting → connected → error`, plus a distinct `localNetworkDenied` state.
- Auto-reconnect with backoff when a socket drops; the Mini going to sleep should recover gracefully on wake.
- **AC:** Launching with the Mini on the LAN discovers it within a few seconds and reaches `connected`. Pulling the Mini's power shows `disconnected`/reconnecting; restoring power auto-recovers. Denying Local Network permission shows an actionable message, not a silent hang.

### F2 — Sessions
- Start / pause / end a session. A session has: id, start/end timestamps, optional name/notes, environment snapshot (altitude/preset used), and an ordered list of shots.
- Shots captured while a session is active are recorded to that session and tagged with the **currently selected club** (F3).
- No active session but a shot arrives → either buffer to an implicit "quick session" or prompt to start one (your call; make it non-blocking so the user never loses a shot).
- Session history list; open a past session to review all shots, per-club breakdowns, and stats (F6).
- **AC:** Starting a session, selecting a club, and hitting balls produces shot records attached to that session and club, in order, surviving app restart (persisted in SQLite). Ending and reopening the session shows the same shots.

### F3 — Clubs (including create-mid-session custom clubs) — **core requirement**
Clubs are an **app-level concept**, richer than the sensor's notion of a club.
- A **Club** has: id, display name (free text, e.g. "60° ½ swing", "Driver", "7i stock"), a **category** that maps to a **sensor mode** (see below), optional attributes (loft, notes, swing-length tag like `full`/`three-quarter`/`half`/`chip`), and active/archived flag.
- **Category → sensor mode mapping** (this is what the sensor actually cares about):
  - `Driver`/off-a-tee → sensor **Tee** mode
  - `Wood`/`Hybrid`/`Iron`/`Wedge` → sensor **Iron** (ground) mode
  - `Putter` → sensor **Putter** mode
  - A "60° half swing" is category `Wedge` → **Iron** mode. The half-swing is a label for analytics; the sensor doesn't distinguish it. This separation is the whole point — the user can create arbitrarily many analytical clubs that share a sensor mode.
- **Change club mid-session:** selecting a different club immediately re-tags subsequent shots. If the new club's sensor mode differs from the current one, send the appropriate control commands to reconfigure the Mini (Appendix A.4: set club/handedness for Tee vs Iron vs Putter). If the sensor mode is unchanged, no device round-trip is needed — just change the tag.
- **Create club mid-session:** a quick-add flow reachable from the live-capture screen (name + category + optional swing-length tag) that creates the club and selects it without ending the session. Must be fast — a few taps — because it happens between shots.
- Seed a sensible default club set on first run (Driver, common irons, a wedge or two, Putter) but let the user fully edit/rename/add/archive.
- **AC:** During a live session the user can (a) switch to an existing club and see following shots re-tagged, and (b) create "60° ½ swing" in a couple taps and have the very next shot tagged to it — all without ending the session. Switching between a Driver (Tee) and a wedge (Iron) reconfigures the sensor mode; switching between two irons does not trigger an unnecessary device round-trip.

### F4 — Live shot capture & display
- Real-time "ready" indicator driven by the ball-detection poll (Appendix A.5): show when a ball is detected in the hitting zone.
- On each shot: display the measured metrics immediately, prominently, in the user's units (F9). At minimum: ball speed, club speed, smash, launch angle (VLA), launch direction (HLA), back/side/roll spin, club path, attack angle, face angle, face impact — each shown only if measured (else a clear "—"/"n/a", never a fake 0).
- Show COMPUTED carry/total/apex (F5) clearly marked as estimates.
- Running shot list for the active session with the current club; tap a shot for full detail.
- Let the user **flag/discard** a shot (accidental trigger, obvious mishit) so it's excluded from stats but retained (soft-delete with a flag, per rule #6 don't destroy data).
- **AC:** Hitting a ball updates the live view within the shot-push latency with correct converted values; unmeasured fields render as "n/a" not "0"; computed distances are visibly marked; a discarded shot drops out of averages but remains viewable.

### F5 — Distance / flight model
- As specified in §5. Surface carry, total, apex, descent, flight time per shot, all labeled COMPUTED, using the session's environment/altitude.
- **AC:** Two identical launch conditions computed at 6,000 ft vs sea level yield meaningfully different carry (altitude actually affects the number), and every distance in the UI is marked as an estimate.

### F6 — Local statistics (compute on-device, before any AI)
- Per **club** (within a session and across all history): count, and for each measured metric the mean, median, std dev, min/max, and a consistency measure. **Dispersion**: lateral scatter and a shot-pattern scatter plot (offline vs carry). **Gapping**: carry distance by club, ordered, with gaps highlighted (the user cares about yardage gaps between clubs).
- Per **session**: totals, club mix, and the same aggregates.
- **All stats must honor the null rule** — never average `null`s in as `0`; report n-measured per metric where it differs from shot count.
- **AC:** A session with a driver and three wedges shows correct per-club means (excluding discarded/unmeasured), a dispersion scatter, and a gapping view; hand-checking a mean against the raw shots matches.

### F7 — AI session analysis (Anthropic API) — **core requirement**
Let the user get a natural-language analysis of a session (or a club, or a trend across sessions) from Claude, using **their own API key**.
- **Key management:** a Settings field to paste an Anthropic API key, stored in `expo-secure-store`, validated with a lightweight test call, never persisted elsewhere. Clear "no key set" state that routes the user to Settings.
- **Do the math locally; let Claude interpret.** Do NOT dump raw shot rows and ask Claude to compute averages. Compute the F6 stats on-device, then send Claude a compact structured JSON summary (per-club aggregates, dispersion, gapping, notable patterns, and — for trend analysis — the same summaries from prior sessions) and ask for coaching-style interpretation: what's consistent, what's the biggest scoring leak, patterns (e.g. hook/slice bias, low face-contact consistency), and 2–3 focused practice suggestions. This is cheaper, more reliable, and keeps the model doing what it's good at.
- **Request shape (direct HTTPS from the app):**
  - Endpoint: `POST https://api.anthropic.com/v1/messages`
  - Headers: `x-api-key: <user key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`. (React Native's `fetch` is native — no browser CORS. If a webview-based fetch is ever used, add `anthropic-dangerous-direct-browser-access: true`.)
  - Body: `{ model, max_tokens, system, messages: [{ role: "user", content: <structured summary + instructions> }] }`
  - **Model:** default to **`claude-sonnet-5`** (fast, strong, cheaper); offer **`claude-opus-4-8`** as a "deep analysis" toggle. Make the model id a constant that's easy to update — model ids change over time. (For reference at time of writing: Sonnet 5 ≈ \$3/\$15 per Mtok, Opus 4.8 ≈ \$5/\$25 per Mtok.)
  - **Stream the response** (`"stream": true`, parse SSE) so analysis renders progressively. Handle `stop_reason`, and surface API errors (401 bad key, 429 rate limit, overloaded) as clear UI states.
- **A `system` prompt** that frames Claude as a golf performance analyst who is rigorous about data, distinguishes measured from computed inputs, avoids over-claiming from small samples, and gives specific, prioritized, non-generic feedback. Include the environment (altitude) and note which distances are modeled estimates so Claude doesn't treat them as measured.
- Persist each analysis with its session so it can be re-read offline.
- **AC:** With a valid key, requesting analysis of a session sends locally-computed summaries (not raw rows), streams back a specific, data-grounded critique naming the actual weak areas and a few drills, and stores it on the session. A bad/missing key produces a clear, actionable error rather than a crash. Trend analysis across several sessions references change over time.

### F8 — History, review, export
- Browse sessions and clubs over time; per-club trend charts (e.g. carry, smash, dispersion over sessions).
- **Export** a session (and/or all data) as CSV and JSON. Export includes measured SI values, computed estimates (clearly labeled), club tags, and metadata. The API key is never exported.
- Optional: attach the impact images (Appendix A.6) to shots by pulling `/SCAMIMG/CURRENT/*.jpg` shortly after each shot; store locally and show in shot detail. Treat as best-effort / nice-to-have.
- **AC:** A session exports to well-formed CSV and JSON with measured/computed clearly separated and no secrets; trend charts render across multiple sessions.

### F9 — Settings
- Units: speed (mph / m/s), distance (yards / meters), spin (rpm). Default mph/yards. Applies at display only.
- Environment/altitude presets + custom altitude (feeds FlightModel and sensor altitude).
- Handedness (default right). Maps to the sensor handedness command.
- Anthropic API key (F7) + model selection (Sonnet 5 default / Opus 4.8 deep).
- Saved device IP / re-run discovery.
- **AC:** Changing units instantly reformats all displayed values without altering stored data; changing altitude changes computed distances; handedness change reconfigures the sensor.

---

## 7. Data model (SQLite)

Design the schema to make per-club and per-session queries for stats/analysis straightforward. Suggested tables (adapt as needed, keep the intent):

- **clubs**: `id`, `name`, `category` (enum: Driver/Wood/Hybrid/Iron/Wedge/Putter), `sensor_mode` (enum: Tee/Iron/Putter, derived from category), `swing_tag` (nullable: full/three_quarter/half/chip), `loft` (nullable), `notes`, `archived`, `created_at`.
- **sessions**: `id`, `name` (nullable), `notes`, `started_at`, `ended_at` (nullable), `altitude_m`, `env_preset` (nullable), `created_at`.
- **shots**: `id`, `session_id` (fk), `club_id` (fk), `shot_guid` (unique — dedup key), `captured_at`, `impact_timestamp` (raw device value), `discarded` (bool),
  - MEASURED (SI floats, nullable when assurance 0): `ball_speed_ms`, `launch_angle_deg`, `launch_direction_deg`, `backspin_rpm`, `sidespin_rpm`, `rollspin_rpm`, `club_speed_ms`, `club_path_deg`, `face_angle_deg`, `attack_angle_deg`, `loft_deg`, `lie_deg`, `face_impact_h_mm`, `face_impact_v_mm`,
  - assurance columns (ints) for each club metric so the null-reason is auditable,
  - COMPUTED (from FlightModel, nullable): `carry_m`, `total_m`, `apex_m`, `descent_deg`, `flight_time_s`, `offline_m`,
  - `raw_json` (the full decoded envelope, for forward-compat / debugging).
- **analyses**: `id`, `session_id` (fk), `scope` (session/club/trend), `model`, `created_at`, `content` (the returned text), `input_summary_json` (what we sent).

Keep a typed data-access layer; migrations versioned.

---

## 8. Provided assets (already built & verified — port these, don't rebuild)

- `protocol.js` — frame codec (`FrameParser` handling TCP segmentation + resync; `encode`), and `decodeShot` implementing the raw→SI conversion and the assurance-null rule. **This is the reference implementation of Appendix A.2 and A.7.**
- `discover.js` — UDP beacon listener (Appendix A.1).
- `test-217.js` — connects, runs the init sequence **without** command 217, and confirms shots stream unauthenticated. Confirmed working against the real device: shots arrive with no auth. **This is why the app performs no handshake.**
- Sample shot fixture (Appendix A.8) — use as a unit-test vector for `decodeShot` (expected: ball 58.4 mph, club 56.7 mph, smash ~1.03, launch 25.63°, direction −2.01°, backspin 6918 rpm, attack −6.2°, and **face angle `null`** because its assurance is 0).

Port the JS logic to TypeScript inside the `MonitorService`. Preserve behavior exactly; add types.

---

## 9. Build phases

1. **Phase 1 — Core capture loop.** Dev-client + native sockets + Local Network permission handling. `MonitorService`: discovery, connect, init (no 217), poll/keepalive, frame decode, dedup, shot emit. SQLite schema + sessions + clubs (incl. create/switch mid-session) + live capture screen showing measured metrics with the null rule. Verify against the real device and the sample fixture. **Ship this working before anything else.**
2. **Phase 2 — Flight model, visualization & stats.** FlightModel to the §10.1 output contract (altitude-aware, cited coefficients, labeled computed). The four views as projections of it (§10.2): trajectory/side, top-down/shot-shape, grouping/dispersion, gapping. Analytics engine (§10.3, per-club/session, dispersion, contact, path-face, gapping) honoring nulls. Session review UI.
3. **Phase 3 — AI analysis.** Secure key storage, curated cited baselines (§10.4), local-summary builder, streaming Anthropic call with **structured JSON output** rendered as cards + narrative (§10.5), analysis persistence, conversational follow-up (§10.6), and trend analysis across sessions.
4. **Phase 4 — History, export, polish.** CSV/JSON export, trend charts, optional impact images, settings, reconnection hardening, iPad layout polish.

Deliver each phase runnable. Prefer correctness and data integrity over feature count.

---

## 10. Expanded design: Flight Model, Visualization & Analysis

This section elaborates F5/F6/F7. Two hard architectural ideas:

- **One flight engine, many views.** Do not build separate calculators for the trajectory, top-down, and grouping screens. Build ONE flight model that outputs the full 3D ball path; every per-shot view is a projection of that same path, and the multi-shot views consume the landing points.
- **Analysis = compute locally, interpret with Claude.** A local analytics engine produces every number; Claude turns those numbers into a coach's read. The LLM never does arithmetic and never invents reference data.

### 10.1 FlightModel — the engine everything depends on
Isolated, pure, unit-tested TypeScript module. No UI, no DB.

- **Input:** measured launch conditions — ball speed (m/s), launch angle/VLA (deg), launch direction/HLA (deg), backspin, sidespin, rollspin (rpm) — plus environment `{ altitude_m, temperature_c? }`.
- **Physics:** numerically integrate (RK4, small fixed step) under gravity + aerodynamic **drag** + **Magnus lift**, with drag/lift coefficients as functions of spin ratio and Reynolds/speed. **Ground the coefficients in a published aerodynamic model and cite the source in code comments** (e.g. a USGA/Quintavalla-style golf-ball trajectory model or Bearman–Harvey wind-tunnel fits). No invented coefficients — this is a data-integrity requirement, not a preference.
- **Altitude done right:** derive air **density** from the barometric formula (temperature-adjustable), not a flat distance multiplier. At ~6,000 ft the ~20% density drop affects both drag and lift and is a first-class input.
- **Shot shape:** side + roll spin must curve the path (draw/fade/hook/slice and lateral finish). A straight arc that ignores sidespin is a bug.
- **Spin decay** over flight, a **landing** event, and a **simple rollout** so `total` ≠ `carry`.
- **Output contract (the API every view builds against):**
  ```ts
  interface FlightResult {
    path: Array<{ t: number; x: number; y: number; z: number }>; // x=downrange, y=height, z=lateral(+right); meters
    carry_m: number; total_m: number; apex_m: number;
    descent_deg: number; flightTime_s: number; offline_m: number; // signed lateral finish
    landing: { x: number; z: number }; rollout_m: number;
    computed: true; // never conf<em>use with measured
  }
  ```
- Every field is COMPUTED. Persist per shot (schema §7) and label as estimates in UI.

### 10.2 Views — all projections of `FlightResult.path` (or landing points)
- **Trajectory (side profile / tracer):** plot `y` vs `x`. Mark apex, carry, total, descent angle; numeric readout beside. 2D SVG first; optional 3D later. Ghost-overlay mode to stack multiple shots' arcs for height/shape consistency.
- **Top-down (plan view / shot shape):** plot `z` vs `x`. Target line down the middle, the **curved** path, landing dot. Derive a **shot-shape label** (straight/draw/fade/hook/slice/pull/push) from start direction + curvature + face.
- **Grouping / dispersion (multi-shot):** scatter `landing.{x,z}` for a club or session. Overlay a **dispersion ellipse / pattern bounds**, the **pattern center**, and the systematic **bias** (consistently left? short?). Respect the discard flag and the assurance-null rule so junk shots don't distort the pattern; flag outliers.
- **Gapping:** carry-by-club ladder/bar across the bag, gaps highlighted; warn on **overlaps** (two clubs at the same carry) and **oversized gaps**.
- Cross-cutting: every view marks measured vs computed distinctly; all read from the same `FlightResult` outputs (one source of truth).

### 10.3 Analytics engine (local) — the facts fed to Claude
Pure module over the stored shots. Produces a compact `SessionSummary` / `ClubSummary` used by both the stats UI (F6) and the analysis payload (F7). Computes, per club and per session:

- **Central tendency + spread** per measured metric: mean, median, std dev, min/max, and **n-measured** (may be < shot count because of the null rule — report it).
- **Dispersion geometry:** landing-pattern center, ellipse size, lateral & depth spread, directional **bias**.
- **Contact quality:** face-impact scatter summary (heel/toe, high/low centroid + spread) and smash-factor consistency — directly relevant to strike issues.
- **Delivery patterns:** **path-vs-face gap** (the driver of curvature), attack-angle consistency, spin-loft.
- **Spin control:** backspin mean/variance by club (wedge spin consistency).
- **Gapping:** carry ladder, overlaps, gaps.
- **Gap-to-baseline:** the delta between the golfer's numbers and a cited baseline (10.4).

Everything here is arithmetic — **local, deterministic, testable. Claude never recomputes it.**

### 10.4 Baselines (curated, published, cited)
- Ship a **static, curated baseline dataset** of reference launch/spin/smash/dispersion numbers by club and player level (e.g. tour, scratch, handicap bands), **each entry carrying its published source**. This is the gap-to-scratch reference for a 15.5 → scratch goal.
- Claude interprets the golfer's **gap** to a known baseline. **Claude must never generate or estimate baseline numbers** — if a baseline isn't in the dataset, the gap isn't claimed. Treat this as strictly as the measured/computed rule.

### 10.5 Analysis service (Claude interpretation layer)
- **Scopes:** `session` | `club` | `trend` | `compare` | `diagnose` | `plan` (§F7-scope list). Each builds a scope-appropriate payload from the analytics engine (+ prior analyses for `trend`).
- **Payload to Claude:** the computed `SessionSummary`/`ClubSummary`, the environment (altitude; which values are modeled estimates), relevant **baselines**, and prior analyses for continuity. **Never raw shot rows for the model to aggregate.**
- **Structured output:** request a **structured/JSON-schema response** so analysis is machine-renderable, not just prose:
  ```jsonc
  {
    "headline": "single biggest scoring leak, one sentence",
    "issues":   [{ "area": "face control", "severity": "high", "evidence": "avg face +3.2° open, path -1°", "why": "..." }],
    "strengths":[{ "area": "...", "evidence": "..." }],
    "drills":   [{ "name": "...", "goal": "...", "howMeasured": "which metric to watch improve" }],
    "caveats":  ["only 6 shots — directional, not conclusive", "..."]
  }
  ```
  Render as cards; also stream a short narrative. Persist both (schema `analyses`).
- **System prompt:** frames Claude as a rigorous golf performance analyst who (a) distinguishes measured from computed inputs, (b) refuses to over-claim from small samples, (c) uses only the provided baselines, (d) prioritizes ruthlessly (name the ONE leak), and (e) gives specific drills tied to the metric that should move. Include altitude and the measured/computed distinction explicitly.
- **Model:** default `claude-sonnet-5`; `claude-opus-4-8` for a "deep analysis" toggle (constant, easy to update). Stream via SSE; map 401/429/5xx to clear UI states.
- **Continuity:** persisted analyses feed the next `trend`/`session` run so the tool builds a longitudinal narrative rather than re-diagnosing from scratch.

### 10.6 Conversational follow-up
- On any analyzed session/club, allow a **chat** where the golfer asks questions ("what changed after the grip switch?", "why left with driver?"). The computed summary + prior analysis are the context; do not re-send raw rows. Persist the thread with the session.

**Scope note:** full strokes-gained (position-based scoring analysis) is out of scope here — it needs on-course data and belongs to the separate Divot project. This tool covers what launch-monitor practice data supports: delivery, contact, dispersion, gapping, and gap-to-baseline.

---

## Appendix A — EYE MINI protocol (verified from packet capture; implement exactly)

All JSON, all plaintext. **No TLS. No authentication required.** Device observed at `192.168.1.10`; discover the real IP at runtime.

### A.1 Discovery — UDP broadcast :43265
The Mini broadcasts to the subnet broadcast address on UDP **43265**, ~once/second, a JSON beacon:
```json
{"device":{"devGuid":[16 ints],"modelName":"EYEMINI","hwVersion":"5010",
"swVersion":"2.7.8","serialNumber":"501000330615",
"hashKey":"E443…(64 hex)","networkInfo":{"interface":"wlan0",
"ipaddr":"192.168.1.10","mac":"D8:3A:DD:5A:28:95"}}}
```
Bind a UDP socket (broadcast enabled) to 43265 and listen; parse `device.networkInfo.ipaddr`. (`hashKey` would be the key material for the 217 handshake — **which we don't use**.) Also allow a user-saved IP to bypass discovery.

### A.2 Frame format (verified on every frame)
```
[0x99 0x01] [0x28 0x28] [uint32 big-endian length] [JSON body of exactly <length> bytes]
```
8-byte header: 2-byte magic `0x9901`, 2-byte sync `0x2828`, 4-byte BE length, then the JSON. To parse a TCP stream: sync on `0x2828`, read the following BE uint32, read that many bytes = one JSON message. **Handle messages split across TCP segments and multiple messages per segment** (the reference `FrameParser` does both). Encode the same way for outbound requests.

### A.3 Message envelope
Client → Mini (request):
```json
{"header":{"hard_key":82,"event_id":<int>,"command":<int>,"req_id":<int>,"length":<paramBytes>},"param":<obj|null>}
```
Mini → client (response/ack):
```json
{"header":{"status":0,"answer":<event_id+1>,"command":<int>,"ack_id":<req_id>,"length":<n>},"param":<obj|null>}
```
`hard_key` is constant `82`. `status:0` = OK. `answer` = request's `event_id`+1. `ack_id` echoes `req_id`.

### A.4 Connection init sequence (control channel :43266) — **OMIT command 217**
Open TCP to :43266 and send, in order (this is the real View sequence with the encrypted `command:217` step **removed** — verified that shots still stream without it):

| event_id | command | param | meaning |
|---|---|---|---|
| 178 | 0 | `{"sensorcode":178,"sensornum":0,"p0":0,"p1":0,"p2":0,"p3":0}` | sensor init |
| 176 | 48 | `null` | session init |
| ~~176~~ | ~~217~~ | ~~encryptedData0~~ | **SKIP — auth handshake, not needed** |
| 176 | 33 | `{"club":20}` | set club type (see UNKNOWN below) |
| 176 | 36 | `{"rightLeft":0}` | handedness (0 = right) |
| 176 | 37 | `{"unitDistance":16,"unitSpeed":32}` | device unit enums (opaque; see UNKNOWN) |

Then enter a **poll/keepalive loop**: repeatedly send `event_id 176, command 51` (ball-position poll) with an occasional `event_id 176, command 203` (status), ~every 300 ms, incrementing `req_id`. Observed cadence was three `51`s then one `203`, repeating. This loop both arms ball detection and keeps the connection alive.

**Sensor mode selection (Tee / Iron / Putter):** to change club category mid-session, re-send the club/handedness commands appropriate to the target mode. Device state exposes `allowTee`/`allowIron`/`allowPutter` booleans and a `clubtype` int. **UNKNOWN:** the exact `clubtype` enum values and the exact `unitDistance`/`unitSpeed` enum meanings. Observed working value `clubtype: 20` with iron mode. Treat `clubtype` and the unit enums as configurable pass-through constants; expose an advanced override; default to the observed-working values. Determine Tee/Putter specifics empirically if needed (capture View switching modes, or probe) — do not block core capture on this; iron-mode capture works with the values above.

### A.5 Ball detection (poll response, :43266)
Responses to `command 51` carry ball position, e.g.:
```json
{"header":{...,"answer":177,"command":51,...},
 "param":{"teeBallPos":{"ballexist":0,"shotresult":0,"x":0,"y":0,"z":0},
          "ironBallPos":{"ballexist":0,...}}}
```
`ballexist:1` in the relevant position object = ball detected in the hitting zone → drive the "ready" indicator.

### A.6 Device state & shots (event channel :43267)
Open a second TCP connection to :43267 and listen. The Mini pushes:
- **Device state:** `event_id 192, command 4`, `param.statedata` = `{rightleft, clubtype, allowTee, allowIron, allowPutter, unitDistance, unitSpeed, altitude, altitude_mode}`. `altitude` is meters (~1849 at the test site). Use to seed/verify environment; reflect handedness/mode.
- **Shot:** `event_id 192, command 1`, `param.shotdataEX1` = the full measured shot (schema A.7). This is the payload to decode, dedup (on `shotguid`), and record. (Shots may also appear on :43266 in some cases — listen on both and decode `event_id 192 / command 1` wherever it arrives.)

### A.7 Shot data schema — `shotdataEX1`
Integers scaled **×1000** unless noted; base units are **SI** (m/s, degrees, rpm). Every club metric has a companion `assurance_*` (0–100); **assurance 0 ⇒ that metric is `null`, not `0`.**

| Field | Scale | Meaning / unit |
|---|---|---|
| `shotguid` `{Data1,Data2,Data3,Data4[]}` | — | unique shot id → **dedup key** (use Data1-Data3) |
| `category` | — | shot/club category code (opaque) |
| `rightlefthanded` | — | 0 = right, 1 = left |
| `xposx1000`,`yposx1000`,`zposx1000` | ×1000 | ball position at impact |
| `ballspeedx1000` | ×1000 | ball speed, m/s |
| `inclineX1000` | ×1000 | launch angle / VLA, degrees |
| `azimuthX1000` | ×1000 | launch direction / HLA, degrees (− = left) |
| `backspinX1000` | ×1000 | backspin, rpm |
| `sidespinX1000` | ×1000 | sidespin, rpm (+ = right) |
| `rollspinX1000` | ×1000 | roll spin, rpm |
| `spincalc_method`, `assurance_spin` | — | method; spin confidence 0–100 |
| `clubspeedX1000` | ×1000 | club head speed, m/s |
| `clubpathX1000` | ×1000 | club path, degrees (− = out-to-in/left) |
| `faceangleX1000` | ×1000 | face angle, degrees |
| `attackangleX1000` | ×1000 | angle of attack, degrees (− = descending) |
| `loftangleX1000` | ×1000 | dynamic loft, degrees |
| `lieangleX1000` | ×1000 | lie angle, degrees |
| `faceimpactLateralX1000`, `faceimpactVerticalX1000` | see note | face impact location (mm-ish; treat scale as ×1 unless validated) |
| `clubcalc_method` | — | club calc method |
| `assurance_clubspeed`,`assurance_clubpath`,`assurance_faceangle`,`assurance_attackangle`,`assurance_loftangle`,`assurance_lieangle`,`assurance_faceimpactLateral`,`assurance_faceimpactVertical` | — | per-metric confidence 0–100 (**0 ⇒ null**) |
| `impactTimestamp` | — | device impact timestamp (opaque epoch; store raw) |

Derived: **smash = ball_speed / club_speed** (only when club speed measured). Carry/total/apex/etc. are **not present** — compute via FlightModel (§5).

### A.8 Sample shot fixture (real capture — use as decode unit test)
```json
{"shotguid":{"Data1":1416080389,"Data2":2629,"Data3":29505,"Data4":[141,221,212,38,68,171,190,183]},
"category":12,"rightlefthanded":0,"xposx1000":167,"yposx1000":-202,"zposx1000":59,
"ballspeedx1000":26092,"inclineX1000":25630,"azimuthX1000":-2011,
"spincalc_method":2,"assurance_spin":97,
"backspinX1000":6918153,"sidespinX1000":1396358,"rollspinX1000":1028395,
"clubcalc_method":2,"assurance_clubspeed":95,"assurance_clubpath":95,"assurance_faceangle":0,
"assurance_attackangle":95,"assurance_loftangle":0,"assurance_lieangle":0,
"assurance_faceimpactLateral":0,"assurance_faceimpactVertical":0,
"clubspeedX1000":25357,"clubpathX1000":-1867,"faceangleX1000":0,"attackangleX1000":-6200,
"loftangleX1000":0,"lieangleX1000":0,"faceimpactLateralX1000":0,"faceimpactVerticalX1000":0,
"impactTimestamp":1783975921445500}
```
Expected decode (mph/deg): ball **58.4 mph**, club **56.7 mph**, smash **≈1.03**, launch **25.63°**, direction **−2.01°**, backspin **6918 rpm**, sidespin **1396 rpm**, club path **−1.87°**, attack **−6.2°**, and **face angle / loft / lie / face-impact = `null`** (assurance 0). A test that returns `0.0` for face angle here is **wrong**.

### A.9 Impact images — HTTP :80
The Mini runs a plain Apache server. Impact/Swing-Optix frames are individual JPEGs in an open directory:
```
GET http://<mini-ip>/SCAMIMG/CURRENT/ballimpact.jpg
GET http://<mini-ip>/SCAMIMG/CURRENT/image1_0000.jpg   (sequence frames)
GET http://<mini-ip>/SCAMIMG/CURRENT/                  (directory listing)
```
Best-effort: after a shot, fetch and attach to the shot record for review.

---

## Appendix B — Anthropic API quick reference (for F7)

- **Endpoint:** `POST https://api.anthropic.com/v1/messages`
- **Headers:** `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`
- **Body:** `{ "model": "...", "max_tokens": <n>, "system": "<analyst framing>", "messages": [{"role":"user","content":"<structured session summary + analysis instructions>"}], "stream": true }`
- **Models:** default `claude-sonnet-5`; deep-analysis option `claude-opus-4-8`. Keep as an updatable constant.
- **Streaming:** SSE; accumulate `content_block_delta` text; respect `message_stop`/`stop_reason`; map 401/429/5xx to clear UI states.
- **Send computed summaries, not raw shot rows.** Key never leaves `expo-secure-store`; never logged or exported.

---

*End of spec. Build Phase 1 first and verify against the real device and the A.8 fixture before proceeding.*
