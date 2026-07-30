import { ShotRecord, WristCoachAngles, WristKeyframe, WristShot } from '@golf/types';

import { toInsightShot } from './projection';

const angles = (extensionDeg: number | null): WristKeyframe['angles'] => ({
  extensionDeg,
  deviationDeg: null,
  rotationDeg: null,
});

const keyframe = (extensionDeg: number | null): WristKeyframe => ({
  tMs: 0,
  tDevS: 0,
  angularSpeedDegS: 0,
  angles: angles(extensionDeg),
  rotVecDeg: [0, 0, 0],
  rotVecFromAddressDeg: [0, 0, 0],
});

const coachAngles = (extensionDeg: number): WristCoachAngles => ({
  extensionDeg,
  deviationDeg: 0,
  rotationDeg: 0,
});

const wristShot = (overrides: Partial<WristShot> = {}): WristShot => ({
  tImpactMs: 1000,
  durationMs: 900,
  peakAngularSpeedDegS: 700,
  calibrated: true,
  addressHeldMs: 400,
  backswingMs: 500,
  topPauseMs: 20,
  downswingMs: 250,
  address: keyframe(4),
  top: keyframe(20),
  impact: keyframe(-2),
  shock: { tMs: 1000, offsetFromImpactMs: 2, peakAbsLsb: 900 },
  ...overrides,
});

const shot = (wrist?: WristShot): ShotRecord => ({
  id: 'shot-1',
  sessionId: 'ses-1',
  clubId: 'club-1',
  shotGuid: 'guid-1',
  capturedAt: 1000,
  discarded: false,
  intent: 'stock',
  warmup: false,
  measured: {
    shotGuid: 'guid-1',
    handedness: 'right',
    impactTimestamp: 0,
    ball: {
      speedMs: 55,
      launchAngleDeg: 18,
      launchDirectionDeg: -1,
      backspinRpm: 6000,
      sidespinRpm: 200,
      rollspinRpm: 6003,
      spinAssurance: 90,
    },
    club: {
      speedMs: 40,
      pathDeg: 1,
      faceAngleDeg: null,
      attackAngleDeg: -4,
      loftDeg: null,
      lieDeg: null,
      faceImpactHMm: null,
      faceImpactVMm: null,
    },
    assurance: {
      spin: 90,
      clubSpeed: 80,
      clubPath: 80,
      faceAngle: 0,
      attackAngle: 80,
      loftAngle: 0,
      lieAngle: 0,
      faceImpactLateral: 0,
      faceImpactVertical: 0,
    },
    smashFactor: 1.375,
    shotImgPath: null,
  },
  flight: null,
  ...(wrist ? { wrist } : {}),
});

describe('toInsightShot', () => {
  it('leaves wrist metrics null when no swing joined', () => {
    const out = toInsightShot(shot(), 'iron');
    expect(out.wristExtTop).toBeNull();
    expect(out.wristExtImpact).toBeNull();
    expect(out.wristExtPeakDown).toBeNull();
    expect(out.flipFlag).toBeNull();
  });

  it('falls back to raw keyframe angles when the swing has no coach block', () => {
    const out = toInsightShot(shot(wristShot()), 'iron');
    expect(out.wristExtTop).toBe(20);
    expect(out.wristExtImpact).toBe(-2);
    // peak-down only exists in the coach block — no flip verdict without it
    expect(out.wristExtPeakDown).toBeNull();
    expect(out.flipFlag).toBeNull();
  });

  it('prefers the calibrated coach keyframes and flags a cast', () => {
    const out = toInsightShot(
      shot(
        wristShot({
          coach: {
            status: 'ok',
            keyframes: {
              setup: coachAngles(5),
              top: coachAngles(24),
              impact: coachAngles(-1),
              peakDownExtensionDeg: 30,
            },
          },
        }),
      ),
      'iron',
    );
    expect(out.wristExtTop).toBe(24); // coach block wins over the raw 20
    expect(out.wristExtImpact).toBe(-1);
    expect(out.wristExtPeakDown).toBe(30);
    expect(out.flipFlag).toBe(true); // 30 − 24 ≥ 3° margin
  });

  it('clears the flip flag when peak-down stays at the top extension', () => {
    const out = toInsightShot(
      shot(
        wristShot({
          coach: {
            status: 'ok',
            keyframes: {
              setup: coachAngles(5),
              top: coachAngles(24),
              impact: coachAngles(-1),
              peakDownExtensionDeg: 25,
            },
          },
        }),
      ),
      'iron',
    );
    expect(out.flipFlag).toBe(false); // 25 − 24 < 3° margin
  });

  it('keeps a dropped coach block from masquerading as data', () => {
    const out = toInsightShot(
      shot(wristShot({ coach: { status: 'dropped', reason: 'uncalibrated' } })),
      'iron',
    );
    expect(out.wristExtTop).toBe(20); // raw fallback
    expect(out.wristExtPeakDown).toBeNull();
    expect(out.flipFlag).toBeNull();
  });
});
