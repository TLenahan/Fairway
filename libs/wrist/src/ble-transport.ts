/**
 * Narrow BLE seam so the WristService stays pure and Node-testable — the same
 * pattern @golf/monitor uses for TCP/UDP. The react-native-ble-plx
 * implementation lives at the app edge (see MIGRATION.md) and is the ONLY code
 * that touches the native module; nothing in this lib imports it.
 */
export interface WristBleDevice {
  id: string; // platform BLE handle (CoreBluetooth UUID / MAC)
  name: string | null;
}

export interface WristBleConnection {
  /** Write to the pipe characteristic (write-without-response). */
  write(data: Uint8Array): Promise<void>;
  /** Deliver each pipe notification (already base64-decoded to bytes). */
  onData(handler: (data: Uint8Array) => void): void;
  onDisconnect(handler: () => void): void;
  disconnect(): Promise<void>;
}

export type BleAvailability = 'ready' | 'poweredOff' | 'unauthorized' | 'unknown';

export interface WristBleTransport {
  /** Scan for HackMotion advertisers; call onDevice for each match. */
  startScan(onDevice: (device: WristBleDevice) => void): void;
  stopScan(): void;
  /** Connect, discover the pipe service/characteristic, and subscribe. */
  connect(deviceId: string): Promise<WristBleConnection>;
  /** Radio / permission availability, for the connection state machine. */
  availability(): BleAvailability;
}
