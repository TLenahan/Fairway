import { FlightResult, MeasuredShot, ShotRecord } from '@golf/types';

/**
 * Test-fixture builders (spec support only — not part of the public API).
 * Defaults describe a plausible mid-iron shot; override only what a test
 * hand-computes against.
 */

export interface ShotOverrides {
  id?: string;
  sessionId?: string;
  clubId?: string;
  capturedAt?: number;
  discarded?: boolean;
  ball?: Partial<MeasuredShot['ball']>;
  club?: Partial<MeasuredShot['club']>;
  smashFactor?: number | null;
  /** Defaults to null (no flight attached — e.g. a putter shot). */
  flight?: FlightResult | null;
}

let counter = 0;

export const buildFlight = (
  overrides: Partial<FlightResult> = {},
): FlightResult => ({
  path: [],
  carryM: 150,
  totalM: 158,
  apexM: 24,
  descentDeg: 44,
  flightTimeS: 5.6,
  offlineM: 0,
  curveM: 0,
  landing: { x: 150, z: 0 },
  rolloutM: 8,
  computed: true,
  ...overrides,
});

export const buildShot = (overrides: ShotOverrides = {}): ShotRecord => {
  counter += 1;

  const ball: MeasuredShot['ball'] = {
    speedMs: 55,
    launchAngleDeg: 18,
    launchDirectionDeg: 0,
    backspinRpm: 6000,
    sidespinRpm: 0,
    rollspinRpm: 100,
    spinAssurance: 95,
    ...overrides.ball,
  };
  const club: MeasuredShot['club'] = {
    speedMs: 38,
    pathDeg: 0,
    faceAngleDeg: 0,
    attackAngleDeg: -4,
    loftDeg: null,
    lieDeg: null,
    faceImpactHMm: 0,
    faceImpactVMm: 0,
    ...overrides.club,
  };

  const measured: MeasuredShot = {
    shotGuid: `guid-${counter}`,
    handedness: 'right',
    impactTimestamp: 1000 + counter,
    ball,
    club,
    assurance: {
      spin: ball.spinAssurance,
      clubSpeed: club.speedMs === null ? 0 : 95,
      clubPath: club.pathDeg === null ? 0 : 95,
      faceAngle: club.faceAngleDeg === null ? 0 : 95,
      attackAngle: club.attackAngleDeg === null ? 0 : 95,
      loftAngle: club.loftDeg === null ? 0 : 95,
      lieAngle: club.lieDeg === null ? 0 : 95,
      faceImpactLateral: club.faceImpactHMm === null ? 0 : 95,
      faceImpactVertical: club.faceImpactVMm === null ? 0 : 95,
    },
    smashFactor:
      overrides.smashFactor !== undefined
        ? overrides.smashFactor
        : club.speedMs === null
          ? null
          : ball.speedMs / club.speedMs,
    shotImgPath: null,
  };

  return {
    id: overrides.id ?? `shot-${counter}`,
    sessionId: overrides.sessionId ?? 'session-1',
    clubId: overrides.clubId ?? 'club-7i',
    shotGuid: measured.shotGuid,
    capturedAt: overrides.capturedAt ?? 1700000000000 + counter,
    discarded: overrides.discarded ?? false,
    measured,
    flight: overrides.flight ?? null,
  };
};
