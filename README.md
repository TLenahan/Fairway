# Fairway

Native iOS/iPad companion app for the **Uneekor EYE MINI** launch monitor:
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

## Renaming (placeholders)

`fairway` (app name) and `@golf/*` (npm scope) are the handoff placeholders.
To rename: find/replace `@golf/` across the repo, update `libs/*/package.json`
names, `tsconfig.base.json` + `apps/fairway/tsconfig.json` paths, and the
`name`/`slug`/`bundleIdentifier` in `apps/fairway/app.json`.
