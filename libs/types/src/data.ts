import { AnalysisRecord } from './analysis';
import { Club } from './club';
import { DrillRep } from './drill';
import { FlightResult } from './flight';
import { Session } from './session';
import { MeasuredShot, ShotRecord } from './shot';
import { WristShot } from './wrist';

/* ───────────────────────── persistence — WP2 public API ───────────────────────── */
export interface DataStore {
  // clubs
  createClub(
    input: Omit<Club, 'id' | 'createdAt' | 'sensorMode'>,
  ): Promise<Club>;
  updateClub(id: string, patch: Partial<Club>): Promise<Club>;
  listClubs(opts?: { includeArchived?: boolean }): Promise<Club[]>;
  archiveClub(id: string): Promise<void>;
  // sessions
  createSession(
    input: Omit<Session, 'id' | 'createdAt' | 'endedAt'>,
  ): Promise<Session>;
  endSession(id: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
  // shots
  insertShot(
    sessionId: string,
    clubId: string,
    m: MeasuredShot,
    flight: FlightResult | null,
  ): Promise<ShotRecord>;
  attachFlight(shotId: string, flight: FlightResult): Promise<void>;
  /** Late-attach wrist mechanics once a swing is correlated to this shot. */
  attachWrist(shotId: string, wrist: WristShot): Promise<void>;
  setShotDiscarded(shotId: string, discarded: boolean): Promise<void>;
  listShots(sessionId: string): Promise<ShotRecord[]>;
  listShotsByClub(
    clubId: string,
    opts?: { sinceSessionId?: string },
  ): Promise<ShotRecord[]>;
  // analyses
  saveAnalysis(a: AnalysisRecord): Promise<void>;
  listAnalyses(sessionId: string): Promise<AnalysisRecord[]>;
  // drill reps (wedge distance-control drill; targets are always recomputed
  // from reps by @golf/drill, never persisted)
  insertDrillRep(input: Omit<DrillRep, 'id' | 'createdAt'>): Promise<DrillRep>;
  /** Late-attach the joined shot's computed carry once the Mini reports. */
  setDrillRepCarry(
    repId: string,
    shotId: string,
    carryM: number,
  ): Promise<void>;
  /** All reps for these wedges across all time, createdAt ascending. */
  listDrillReps(clubIds: string[]): Promise<DrillRep[]>;
}
