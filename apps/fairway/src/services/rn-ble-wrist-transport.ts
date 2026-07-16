import {
  BleAvailability,
  HackMotionWristService,
  PIPE_CHAR_UUID,
  PIPE_SERVICE_UUID,
  WristBleConnection,
  WristBleDevice,
  WristBleTransport,
  WristServiceConfig,
} from '@golf/wrist';
import { Buffer } from 'buffer';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State } from 'react-native-ble-plx';

/**
 * react-native-ble-plx implementation of the @golf/wrist BLE seam — the ONLY
 * file that touches the native BLE module (libs/wrist/MIGRATION.md §2), the
 * same edge pattern as monitor's rn-transport.
 */
const toB64 = (data: Uint8Array): string =>
  Buffer.from(data).toString('base64');
const fromB64 = (b64: string): Uint8Array =>
  new Uint8Array(Buffer.from(b64, 'base64'));

/**
 * BLUETOOTH_SCAN/CONNECT are runtime permissions on Android 12+ (and BLE
 * scans need location on older Android) — manifest entries alone grant
 * nothing, and ble-plx does not prompt for you.
 */
async function ensureAndroidScanPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_CONNECT',
    ]);
    return Object.values(results).every(
      (status) => status === PermissionsAndroid.RESULTS.GRANTED,
    );
  }
  const status = await PermissionsAndroid.request(
    'android.permission.ACCESS_FINE_LOCATION',
  );
  return status === PermissionsAndroid.RESULTS.GRANTED;
}

interface PendingScan {
  onDevice(device: WristBleDevice): void;
  onError?(err: Error): void;
}

function makeTransport(manager: BleManager): WristBleTransport {
  let cachedState: State = State.Unknown;
  let permissionDenied = false;
  let availabilityHandler: ((a: BleAvailability) => void) | null = null;
  // A scan requested before the radio is ready (state Unknown at app boot,
  // or poweredOff) is held here and started on the PoweredOn transition —
  // startDeviceScan before PoweredOn just errors and never recovers.
  let pendingScan: PendingScan | null = null;
  let scanRunning = false;

  const availability = (): BleAvailability => {
    if (permissionDenied) return 'unauthorized';
    if (cachedState === State.PoweredOn) return 'ready';
    if (cachedState === State.PoweredOff) return 'poweredOff';
    if (cachedState === State.Unauthorized) return 'unauthorized';
    return 'unknown';
  };

  const beginScan = (): void => {
    if (!pendingScan || scanRunning) return;
    const scan = pendingScan;
    scanRunning = true;
    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        // Keep pendingScan: a radio flip restarts it on the next PoweredOn.
        scanRunning = false;
        scan.onError?.(error);
        return;
      }
      if (!device) return;
      scan.onDevice({ id: device.id, name: device.name ?? device.localName });
    });
  };

  const onState = (state: State): void => {
    cachedState = state;
    if (state === State.PoweredOn) beginScan();
    availabilityHandler?.(availability());
  };
  void manager.state().then(onState);
  manager.onStateChange(onState, true);

  return {
    startScan(onDevice, onError): void {
      pendingScan = { onDevice, onError };
      void ensureAndroidScanPermissions().then((granted) => {
        permissionDenied = !granted;
        if (!granted) {
          pendingScan = null;
          availabilityHandler?.('unauthorized');
          onError?.(new Error('Bluetooth permission denied'));
          return;
        }
        if (cachedState === State.PoweredOn) beginScan();
        // otherwise the state listener starts it once the radio is ready
      });
    },
    stopScan(): void {
      pendingScan = null;
      scanRunning = false;
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
    availability,
    onAvailabilityChange(handler): void {
      availabilityHandler = handler;
    },
  };
}

/** Production factory: the wrist service wired to the native BLE transport. */
export function createNativeWristService(
  config: Omit<WristServiceConfig, 'transport'> = {},
): HackMotionWristService {
  return new HackMotionWristService({
    ...config,
    transport: makeTransport(new BleManager()),
  });
}
