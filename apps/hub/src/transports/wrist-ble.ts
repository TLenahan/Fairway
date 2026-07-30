import noble, { Peripheral } from '@stoprocent/noble';

import {
  BleAvailability,
  PIPE_CHAR_UUID,
  PIPE_SERVICE_UUID,
  WristBleConnection,
  WristBleDevice,
  WristBleTransport,
} from '@golf/wrist';

/**
 * @stoprocent/noble implementation of the @golf/wrist BLE seam — the hub-side
 * counterpart of the app's rn-ble-wrist-transport. Only this file touches the
 * BLE stack. Uses @stoprocent/noble specifically: @abandonware/noble never
 * initializes CoreBluetooth on macOS 26 (state stays 'unknown' forever).
 * Packaging note: the host process needs NSBluetoothAlwaysUsageDescription in
 * its Info.plist or macOS kills it with SIGABRT on first CoreBluetooth access.
 */
const noDash = (uuid: string): string => uuid.replace(/-/g, '').toLowerCase();

const PIPE_SERVICE = noDash(PIPE_SERVICE_UUID);
const PIPE_CHAR = noDash(PIPE_CHAR_UUID);

interface PendingScan {
  onDevice(device: WristBleDevice): void;
  onError?(err: Error): void;
}

export function createNobleWristTransport(): WristBleTransport {
  let cachedState = noble.state;
  let availabilityHandler: ((a: BleAvailability) => void) | null = null;
  // Same held-scan pattern as the RN transport: a scan requested before the
  // radio is ready starts on the poweredOn transition.
  let pendingScan: PendingScan | null = null;
  let scanRunning = false;
  const discovered = new Map<string, Peripheral>();

  const availability = (): BleAvailability => {
    if (cachedState === 'poweredOn') return 'ready';
    if (cachedState === 'poweredOff') return 'poweredOff';
    if (cachedState === 'unauthorized') return 'unauthorized';
    return 'unknown';
  };

  const beginScan = (): void => {
    if (!pendingScan || scanRunning) return;
    const scan = pendingScan;
    scanRunning = true;
    noble.startScanningAsync([], true).catch((err: Error) => {
      scanRunning = false;
      scan.onError?.(err);
    });
  };

  noble.on('stateChange', (state) => {
    cachedState = state;
    if (state === 'poweredOn') beginScan();
    availabilityHandler?.(availability());
  });

  noble.on('discover', (peripheral) => {
    discovered.set(peripheral.id, peripheral);
    pendingScan?.onDevice({
      id: peripheral.id,
      name: peripheral.advertisement?.localName ?? null,
    });
  });

  return {
    startScan(onDevice, onError): void {
      pendingScan = { onDevice, onError };
      if (cachedState === 'poweredOn') beginScan();
      // otherwise the state listener starts it once the radio is ready
    },
    stopScan(): void {
      pendingScan = null;
      scanRunning = false;
      void noble.stopScanningAsync();
    },
    async connect(deviceId: string): Promise<WristBleConnection> {
      const peripheral = discovered.get(deviceId);
      if (!peripheral) {
        throw new Error(
          `BLE device ${deviceId} not seen in this scan session — scan first`,
        );
      }
      await peripheral.connectAsync();
      const { characteristics } =
        await peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [PIPE_SERVICE],
          [PIPE_CHAR],
        );
      const pipe = characteristics[0];
      if (!pipe) {
        await peripheral.disconnectAsync().catch(() => undefined);
        throw new Error('HackMotion pipe characteristic not found');
      }

      let dataHandler: ((d: Uint8Array) => void) | null = null;
      let disconnectHandler: (() => void) | null = null;

      pipe.on('data', (data: Buffer) => {
        dataHandler?.(new Uint8Array(data));
      });
      peripheral.once('disconnect', () => disconnectHandler?.());
      await pipe.subscribeAsync();

      return {
        async write(data: Uint8Array): Promise<void> {
          // write-without-response, matching the RN transport
          await pipe.writeAsync(Buffer.from(data), true);
        },
        onData(h): void {
          dataHandler = h;
        },
        onDisconnect(h): void {
          disconnectHandler = h;
        },
        async disconnect(): Promise<void> {
          await peripheral.disconnectAsync();
        },
      };
    },
    availability,
    onAvailabilityChange(handler): void {
      availabilityHandler = handler;
    },
  };
}
