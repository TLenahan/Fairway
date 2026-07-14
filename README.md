# Fairway

Companion app for the **Uneekor EYE MINI** launch monitor (Android phone is
the current primary device; iOS/iPad per the original spec still supported):
direct LAN connection (no PC, no Uneekor software), real-time shot capture,
sessions + clubs, an altitude-aware ball-flight model, local statistics, and
Claude-powered session analysis with your own Anthropic API key.

The complete build specification lives in [handoff/](handoff/README.md) —
start there. Verified protocol reference implementations are in
[reference/](reference/).

## Workspace

Nx integrated monorepo (Yarn 4 workspaces), matching the `regent/mono`
conventions:

- `apps/fairway` — Expo app (custom dev client — **cannot run in Expo Go**).
  Thin composition root: expo-router screens + wiring only.
- `libs/types` (`@golf/types`) — frozen Zod contracts. The seam everything
  builds against (see `handoff/CONTRACTS.md`).
- `libs/monitor` — EYE MINI protocol client (UDP discovery, TCP control/event
  channels, frame codec, shot decoder).
- `libs/data` — expo-sqlite DAO + versioned migrations.
- `libs/flight-model` — pure RK4 flight physics (see `handoff/FLIGHT_MODEL.md`).
- `libs/analytics` — local stats engine (dispersion, gapping, contact).
- `libs/analysis` — Anthropic API client + curated baselines.
- `libs/viz` — trajectory / top-down / grouping / gapping SVG views.
- `libs/store` — zustand slices wiring monitor → data → flight-model.
- `libs/ui` — shared primitives + theme.

Module boundaries are tooling-enforced (`@nx/enforce-module-boundaries`); every
lib imports only `@golf/types` (see `eslint.config.mjs`).

## Commands

```sh
yarn install                     # Node >= 22
yarn nx run-many -t typecheck lint test   # all projects
yarn nx test flight-model                 # one lib
yarn nx prebuild fairway                  # regenerate ios/ (CNG)

# Android release reinstall (from apps/fairway):
npx expo run:android --variant release --no-bundler
# CAUTION: Gradle only tracks JS under apps/fairway — after a libs/*-only
# change, force the bundle: cd android && ./gradlew :app:createBundleReleaseJsAndAssets --rerun
```

## Device build (required for real hardware)

Native TCP/UDP sockets need a custom dev client:

```sh
cd apps/fairway
eas init                         # once — links your Expo account
eas build --profile development --platform ios
```

Then `yarn nx expo:start fairway` and open from the dev client. iOS will prompt
for **Local Network** access on first connect — required, and denial fails
silently (the app surfaces a `localNetworkDenied` state).

## Status (July 2026 build)

Built and verified (all Node-testable ACs green — `nx run-many -t typecheck lint test`):

- WP0–WP7 complete: frozen contracts, monitor (decodes the captured fixture
  exactly, no cmd 217), data (tested vs real SQLite), flight-model (all
  FLIGHT_MODEL.md §7 bands incl. 6–9% altitude gain), analytics (hand-checked),
  analysis (streamed narrative + validated verdict, TrackMan-cited baselines),
  viz, store, and all screens.
- `expo prebuild` validated; NSLocalNetworkUsageDescription + NSBonjourServices
  confirmed in the generated Info.plist.

Not yet verified (needs the real device): discovery/connect/shot streaming
against the Mini, Local Network permission flow, sensor mode switching
(`clubtype` enums for tee/putter are still the observed-working default `20` —
override via `MonitorConfig.clubTypeByMode` once captured).

Not yet built (WP8): CSV/JSON export, cross-session trend charts, impact-image
fetch (`shotImgPath` is plumbed through), reconnection hardening beyond
backoff, iPad landscape polish.

## Renaming (placeholders)

`fairway` (app name) and `@golf/*` (npm scope) are the handoff placeholders.
To rename: find/replace `@golf/` across the repo, update `libs/*/package.json`
names, `tsconfig.base.json` + `apps/fairway/tsconfig.json` paths, and the
`name`/`slug`/`bundleIdentifier` in `apps/fairway/app.json`.
