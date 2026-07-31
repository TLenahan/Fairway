import { AnalysisRecord } from './analysis';
import { Clip, ClipSync } from './clip';
import { Club } from './club';
import { DrillRep } from './drill';
import { ShotIntent } from './enums';
import { FlightResult } from './flight';
import { TrainingBlock, TrainingBlockStatus } from './program';
import { Session } from './session';
import { MeasuredShot, ShotRecord } from './shot';
import { WristShot, WristSwingRecord } from './wrist';

/* ───────────────────────── persistence — WP2 public API ───────────────────────── */
export interface DataStore {
  // clubs
  createClub(
    input: Omit<Club, 'id' | 'createdAt' | 'sensorMode'>,
  ): Promise<Club>;
  updateClub(id: string, patch: Partial<Club>): Promise<Club>;
  listClubs(opts?: { includeArchived?: boolean }): Promise<Club[]>;
  archiveClub(id: string): Promise<void>;
  // sessions — defaultIntent/focusClubId optional so callers predating them
  // keep compiling; both default to their unfocused/quarantine value
  createSession(
    input: Omit<
      Session,
      'id' | 'createdAt' | 'endedAt' | 'defaultIntent' | 'focusClubId'
    > & {
      defaultIntent?: ShotIntent;
      focusClubId?: string | null;
    },
  ): Promise<Session>;
  endSession(id: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
  // shots — opts optional so pre-Insights callers keep compiling
  insertShot(
    sessionId: string,
    clubId: string,
    m: MeasuredShot,
    flight: FlightResult | null,
    opts?: { intent?: ShotIntent; warmup?: boolean },
  ): Promise<ShotRecord>;
  attachFlight(shotId: string, flight: FlightResult): Promise<void>;
  /** Late-attach wrist mechanics once a swing is correlated to this shot. */
  attachWrist(shotId: string, wrist: WristShot): Promise<void>;
  setShotDiscarded(shotId: string, discarded: boolean): Promise<void>;
  /** Per-shot intent override (or warmup re-tag into a real bucket). */
  setShotIntent(shotId: string, intent: ShotIntent): Promise<void>;
  setShotWarmup(shotId: string, warmup: boolean): Promise<void>;
  listShots(sessionId: string): Promise<ShotRecord[]>;
  listShotsByClub(
    clubId: string,
    opts?: { sinceSessionId?: string },
  ): Promise<ShotRecord[]>;
  // wrist swings (every validated swing during a session, practice included,
  // so the coach export can count unpaired swings — the live join buffer
  // silently ages them out)
  insertWristSwing(
    input: Omit<WristSwingRecord, 'id' | 'createdAt'>,
  ): Promise<WristSwingRecord>;
  /** tImpactMs ascending. */
  listWristSwings(sessionId: string): Promise<WristSwingRecord[]>;
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
  // training blocks (§6.11 / §6.12 rule 4 — ONE primitive for both
  // program-planned work and finding-driven prescriptions; the drill itself
  // lives in the curated library and is referenced by id + version, never
  // copied here)
  insertTrainingBlock(
    input: Omit<TrainingBlock, 'id' | 'createdAt'>,
  ): Promise<TrainingBlock>;
  /** Close (or re-open) a block: `resolvedAt`/`note` are null while active. */
  updateTrainingBlockStatus(
    id: string,
    status: TrainingBlockStatus,
    resolvedAt: number | null,
    note: string | null,
  ): Promise<void>;
  /** createdAt ascending; unfiltered returns every block. */
  listTrainingBlocks(opts?: {
    status?: TrainingBlockStatus;
  }): Promise<TrainingBlock[]>;
  // swing clips (Phase 2) — `shotId` is assigned by the capture request the
  // clip was uploaded against, never inferred from timing (see clip.ts)
  insertClip(input: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip>;
  /** Locate impact once the clip has been analysed for it. */
  setClipImpactOffset(
    clipId: string,
    sync: ClipSync,
    impactOffsetMs: number,
  ): Promise<void>;
  getClip(id: string): Promise<Clip | null>;
  /** capturedAt ascending. */
  listClips(sessionId: string): Promise<Clip[]>;
  listClipsByShot(shotId: string): Promise<Clip[]>;
}
