import { AnalysisRecord } from './analysis';
import { Club } from './club';
import { FlightResult } from './flight';
import { Session } from './session';
import { MeasuredShot, ShotRecord } from './shot';

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
  setShotDiscarded(shotId: string, discarded: boolean): Promise<void>;
  listShots(sessionId: string): Promise<ShotRecord[]>;
  listShotsByClub(
    clubId: string,
    opts?: { sinceSessionId?: string },
  ): Promise<ShotRecord[]>;
  // analyses
  saveAnalysis(a: AnalysisRecord): Promise<void>;
  listAnalyses(sessionId: string): Promise<AnalysisRecord[]>;
}
