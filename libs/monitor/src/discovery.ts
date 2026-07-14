import { Buffer } from 'buffer';
import { DiscoveredDevice } from '@golf/types';
import { z } from 'zod';

/**
 * EYE MINI UDP beacon (BUILD_SPEC A.1; port of reference/discover.js): the
 * Mini broadcasts this JSON to the subnet on :43265 ~once per second. No
 * handshake — it announces its own IP, serial, and firmware in plaintext.
 */
export const BEACON_PORT = 43265;

const BeaconSchema = z.object({
  device: z.object({
    modelName: z.string(),
    hwVersion: z.string(),
    swVersion: z.string(),
    serialNumber: z.string(),
    networkInfo: z.object({
      ipaddr: z.string(),
      mac: z.string(),
    }),
  }),
});

/** Parse one UDP datagram; null when it isn't a valid device beacon. */
export function parseBeacon(data: Uint8Array): DiscoveredDevice | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
  const parsed = BeaconSchema.safeParse(json);
  if (!parsed.success) return null;
  const { device } = parsed.data;
  return {
    model: device.modelName,
    serial: device.serialNumber,
    ip: device.networkInfo.ipaddr,
    mac: device.networkInfo.mac,
    swVersion: device.swVersion,
    hwVersion: device.hwVersion,
  };
}
