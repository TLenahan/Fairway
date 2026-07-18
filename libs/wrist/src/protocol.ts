/**
 * HackMotion Sensor 4 BLE protocol constants (reverse-engineered; see the
 * hackmotion repo handoff). Requests and their replies share the leading opcode
 * byte. Writes go to the pipe characteristic and NOWHERE else — writing the
 * Silicon Labs OTA control characteristic reboots the unit into its bootloader.
 */

/** Microchip/ISSC Transparent-UART service ("ISSC"), reused by HackMotion. */
export const PIPE_SERVICE_UUID = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
/** The one bidirectional pipe: write commands, telemetry notifies back. */
export const PIPE_CHAR_UUID = '413c3893-b7e8-4231-9673-7af7aed06ddc';

/** ☠️ Silicon Labs OTA DFU — NEVER write here (reboots to the bootloader). */
export const OTA_SERVICE_UUID = '1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0';
export const OTA_CONTROL_UUID = 'f7bf3564-fb6d-4e53-88a4-5e37e0326063';

export const ADVERTISED_NAME_PREFIX = 'HackMotion';

/** Telemetry framing: a 0x90 marker then N × 46-byte records. */
export const TELEMETRY_MARKER = 0x90;
export const RECORD_LEN = 46;
export const Q14_SCALE = 1 / 16384;

/** Approx tsA device-clock rate (Hz), measured from capture. Angular speed is
    timed against the device clock, so host BLE batching can't inflate it. */
export const DEVICE_CLOCK_HZ = 64000;

// identity / status opcodes (reply's first byte === the request byte)
// Also seen from the vendor app but not sent by us: 0x80/0x83/0x84 reads and
// 0xa2 00/01 around stream setup; 0xfb arrives unsolicited. See
// reference/hackmotion-vibrate-capture.md for the capture they came from.
export const OP_BATTERY = 0x81;
export const OP_MAC = 0x85;
export const OP_SERIAL = 0x86;
export const OP_TOKEN = 0x87;

/**
 * On-device vibration motor, decoded from a btsnoop capture of the vendor
 * app's feedback mode (2026-07-18): eight ON/OFF pairs, ON held 0.4–4.2 s and
 * ended by an explicit OFF, every write acked with `cb 01`. The ON tail reads
 * as max-duration 10000 ms + intensity 100, but neither byte has been varied
 * against hardware — replay verbatim (the CMD_START_STREAM rule) and time the
 * pulse with an explicit OFF.
 */
export const OP_VIBRATE = 0xcb;
export const CMD_VIBRATE_ON = Uint8Array.of(OP_VIBRATE, 0x01, 0x27, 0x10, 0x64);
export const CMD_VIBRATE_OFF = Uint8Array.of(OP_VIBRATE, 0x00);

/** Start the telemetry stream. Replay verbatim; the 0x7e byte is an opaque
    channel mask we never decoded. */
export const CMD_START_STREAM = Uint8Array.of(0xa0, 0x01, 0x7e);
export const CMD_READ_BATTERY = Uint8Array.of(OP_BATTERY);
export const CMD_READ_SERIAL = Uint8Array.of(OP_SERIAL);
