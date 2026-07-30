# GoPro as a live per-shot clip source — feasibility verdict (2026-07-30)

Research verdict from the official Open GoPro specs (HERO10 is governed by the
versioned **Open GoPro 2.0** spec; the current docs site's "supported cameras"
badges only cover newer bodies — do not be misled by their absence).
Everything below applies to HERO 9–13 unless noted; wired USB control is 10+.

## Verdict: CONDITIONAL YES

The architecture works over one USB-C cable (power + control + download). The
single unverified load-bearing item is **Hindsight at ≥120fps** — no official
statement covers it, and one community report saw clip corruption with
Hindsight at 1080p60. That is the go/no-go bench item before buying a second
body.

## Confirmed against the official spec

- **Hindsight is API-controllable** (setting 167: `option=2|3|4` → 15s/30s/off)
  over HTTP `GET /gopro/camera/setting?setting=167&option=2` and BLE
  `03:A7:01:xx`. Marked experimental in the 2.0 spec.
- **Status 106** ("hindsight active") — poll `/gopro/camera/state` to confirm
  armed; watchdog it (community-reported ~15-min idle self-disarm).
- **Shutter over HTTP** (`/gopro/camera/shutter/start|stop`) — on HERO10 the
  HTTP server stays available while encoding (that limitation is HERO9-only);
  only *settings changes* are blocked while armed — arm Hindsight last.
- **Wired USB (NCM) control + media download** — HERO10 with firmware
  ≥ v01.30.00: `GET /gopro/camera/control/wired_usb?p=1`; camera IP is
  `172.2X.1YZ.51:8080` derived from the serial. ~40+ MB/s download
  (community-measured) → a ~9s 1080p120 clip (~60–110 MB) pulls in 2–4s.
- **Clock**: `set_date_time` works (no timezone variant on HERO10); don't
  trust it beyond ~1s — trimming is end-relative anyway.
- **Keep-alive**: `/gopro/camera/keep_alive` at least every 120s or the
  camera powers down.
- **Audio** rides Hindsight saves (GoPro support article).
- **External power**: fully functional on USB power, battery optional
  (batteryless runs cooler; battery-in = UPS against cable hiccups).

## Per-shot flow

Session start: enable wired control → set clock → load 1080p120 preset →
arm Hindsight 15s → confirm status 106 → start keep-alive + re-arm watchdog.

Per shot at monitor time T: `shutter/start` (locks the 15s pre-roll, records
forward) → `shutter/stop` at T+3.5 → poll `/gopro/media/list` with backoff
(503s during encode are normal; intermittent 404 is retryable) → download
over USB → **trim end-relative** (file end ≈ hub's stop-command time):
`ffmpeg -sseof -8.5 -i in.mp4 -c copy out.mp4` → confirm status 106 re-armed.

Cadence math: stop at T+3.5, next shot ≥ ~15s later → ~11s of buffer rebuilt
vs ~6s needed. Margin exists but is thin at fast shot spacing; buffer refill
rate after a save is undocumented (bench item).

## Bench test (30 min, priority order, on the first purchased body)

1. **Hindsight × 1080p120/240** — arm via API, capture, verify fps in the
   container, clean playback with audio. Go/no-go.
2. Trigger equivalence + timing — clapper test: does the saved clip contain
   ≥5s of pre-roll before the API trigger; measure command→lock latency.
3. Re-arm cycle — 10× trigger→stop→wait-12s→trigger; every clip has full
   pre-roll; status 106 re-arms unaided; no cooldown.
4. Pipeline latency — stop→file-visible and download times; total < 30s.
5. Sustained soak — 30 min armed on USB power (once batteryless); log
   battery %, temp warnings, self-disarms; verify idle-disarm watchdog.

## Purchase guidance

Same API + Hindsight on 9–13; wired USB control on 10+. Thermals (our duty
cycle keeps the encoder hot continuously): 12 ≈ 13 > 11 > 10 > 9. The plain
2024 "HERO" is disqualified (no high fps, no Hindsight). Buy ONE used body
(11 = value pick, 12 if the gap is small), bench it, then buy the matching
second for the two-view station only if item 1 passes. Phones remain plan A
until the bench passes.

Sources: Open GoPro HTTP/BLE 2.0 versioned specs (gopro/OpenGoPro repo,
`docs/specs/http_versions/http_2_0.md`, `ble_versions/ble_2_0.md`), GoPro
HERO10 HindSight support article, community reports (labeled).
