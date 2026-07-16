# `@golf/wrist` — HackMotion wrist sensor

A second data source alongside the EYE MINI: a BLE dual-IMU wrist unit whose
reverse-engineered protocol was solved in the `hackmotion` repo and ported here.
This lib is the peer of `@golf/monitor` — same shape (a service that emits typed
events), BLE instead of the network.

## What's in the lib (all Node-tested, no device needed)

| File | Role |
|---|---|
| `protocol.ts` | UUIDs, opcodes, start command (`a0 01 7e` / base64 `oAF+`). Writes go to the pipe char only — the OTA characteristics reboot the unit. |
| `record-codec.ts` | 0x90 telemetry decode (23 × int16 BE, Q14 quaternions) + battery/serial replies. Port of `stream.py`. |
| `quaternion.ts` / `linalg.ts` | Quaternion math + a Jacobi eigensolver (Markley average, PCA). |
| `calibration.ts` | Anatomical-axis calibration (PCA + nearest-rotation frame + gimbal-safe Euler). Port of `analyze.py axes`; `calibration.spec.ts` is the recovers-axes selftest. |
| `swing-detector.ts` | Streaming swing detection — device-clock-timed angular speed, hysteresis, address/top/impact/shock. Port of `analyze.py swings`. |
| `ble-transport.ts` | The narrow BLE seam (interface only). |
| `wrist-service.ts` | `HackMotionWristService implements WristService` — scan → connect → stream → emit `swing`. |

The contract types (`WristShot`, `WristService`, …) live in `@golf/types`
(`wrist.ts`); `ShotRecord` gained an optional `wrist`. The store correlates
`swing` events to launch-monitor shots by **arrival time** (±1.5 s) — both
devices' clocks are opaque and unsynced, so arrival time is the only join key.
Persistence: `libs/data` migration **v4** adds a `wrist_json` column and
`DataStore.attachWrist`.

## Status: wired into the app

Steps 1–3 below are DONE (kept for reference): `react-native-ble-plx` is
installed with its config plugin, the native transport lives at
`apps/fairway/src/services/rn-ble-wrist-transport.ts` (plus scan-robustness
beyond the sketch: deferred scan-until-PoweredOn, surfaced scan errors,
Android 12+ runtime permission requests, auto-restart across radio flips),
and `app-services.ts` passes the service to the store. The pairing surface is
ConnectScreen's "Wrist sensor" section; `@golf/drill` + the drill screen
consume the `swing` events. Step 4 (dev-client rebuild) must be re-run on any
machine whose client predates these native modules.

### 1. Install the package

```bash
cd apps/fairway
yarn add react-native-ble-plx
```

Add its config plugin to `apps/fairway/app.json` `plugins` (the Bluetooth
permission strings are already in `app.json`):

```json
["react-native-ble-plx", { "isBackgroundEnabled": false }]
```

### 2. Add the native transport (the one file that touches the native module)

Create `apps/fairway/src/services/rn-ble-wrist-transport.ts`:

```ts
import { WristServiceConfig } from '@golf/types'; // types only
import {
  HackMotionWristService,
  PIPE_CHAR_UUID,
  PIPE_SERVICE_UUID,
  WristBleConnection,
  WristBleDevice,
  WristBleTransport,
  BleAvailability,
} from '@golf/wrist';
import { Buffer } from 'buffer';
import { BleManager, Device, State } from 'react-native-ble-plx';

const toB64 = (data: Uint8Array): string => Buffer.from(data).toString('base64');
const fromB64 = (b64: string): Uint8Array =>
  new Uint8Array(Buffer.from(b64, 'base64'));

function makeTransport(manager: BleManager): WristBleTransport {
  let cachedState: State = State.Unknown;
  void manager.state().then((s) => (cachedState = s));
  manager.onStateChange((s) => (cachedState = s), true);

  return {
    startScan(onDevice: (d: WristBleDevice) => void): void {
      manager.startDeviceScan(null, null, (error, device) => {
        if (error || !device) return;
        onDevice({ id: device.id, name: device.name ?? device.localName });
      });
    },
    stopScan(): void {
      manager.stopDeviceScan();
    },
    async connect(deviceId: string): Promise<WristBleConnection> {
      let device: Device = await manager.connectToDevice(deviceId, {
        requestMTU: 249,
      });
      device = await device.discoverAllServicesAndCharacteristics();

      let dataHandler: ((d: Uint8Array) => void) | null = null;
      let disconnectHandler: (() => void) | null = null;

      device.monitorCharacteristicForService(
        PIPE_SERVICE_UUID,
        PIPE_CHAR_UUID,
        (_err, ch) => {
          if (ch?.value) dataHandler?.(fromB64(ch.value));
        },
      );
      device.onDisconnected(() => disconnectHandler?.());

      return {
        async write(data: Uint8Array): Promise<void> {
          await device.writeCharacteristicWithoutResponseForService(
            PIPE_SERVICE_UUID,
            PIPE_CHAR_UUID,
            toB64(data),
          );
        },
        onData(h): void {
          dataHandler = h;
        },
        onDisconnect(h): void {
          disconnectHandler = h;
        },
        async disconnect(): Promise<void> {
          await device.cancelConnection();
        },
      };
    },
    availability(): BleAvailability {
      if (cachedState === State.PoweredOn) return 'ready';
      if (cachedState === State.PoweredOff) return 'poweredOff';
      if (cachedState === State.Unauthorized) return 'unauthorized';
      return 'unknown';
    },
  };
}

export function createNativeWristService(
  config: Omit<WristServiceConfig, 'transport'> = {},
): HackMotionWristService {
  return new HackMotionWristService({
    ...config,
    transport: makeTransport(new BleManager()),
  });
}
```

### 3. Wire it into the app

In `apps/fairway/src/services/app-services.ts`, alongside the monitor:

```ts
import { createNativeWristService } from './rn-ble-wrist-transport';

const wrist = createNativeWristService();
// …
const store = createFairwayStore({
  monitor,
  wrist, // ← new; the store's swing↔shot join activates automatically
  data,
  flightModel,
  getDefaultEnvironment,
  onError,
});
```

Then add a pairing surface (mirror `ConnectScreen`) driven by
`wrist.on('device')` / `wrist.startScan()` / `wrist.connect(id)`, and show
`ShotRecord.wrist` in the practice/review UI.

### 4. Rebuild the dev client

```bash
yarn nx run fairway:prebuild   # or: npx expo prebuild
# then rebuild + install the dev client (EAS or local)
```

Proof of a correct connection: the service emits a `device` event whose
`serial` is `BCDKQ67GTQKC` (read straight off the unit).

## Calibration

`WristShot` angles are `null` until an anatomical calibration exists — the
device ships none. Capture a labelled run (15 s each: neutral → flexion →
deviation → rotation, one axis at a time), feed the four segments of `q_rel`
(`relativeQuat(qA, qB)`) to `calibrateAxes(...)`, and pass the resulting
`WristCalibration` to the detector via `WristServiceConfig.detector.calibration`.
Until then, keyframes still carry raw rotation vectors and swing timing, which is
all the shot↔swing join needs.

## Gotchas (from the reverse-engineering)

- One BLE central at a time — the HackMotion vendor app must be closed.
- 5-minute idle auto-sleep; the connect UX needs reconnect handling.
- Firmware updates can silently change the payload; treat a decode failure as a
  possible firmware bump.
