import { z } from 'zod';

import { Club } from './club';
import { DiscoveredDevice } from './device';
import { DrillPlan, DrillRepFeedback, DrillRung } from './drill';
import { ConnectionState } from './enums';
import { Environment, Session } from './session';
import { MeasuredShot, ShotRecord } from './shot';
import { WristConnectionState, WristDevice } from './wrist';

/* ───────────────────────── store (zustand) — shapes only ───────────────────────── */
export interface ConnectionSlice {
  connection: z.infer<typeof ConnectionState>;
  device: DiscoveredDevice | null;
  startDiscovery(): void;
  connect(ip: string): Promise<void>;
  disconnect(): void;
}
export interface LiveSlice {
  ballReady: boolean;
  lastShot: MeasuredShot | null;
  sessionShots: ShotRecord[]; // shots in the active session, newest first
}
export interface ActiveSessionSlice {
  session: Session | null;
  activeClub: Club | null;
  startSession(env: Environment): Promise<void>;
  endSession(): Promise<void>;
  // re-tags; reconfigures sensor only if mode changes
  selectClub(clubId: string): Promise<void>;
  // quick-add mid-session
  createClub(
    input: Omit<Club, 'id' | 'createdAt' | 'sensorMode'>,
  ): Promise<Club>;
}

/** Wrist sensor connection, mirrored into the store like ConnectionSlice.
    When no wrist service is wired, state stays 'disconnected', the scan
    actions no-op, and connectWrist rejects. */
export interface WristSlice {
  wristConnection: z.infer<typeof WristConnectionState>;
  wristDevice: WristDevice | null;
  wristBatteryPercent: number | null;
  startWristScan(): void;
  stopWristScan(): void;
  connectWrist(deviceId: string): Promise<void>;
  disconnectWrist(): void;
}

export interface DrillState {
  plan: DrillPlan;
  /** the rung swings are currently judged against; null = observe only */
  active: { clubId: string; rung: DrillRung } | null;
  /** latest judged swing — the UI's sound/haptic trigger */
  lastRep: DrillRepFeedback | null;
}

/** Wedge distance-control drill mode. Orthogonal to the practice pipeline:
    shots keep flowing into the active session; drill mode additionally judges
    each wrist swing against the active rung's learned target. */
export interface DrillSlice {
  drill: DrillState | null; // null = drill mode off
  startDrill(wedgeClubIds: string[]): Promise<void>;
  endDrill(): void;
  /** picks the live target; also activates that wedge so shots re-tag */
  selectDrillRung(clubId: string, rung: DrillRung): Promise<void>;
}
