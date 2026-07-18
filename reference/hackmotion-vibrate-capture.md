# HackMotion on-device vibration — BLE capture decode (2026-07-18)

Source: Android btsnoop HCI log (Pixel 8 Pro) of the **vendor app** driving the
sensor's built-in vibration motor in its feedback mode. Tim triggered ~8–10
buzzes with pauses. `hackmotion-vibrate-2026-07-18.pcapng` beside this file is
the capture filtered to the HackMotion connection only (ACL handle 0x0041,
device `e0:72:91:77:4c:94`); the unfiltered log stays out of the repo — it
contains the rest of the household's BLE traffic.

All traffic uses the known Transparent-UART pipe characteristic
(`PIPE_CHAR_UUID`, ATT handle 0x0015 in this capture): commands are
write-without-response, replies/acks notify back on the same characteristic,
first reply byte echoing the request opcode — exactly the pattern
`libs/wrist/src/protocol.ts` documents.

## The vibrate command (now `OP_VIBRATE` in protocol.ts)

| bytes            | meaning                                    | evidence |
|------------------|--------------------------------------------|----------|
| `cb 01 27 10 64` | motor ON                                   | 8 writes, each starting a buzz |
| `cb 00`          | motor OFF                                  | 8 writes, each ending one |
| `cb 01` (notify) | ack — sent for BOTH the ON and OFF write   | 16 acks, one per write, ~30–45 ms after |

ON durations in the capture ran 0.4–4.2 s, always terminated by an explicit
OFF — the vendor app evaluates its feedback threshold on the phone and
starts/stops the motor over BLE (there is no device-side threshold config).

Presumed-but-unverified field meanings in the ON payload: `27 10` = 10000
big-endian (max duration ms, a failsafe the app never let expire) and `64` =
100 (intensity %). Neither byte was ever varied in the capture, so our code
replays the payload verbatim and times pulses with an explicit OFF (same rule
as `CMD_START_STREAM`'s opaque `0x7e`). If intensity control is ever wanted,
vary `64` against hardware first.

## Other vendor traffic seen (not implemented)

Connect sequence: `80`, `81` (battery), `84`, `86` (serial), `87` (token),
`85` (MAC) — then `a0 01 7e` (start stream, matches ours). Notable:

- `0x80` → reply `80 05 00 05 00 05 01 14` — undecoded status/version read
- `0x84` → reply `84 02 01` — undecoded
- `0x83` → reply `83 01` — undecoded
- `a2 00` / `a2 01` — sent around stream setup, both replied `a2 01`;
  possibly stream pause/resume — the app sent `a0 01 7e` again after
- `fb 01` — one unsolicited notify, meaning unknown

Battery polls (`81`) every ~30 s throughout, confirming the cadence
`wrist-service.ts` copies.

## Open hardware questions (answered only by a live test)

1. Does our replayed `cb 01 27 10 64` buzz the motor? (Near-certain; untested.)
2. Motor shock signature on the IMU: does a running motor push the shock
   channel toward the chip band's 6000-lsb gate? Until characterized from a
   capture taken WITH buzzing enabled, feedback code must keep the motor
   quiet through the impact window (rule recorded on `WristService.vibrate`).
3. Write→buzz latency (ack round trip observed ~30–45 ms; motor spin-up
   unknown) — needed before any in-backswing threshold buzz is designed.
