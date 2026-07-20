# CONTRACTS — `libs/types` (`@golf/types`)

These are the **frozen seams**. Implement them in `libs/types` as Zod schemas with `z.infer` types (matches the `regent/mono` domain-schema convention and gives runtime validation for untrusted device JSON and LLM output). **Every other lib imports from `@golf/types` and nothing else of each other.** Freeze this in Phase 0; changing a contract mid-build requires a coordinated update across dependents.

Organize `libs/types/src/` by domain: `enums.ts`, `club.ts`, `session.ts`, `shot.ts`, `flight.ts`, `analytics.ts`, `analysis.ts`, `device.ts`, `store.ts`, and `index.ts` re-exporting all. Interface bodies below are illustrative — implement as Zod (`z.object`, `.nullable()`, `z.enum`) and export both the schema (`XSchema`) and the type (`type X = z.infer<typeof XSchema>`).

```ts
import { z } from 'zod';

/* ───────────────────────── enums ───────────────────────── */
export const SensorMode   = z.enum(['tee', 'iron', 'putter']);
export const ClubCategory = z.enum(['driver', 'wood', 'hybrid', 'iron', 'wedge', 'putter']);
export const SwingTag     = z.enum(['full', 'three_quarter', 'half', 'chip']);
export const Handedness   = z.enum(['right', 'left']);
export const SpeedUnit    = z.enum(['mph', 'ms']);
export const DistanceUnit = z.enum(['yards', 'meters']);
export const AnalysisScope= z.enum(['session', 'club', 'trend', 'compare', 'diagnose', 'plan']);
export const ConnectionState = z.enum([
  'disconnected', 'discovering', 'connecting', 'connected', 'error', 'localNetworkDenied',
]);

/* map category → sensor mode (single source of truth; used by monitor + store) */
export const categoryToSensorMode: Record<z.infer<typeof ClubCategory>, z.infer<typeof SensorMode>> = {
  driver: 'tee', wood: 'iron', hybrid: 'iron', iron: 'iron', wedge: 'iron', putter: 'putter',
};

/* ───────────────────────── club ───────────────────────── */
export const ClubSchema = z.object({
  id: z.string(),
  name: z.string(),                 // free text, e.g. "60° ½ swing"
  category: ClubCategory,
  sensorMode: SensorMode,           // derived via categoryToSensorMode
  swingTag: SwingTag.nullable(),
  loftDeg: z.number().nullable(),
  notes: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.number(),            // epoch ms
});
export type Club = z.infer<typeof ClubSchema>;

/* ───────────────────────── environment ───────────────────────── */
export const EnvironmentSchema = z.object({
  altitudeM: z.number(),
  temperatureC: z.number().nullable(),
  presetName: z.string().nullable(),   // e.g. "Home ~6,000 ft", "Perry Park ~7,500 ft"
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/* ───────────────────────── raw wire shot (monitor input) ─────────────────────────
   The exact shape of param.shotdataEX1 from the device. Values are integers ×1000, SI base.
   monitor validates device JSON against this before decoding. See BUILD_SPEC A.7. */
export const ShotDataEX1Schema = z.object({
  shotguid: z.object({ Data1: z.number(), Data2: z.number(), Data3: z.number(), Data4: z.array(z.number()) }),
  category: z.number(),
  rightlefthanded: z.number(),
  xposx1000: z.number(), yposx1000: z.number(), zposx1000: z.number(),
  ballspeedx1000: z.number(), inclineX1000: z.number(), azimuthX1000: z.number(),
  spincalc_method: z.number(), assurance_spin: z.number(),
  backspinX1000: z.number(), sidespinX1000: z.number(), rollspinX1000: z.number(),
  clubcalc_method: z.number(),
  assurance_clubspeed: z.number(), assurance_clubpath: z.number(), assurance_faceangle: z.number(),
  assurance_attackangle: z.number(), assurance_loftangle: z.number(), assurance_lieangle: z.number(),
  assurance_faceimpactLateral: z.number(), assurance_faceimpactVertical: z.number(),
  clubspeedX1000: z.number(), clubpathX1000: z.number(), faceangleX1000: z.number(), attackangleX1000: z.number(),
  loftangleX1000: z.number(), lieangleX1000: z.number(),
  faceimpactLateralX1000: z.number(), faceimpactVerticalX1000: z.number(),
  impactTimestamp: z.number(),
}).passthrough(); // tolerate unknown/new fields
export type ShotDataEX1 = z.infer<typeof ShotDataEX1Schema>;

/* ───────────────────────── decoded measured shot (monitor output) ─────────────────────────
   SI units. Club metrics are null when their assurance was 0 (NOT 0). This is the object every
   consumer uses; it never contains the ×1000 scaling. */
export const MeasuredShotSchema = z.object({
  shotGuid: z.string(),                 // `${Data1}-${Data2}-${Data3}` — dedup key
  handedness: Handedness,
  impactTimestamp: z.number(),          // raw device value, opaque epoch
  ball: z.object({
    speedMs: z.number(),
    launchAngleDeg: z.number(),         // VLA
    launchDirectionDeg: z.number(),     // HLA, negative = left
    backspinRpm: z.number(),
    sidespinRpm: z.number(),            // positive = right
    rollspinRpm: z.number(),
    spinAssurance: z.number(),          // 0–100
  }),
  club: z.object({
    speedMs: z.number().nullable(),
    pathDeg: z.number().nullable(),     // negative = out-to-in
    faceAngleDeg: z.number().nullable(),
    attackAngleDeg: z.number().nullable(),
    loftDeg: z.number().nullable(),
    lieDeg: z.number().nullable(),
    faceImpactHMm: z.number().nullable(),
    faceImpactVMm: z.number().nullable(),
  }),
  assurance: z.object({                 // keep the raw confidences for auditing why a metric is null
    spin: z.number(), clubSpeed: z.number(), clubPath: z.number(), faceAngle: z.number(),
    attackAngle: z.number(), loftAngle: z.number(), lieAngle: z.number(),
    faceImpactLateral: z.number(), faceImpactVertical: z.number(),
  }),
  smashFactor: z.number().nullable(),   // ball/club speed, only when club speed measured
  shotImgPath: z.string().nullable(),   // device-provided path to the impact image, if present
});
export type MeasuredShot = z.infer<typeof MeasuredShotSchema>;

/* ───────────────────────── flight model (flight-model output) ─────────────────────────
   ALL COMPUTED. x=downrange, y=height, z=lateral(+right); meters, seconds. See FLIGHT_MODEL.md. */
export const LaunchConditionsSchema = z.object({
  ballSpeedMs: z.number(),
  launchAngleDeg: z.number(),
  launchDirectionDeg: z.number(),
  backspinRpm: z.number(),
  sidespinRpm: z.number(),
  rollspinRpm: z.number(),
});
export type LaunchConditions = z.infer<typeof LaunchConditionsSchema>;

export const FlightPathPointSchema = z.object({ t: z.number(), x: z.number(), y: z.number(), z: z.number() });
export const FlightResultSchema = z.object({
  path: z.array(FlightPathPointSchema),
  carryM: z.number(), totalM: z.number(), apexM: z.number(),
  descentDeg: z.number(), flightTimeS: z.number(), offlineM: z.number(),
  curveM: z.number(), // lateral deviation from the START line (+ = right); offlineM is vs the target line
  landing: z.object({ x: z.number(), z: z.number() }),
  rolloutM: z.number(),
  computed: z.literal(true),
});
export type FlightResult = z.infer<typeof FlightResultSchema>;

/** flight-model public API */
export interface FlightModel {
  simulate(launch: LaunchConditions, env: Environment): FlightResult;
}

/* ───────────────────────── session + persisted shot ───────────────────────── */
export const SessionSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  environment: EnvironmentSchema,
  createdAt: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;

/** what `data` stores/returns per shot (object view; columns per BUILD_SPEC §7). */
export const ShotRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  clubId: z.string(),
  shotGuid: z.string(),
  capturedAt: z.number(),
  discarded: z.boolean(),
  measured: MeasuredShotSchema,
  flight: FlightResultSchema.nullable(),   // null until flight-model runs
});
export type ShotRecord = z.infer<typeof ShotRecordSchema>;

/* ───────────────────────── device / monitor ───────────────────────── */
export const DiscoveredDeviceSchema = z.object({
  model: z.string(), serial: z.string(), ip: z.string(), mac: z.string(),
  swVersion: z.string(), hwVersion: z.string(),
});
export type DiscoveredDevice = z.infer<typeof DiscoveredDeviceSchema>;

export const DeviceStateSchema = z.object({
  handedness: Handedness, sensorMode: SensorMode,
  allowTee: z.boolean(), allowIron: z.boolean(), allowPutter: z.boolean(),
  altitudeM: z.number(),
});
export type DeviceState = z.infer<typeof DeviceStateSchema>;

/** MonitorService — WP1 public API. EventEmitter-style. */
export interface MonitorServiceEvents {
  device: (d: DiscoveredDevice) => void;
  connection: (s: z.infer<typeof ConnectionState>) => void;
  state: (s: DeviceState) => void;
  ballDetected: (mode: z.infer<typeof SensorMode>, exists: boolean) => void;
  shot: (shot: MeasuredShot) => void;                 // already deduped + decoded
  error: (err: Error) => void;
}
export interface MonitorService {
  startDiscovery(): void;
  stopDiscovery(): void;
  connect(ip: string): Promise<void>;
  disconnect(): void;
  setClub(mode: z.infer<typeof SensorMode>, clubType?: number): Promise<void>;
  setHandedness(h: z.infer<typeof Handedness>): Promise<void>;
  getState(): z.infer<typeof ConnectionState>;
  on<K extends keyof MonitorServiceEvents>(e: K, h: MonitorServiceEvents[K]): void;
  off<K extends keyof MonitorServiceEvents>(e: K, h: MonitorServiceEvents[K]): void;
}

/* ───────────────────────── persistence — WP2 public API ───────────────────────── */
export interface DataStore {
  // clubs
  createClub(input: Omit<Club, 'id' | 'createdAt' | 'sensorMode'>): Promise<Club>;
  updateClub(id: string, patch: Partial<Club>): Promise<Club>;
  listClubs(opts?: { includeArchived?: boolean }): Promise<Club[]>;
  archiveClub(id: string): Promise<void>;
  // sessions
  createSession(input: Omit<Session, 'id' | 'createdAt' | 'endedAt'>): Promise<Session>;
  endSession(id: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
  // shots
  insertShot(sessionId: string, clubId: string, m: MeasuredShot, flight: FlightResult | null): Promise<ShotRecord>;
  attachFlight(shotId: string, flight: FlightResult): Promise<void>;
  setShotDiscarded(shotId: string, discarded: boolean): Promise<void>;
  listShots(sessionId: string): Promise<ShotRecord[]>;
  listShotsByClub(clubId: string, opts?: { sinceSessionId?: string }): Promise<ShotRecord[]>;
  // analyses
  saveAnalysis(a: AnalysisRecord): Promise<void>;
  listAnalyses(sessionId: string): Promise<AnalysisRecord[]>;
}

/* ───────────────────────── analytics — WP4 output ───────────────────────── */
export const MetricStatSchema = z.object({
  n: z.number(),        // MEASURED count (may be < shot count due to null rule)
  mean: z.number(), median: z.number(), sd: z.number(), min: z.number(), max: z.number(),
});
export const DispersionSchema = z.object({
  centerX: z.number(), centerZ: z.number(),        // pattern center (downrange, lateral) meters
  ellipseSemiMajorM: z.number(), ellipseSemiMinorM: z.number(), ellipseAngleDeg: z.number(),
  biasLateralM: z.number(), biasDepthM: z.number(),// systematic left/right & short/long
  lateralSpreadM: z.number(), depthSpreadM: z.number(),
});
export const ContactSchema = z.object({
  faceCentroidHMm: z.number().nullable(), faceCentroidVMm: z.number().nullable(),
  faceSpreadHMm: z.number().nullable(), faceSpreadVMm: z.number().nullable(),
  smashMean: z.number().nullable(), smashSd: z.number().nullable(),
});
export const BaselineGapSchema = z.object({
  source: z.object({ citation: z.string(), url: z.string().nullable() }),
  level: z.string(),                    // e.g. "scratch", "tour", "10-hcp"
  perMetricDelta: z.record(z.string(), z.number()), // golfer − baseline
});
export const ClubSummarySchema = z.object({
  clubId: z.string(), clubName: z.string(), shotCount: z.number(),
  metrics: z.record(z.string(), MetricStatSchema),   // keys: ballSpeedMs, launchAngleDeg, backspinRpm, clubSpeedMs, clubPathDeg, attackAngleDeg, carryM, ...
  dispersion: DispersionSchema,
  contact: ContactSchema,
  pathFaceGapDeg: z.number().nullable(),             // face − path, the curvature driver
  carryM: MetricStatSchema.nullable(),               // convenience for gapping
  baselineGap: BaselineGapSchema.nullable(),
});
export type ClubSummary = z.infer<typeof ClubSummarySchema>;

export const GappingEntrySchema = z.object({ clubId: z.string(), clubName: z.string(), carryMeanM: z.number(), gapToNextM: z.number().nullable(), overlap: z.boolean() });
export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  environment: EnvironmentSchema,
  shotCount: z.number(),
  clubs: z.array(ClubSummarySchema),
  gapping: z.array(GappingEntrySchema),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export interface AnalyticsEngine {
  summarizeSession(shots: ShotRecord[], env: Environment): SessionSummary;
  summarizeClub(shots: ShotRecord[]): ClubSummary;
}

/* ───────────────────────── analysis — WP5 ─────────────────────────
   Claude returns THIS shape via structured output; validate the parse with AnalysisVerdictSchema. */
export const AnalysisVerdictSchema = z.object({
  headline: z.string(),
  issues: z.array(z.object({
    area: z.string(), severity: z.enum(['low', 'medium', 'high']),
    evidence: z.string(), why: z.string(),
  })),
  strengths: z.array(z.object({ area: z.string(), evidence: z.string() })),
  drills: z.array(z.object({ name: z.string(), goal: z.string(), howMeasured: z.string() })),
  caveats: z.array(z.string()),
});
export type AnalysisVerdict = z.infer<typeof AnalysisVerdictSchema>;

export const AnalysisRecordSchema = z.object({
  id: z.string(), sessionId: z.string(), scope: AnalysisScope,
  model: z.string(), createdAt: z.number(),
  verdict: AnalysisVerdictSchema, narrative: z.string(),
  inputSummary: z.unknown(),          // the computed summary sent to Claude (for audit)
});
export type AnalysisRecord = z.infer<typeof AnalysisRecordSchema>;

/** curated, cited reference numbers — NEVER generated by the model */
export const BaselineSchema = z.object({
  category: ClubCategory, level: z.string(),
  source: z.object({ citation: z.string(), url: z.string().nullable() }),
  metrics: z.record(z.string(), z.number()),
});
export type Baseline = z.infer<typeof BaselineSchema>;
export interface BaselineSet { get(category: z.infer<typeof ClubCategory>, level: string): Baseline | null; list(): Baseline[]; }

export interface AnalysisService {
  analyze(
    scope: z.infer<typeof AnalysisScope>,
    input: { current: SessionSummary; priorSummaries?: SessionSummary[]; priorAnalyses?: AnalysisRecord[]; environment: Environment },
    opts: { model: string; onDelta?: (textChunk: string) => void; signal?: AbortSignal },
  ): Promise<{ verdict: AnalysisVerdict; narrative: string }>;
  chat(
    context: { summary: SessionSummary; priorAnalysis?: AnalysisRecord },
    history: { role: 'user' | 'assistant'; content: string }[],
    message: string,
    opts: { model: string; onDelta?: (t: string) => void; signal?: AbortSignal },
  ): Promise<string>;
}

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
  sessionShots: ShotRecord[];   // shots in the active session, newest first
}
export interface ActiveSessionSlice {
  session: Session | null;
  activeClub: Club | null;
  startSession(env: Environment): Promise<void>;
  endSession(): Promise<void>;
  selectClub(clubId: string): Promise<void>;                      // re-tags; reconfigures sensor only if mode changes
  createClub(input: Omit<Club, 'id' | 'createdAt' | 'sensorMode'>): Promise<Club>; // quick-add mid-session
}
```

## Contract rules for all agents
- **Import only from `@golf/types`.** Never import another lib's internals. Nx boundaries enforce this.
- **Validate at the edges.** `monitor` validates device JSON with `ShotDataEX1Schema` before decoding; `analysis` validates the model's JSON with `AnalysisVerdictSchema`. Reject/repair, don't trust.
- **Nulls are load-bearing.** Every `.nullable()` above encodes a real "not measured / not yet computed" state. Never coerce to 0.
- **If you need a shape that isn't here, propose it as an addition to `libs/types` — don't invent a local type** that other libs can't see. Contract changes are a coordinated Phase-0-style step.
