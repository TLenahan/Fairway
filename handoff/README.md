# Fairway — Uneekor EYE MINI companion app · handoff package

> **Placeholders to swap before starting:** npm scope `@golf/*` → your scope, and app name `fairway` → your chosen name. Everything else is build-ready.

This package is a **complete handoff for a coding agent** to implement a native iOS/iPad app that connects directly to a **Uneekor EYE MINI** launch monitor, captures shots in real time, organizes them into sessions/clubs, models ball flight, visualizes it, and analyzes practice with the Claude API.

**The hard part is already solved.** The launch monitor's wire protocol was reverse-engineered and verified against real packet captures — full spec in `BUILD_SPEC.md` Appendix A, with a working reference implementation in `reference/`. Do **not** re-derive it, add authentication, or use any Uneekor SDK (there is none).

---

## 0. Read in this order

1. **README.md** (this file) — repo structure, the subagent/worktree workflow, dependency graph, build order.
2. **BUILD_SPEC.md** — the product & technical spec: features, acceptance criteria, protocol appendix, data model. The "what to build."
3. **CONTRACTS.md** — the frozen interfaces (Zod schemas + inferred types) that live in `libs/types`. **The seams that make parallel work safe. Freeze these first; do not change them mid-build without a coordinated update.**
4. **WORK_PACKAGES.md** — the build decomposed into Nx libs, each a parallel worktree/subagent stream, with consumes/provides, mock strategy, and acceptance criteria.
5. **FLIGHT_MODEL.md** — authoritative physics spec for `libs/flight-model` (cited aero model — do not invent coefficients).
6. **reference/** — `protocol.js`, `discover.js`, `test-217.js` (verified reference impls to port to TS), `sample-shot.json` (canonical decode test vector).

---

## 1. Repository structure (Nx integrated monorepo, `apps/` + `libs/`)

Matches the `~/Documents/regent/mono` convention: Nx, workspace package manager (pnpm target with `node-linker=hoisted` scoped per-Expo-app via `.npmrc`, or Yarn workspaces), EAS for the Expo app, domain-organized libs with Zod schemas.

```
<repo-root>/
├── apps/
│   └── fairway/                 # Expo app — THIN composition root: expo-router screens + wiring only.
│                                #   No domain logic here; it imports libs and connects them.
├── libs/
│   ├── types/          @golf/types          # Zod schemas + z.infer types. LEAF. The frozen contracts (CONTRACTS.md).
│   ├── monitor/        @golf/monitor        # WP1 protocol + MonitorService (react-native-tcp-socket / -udp)
│   ├── data/           @golf/data           # WP2 expo-sqlite DAO + migrations
│   ├── flight-model/   @golf/flight-model   # WP3 pure physics engine (FLIGHT_MODEL.md)
│   ├── analytics/      @golf/analytics      # WP4 local stats engine
│   ├── analysis/       @golf/analysis       # WP5 Claude API client + baselines (domain-organized, Zod, streaming)
│   ├── viz/            @golf/viz            # WP6 trajectory / top-down / grouping / gapping components
│   ├── store/          @golf/store          # zustand slices (connection / live / active-session)
│   └── ui/             @golf/ui             # shared primitives + theme
├── nx.json
├── tsconfig.base.json               # path aliases: @golf/* -> libs/*/src/index.ts
├── package.json
├── eas.json                         # dev-client + build/update profiles (see BUILD_SPEC §2)
└── .npmrc / per-app .npmrc          # if pnpm: node-linker=hoisted for apps/fairway (Metro symlink compat)
```

Generators: create libs with `nx g @nx/js:lib` (pure libs: types, flight-model, analytics, analysis, monitor, data, store) and `nx g @nx/react:lib` for `viz`/`ui` (RN components). Create the app with `@nx/expo:app` (preferred) — it wires Metro + EAS. If `@nx/expo` isn't used in your mono, use `@nx/react-native:app`; the app must be a **custom dev client** build (native TCP/UDP modules — cannot run in Expo Go). See BUILD_SPEC §2–3.

---

## 2. Enforced module boundaries = the collision guard for parallel agents

Tag every project and turn on `@nx/enforce-module-boundaries` in eslint. Suggested tags: `type:app`, `type:feature`, `type:util`, `type:ui`, `type:types`, plus `scope:golf`. Dependency rules (an arrow = "may import"):

```
apps/fairway ──► (everything)         # composition root only; the ONLY cross-domain wiring point

