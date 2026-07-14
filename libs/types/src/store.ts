import { z } from 'zod';

import { Club } from './club';
import { DiscoveredDevice } from './device';
import { ConnectionState } from './enums';
import { Environment, Session } from './session';
import { MeasuredShot, ShotRecord } from './shot';

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
