// Type-only on purpose: the renderer imports this module, and neither the
// engine nor the drill library may ever be pulled into the browser bundle
// (@golf/program validates its content at module load — a cost, and a crash
// surface, that belongs in the hub process alone). `import type` is erased,
// so this file stays a pure contract.
import type { InsightsWire } from '@golf/insights';
import type { TrainingBlockWire } from '@golf/program';
import {
  Club,
  DiscoveredDevice,
  Environment,
  Session,
  ShotIntent,
  WristDevice,
} from '@golf/types';

/**
 * Wire contract between the hub process and its localhost web UI (and later
 * the phone capture clients). Snapshots are full-state pushes — small enough
 * at session scale that diffing isn't worth the complexity.
 */

/**
 * What `GET /api/insights` returns: the engine wire plus the training blocks
 * the §6.10 prescription loop has issued against it.
 *
 * One payload rather than two endpoints because findings and blocks are two
 * halves of the same answer — a finding the loop has already prescribed
 * against reads very differently from one it hasn't, and a UI that fetched
 * them separately could render a finding as unaddressed while its block was
 * still in flight.
 */
export interface HubInsightsPayload extends InsightsWire {
  blocks: TrainingBlockWire[];
}

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
  intent: ShotIntent;
  warmup: boolean;
}

export interface HubSnapshot {
  connection: string;
  device: DiscoveredDevice | null;
  ballReady: boolean;
  session: Session | null;
  activeClubId: string | null;
  activeIntent: ShotIntent;
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
  | { cmd: 'startSession'; intent?: ShotIntent; focusClubId?: string }
  | { cmd: 'endSession' }
  | { cmd: 'selectClub'; clubId: string }
  | { cmd: 'setActiveIntent'; intent: ShotIntent }
  | { cmd: 'startWristScan' }
  | { cmd: 'stopWristScan' }
  | { cmd: 'connectWrist'; deviceId: string }
  | { cmd: 'disconnectWrist' }
  | { cmd: 'dismissWristAlert' };

export interface SnapshotMessage {
  type: 'snapshot';
  snapshot: HubSnapshot;
}
