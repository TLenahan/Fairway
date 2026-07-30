import {
  Club,
  DiscoveredDevice,
  Environment,
  Session,
  WristDevice,
} from '@golf/types';

/**
 * Wire contract between the hub process and its localhost web UI (and later
 * the phone capture clients). Snapshots are full-state pushes — small enough
 * at session scale that diffing isn't worth the complexity.
 */

/** One shot row trimmed for the UI — no trajectory samples over the wire. */
export interface ShotRowDto {
  id: string;
  clubId: string;
  clubName: string;
  capturedAt: number;
  discarded: boolean;
  ballSpeedMs: number | null;
  clubSpeedMs: number | null;
  smashFactor: number | null;
  carryM: number | null;
  totalM: number | null;
  offlineM: number | null;
  curveM: number | null;
  apexM: number | null;
  hasWrist: boolean;
}

export interface HubSnapshot {
  connection: string;
  device: DiscoveredDevice | null;
  ballReady: boolean;
  session: Session | null;
  activeClubId: string | null;
  clubs: Club[];
  shots: ShotRowDto[];
  wristConnection: string;
  wristDevice: WristDevice | null;
  wristBatteryPercent: number | null;
  wristAlert: string | null;
  wristCandidates: WristDevice[];
  environment: Environment;
}

export type HubCommand =
  | { cmd: 'startDiscovery' }
  | { cmd: 'connectMini'; ip: string }
  | { cmd: 'disconnectMini' }
  | { cmd: 'startSession' }
  | { cmd: 'endSession' }
  | { cmd: 'selectClub'; clubId: string }
  | { cmd: 'startWristScan' }
  | { cmd: 'stopWristScan' }
  | { cmd: 'connectWrist'; deviceId: string }
  | { cmd: 'disconnectWrist' }
  | { cmd: 'dismissWristAlert' };

export interface SnapshotMessage {
  type: 'snapshot';
  snapshot: HubSnapshot;
}