store ──► types, monitor, data
analysis ──► types, analytics
analytics ──► types
data ──► types
viz ──► types
monitor ──► types
flight-model ──► types
ui ──► (nothing app-specific)
types ──► (nothing)                    # leaf
```

Nx rejects any import that violates this. That is what makes it safe for six agents to work at once: each builds against `@golf/types` (frozen) and cannot accidentally reach into another lib's internals — the boundary is tooling-enforced, not a convention.

---

## 3. The subagent / worktree workflow (your existing pattern)

This maps onto your `new-wt.sh` + parallel-Claude-Code setup. **The unit of parallel work is an Nx lib in its own worktree.**

**Phase 0 — sequential, on `main` (blocks everything):**
- Scaffold the Nx workspace, app shell, all empty libs with tags + boundaries.
- Implement `libs/types` fully from CONTRACTS.md (Zod schemas + types) and publish it.
- Stand up the SQLite migration harness and the zustand store skeleton (empty slices typed against `types`).
- **Freeze `libs/types`.** Commit. This is the seam everyone builds against.

**Phase 1 — parallel worktrees (one subagent each), all against frozen `@golf/types`:**

| Worktree branch | Lib | Depends on (real) | Mocks (until integration) |
|---|---|---|---|
| `claude/monitor` | `monitor` (WP1) | types | — (test vs `reference/` + fixture) |
| `claude/data` | `data` (WP2) | types | — |
| `claude/flight-model` | `flight-model` (WP3) | types | — (pure; unit-tested standalone) |
| `claude/analytics` | `analytics` (WP4) | types | fixture shots + fixture FlightResults |
| `claude/analysis` | `analysis` (WP5) | types, analytics | mock `SessionSummary` |
| `claude/viz` | `viz` (WP6) | types | fixture `FlightResult` + summaries |

Each stream is independently testable because the contract is frozen and the other libs are mocked with fixtures. `nx affected -t test lint typecheck` scopes CI to what changed. Merge order doesn't matter for these six — they don't import each other.

**Phase 2 — integration (sequential-ish, in `apps/fairway`):**
- Wire store ↔ monitor ↔ data; screens for connect, live capture, session/club management (incl. create/switch club mid-session), review, analysis, settings. Sub-screens can still be split across worktrees, but this phase is where cross-domain wiring is allowed (only here).

**Phase 3 — polish:** export, reconnection hardening, iPad layout, trend charts.

> Full per-package briefs (consumes/provides, acceptance criteria, reference material) are in **WORK_PACKAGES.md**. Each table row above corresponds to one work package there.

---

## 4. Non-negotiables (repeated here so no agent misses them — full detail in BUILD_SPEC §2)

1. **Cannot run in Expo Go** — native TCP/UDP → custom dev client via EAS + config plugin.
2. **iOS Local Network permission is mandatory and fails silently without it** — `NSLocalNetworkUsageDescription` + Bonjour placeholder; handle the prompt and a `localNetworkDenied` state.
3. **Store measured data as raw SI** (m/s, deg, rpm); convert to mph/yards only at render.
4. **Assurance-null rule:** `assurance_X === 0` ⇒ metric X is `null`, never `0`. Applies to storage, stats, display, export.
5. **Dedup shots on `shotGuid`** (the Mini re-pushes).
6. **Measured vs Computed vs Derived are structurally distinct** — the flight model's carry/total/apex are COMPUTED; the sensor never sends them (verified across the whole capture). Label estimates in UI; never conflate with sensor readings.
7. **No 217 handshake** — verified that shots stream unauthenticated (`reference/test-217.js`).
8. **Anthropic API key** — user-supplied, `expo-secure-store` only; never in SQLite, logs, or exports.
9. **Baselines are curated + cited; Claude never invents them** (see FLIGHT_MODEL.md is physics; baselines live in `libs/analysis`, CONTRACTS + BUILD_SPEC §10.4).

---

## 5. Verification gates

- **Phase 0 done when:** workspace builds, `libs/types` exports all CONTRACTS schemas, boundaries enforced (a deliberate illegal import fails lint), migrations run.
- **`monitor` done when:** decodes `reference/sample-shot.json` to the exact expected values (face/loft/lie = `null`), connects to a real Mini, streams deduped shots. (Use `reference/test-217.js` behavior as the integration check.)
- **`flight-model` done when:** unit tests pass against documented validation targets in FLIGHT_MODEL.md; carry at 6,000 ft differs meaningfully from sea level for identical launch.
- **`analytics` done when:** hand-checked means over fixtures match, nulls excluded, dispersion/gapping correct.
- **`analysis` done when:** builds a computed summary (not raw rows), streams a schema-valid `AnalysisVerdict`, handles 401/429/5xx, persists.
- **App done when:** Phase-1/2/3 acceptance criteria in BUILD_SPEC pass on device.

Build Phase 0 + `monitor` first and prove them on the real device before scaling out the rest.
