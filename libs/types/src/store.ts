import { z } from 'zod';

import { Club } from './club';
import { DiscoveredDevice } from './device';
import { DrillPlan, DrillRepFeedback, DrillRung } from './drill';
import { ConnectionState, ShotIntent } from './enums';
import { Environment, Session } from './session';
import { MeasuredShot, ShotRecord } from './shot';
import { WristConnectionState, WristDevice, WristHold } from './wrist';

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
  /** intent stamped onto every incoming shot (Insights §6.1); starts at the
      session's defaultIntent, changeable mid-session via setActiveIntent */
  activeIntent: ShotIntent;
  startSession(env: Environment, defaultIntent?: ShotIntent): Promise<void>;
  endSession(): Promise<void>;
  // re-tags; reconfigures sensor only if mode changes
  selectClub(clubId: string): Promise<void>;
  // quick-add mid-session
  createClub(
    input: Omit<Club, 'id' | 'createdAt' | 'sensorMode'>,
  ): Promise<Club>;
  setActiveIntent(intent: ShotIntent): void;
  /** per-shot override / warmup re-tag — persists, then patches sessionShots */
  setShotIntent(shotId: string, intent: ShotIntent): Promise<void>;
  setShotWarmup(shotId: string, warmup: boolean): Promise<void>;
}

/** Wrist sensor connection, mirrored into the store like ConnectionSlice.
    When no wrist service is wired, state stays 'disconnected', the scan
    actions no-op, and connectWrist rejects. */
export interface WristSlice {
  wristConnection: z.infer<typeof WristConnectionState>;
  wristDevice: WristDevice | null;
  wristBatteryPercent: number | null;
  /** live address-hold progress — the drill's "hold still… GO" countdown;
      null when nothing is holding or the sensor is disconnected */
  wristHold: WristHold | null;
  /** set when the wrist drops UNEXPECTEDLY (BLE/battery), never on a user
      disconnect — drives the dismissable "HackMotion disconnected" toast so a
      silent mid-session death can't quietly ruin a capture. Cleared on
      dismiss or reconnect. */
  wristAlert: string | null;
  startWristScan(): void;
  stopWristScan(): void;
  connectWrist(deviceId: string): Promise<void>;
  disconnectWrist(): void;
  dismissWristAlert(): void;
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
