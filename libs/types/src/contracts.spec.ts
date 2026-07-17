import fixture from './fixtures/sample-shot.json';

import {
  AnalysisVerdictSchema,
  categoryToSensorMode,
  ClubSchema,
  FlightResultSchema,
  MeasuredShotSchema,
  ShotDataEX1Schema,
  ShotRecordSchema,
  WristShot,
  WristShotSchema,
} from './index';

const wristShotFixture: WristShot = {
  tImpactMs: 1783975921445,
  durationMs: 980,
  peakAngularSpeedDegS: 645.2,
  calibrated: false,
  addressHeldMs: 1850,
  backswingMs: 705,
  topPauseMs: 0,
  downswingMs: 245,
  address: {
    tMs: 1783975920500,
    tDevS: 120.5,
    angularSpeedDegS: 12,
    angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
    rotVecDeg: [16.1, -47.8, -4.5],
    rotVecFromAddressDeg: [0, 0, 0],
  },
  top: {
    tMs: 1783975921205,
    tDevS: 121.205,
    angularSpeedDegS: 40,
    angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
    rotVecDeg: [14.1, 13.1, -3.0],
    rotVecFromAddressDeg: [-2.0, 60.9, 1.5],
  },
  impact: {
    tMs: 1783975921445,
    tDevS: 121.45,
    angularSpeedDegS: 645.2,
    angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
    rotVecDeg: [10.6, 40.2, -3.9],
    rotVecFromAddressDeg: [-5.5, 8.1, 0.6],
  },
  shock: { tMs: 1783975921445, offsetFromImpactMs: 0, peakAbsLsb: 5123 },
};

describe('@golf/types contracts', () => {
  it('parses the real captured shotdataEX1 fixture', () => {
    const parsed = ShotDataEX1Schema.parse(fixture.raw_shotdataEX1);
    expect(parsed.ballspeedx1000).toBe(26092);
    expect(parsed.assurance_faceangle).toBe(0);
    expect(parsed.shotguid.Data1).toBe(1416080389);
  });

  it('accepts the expected decoded MeasuredShot shape (null face/loft/lie)', () => {
    const decoded = {
      shotGuid: fixture.expected_decode_SI.shotGuid,
      handedness: fixture.expected_decode_SI.handedness,
      impactTimestamp: fixture.raw_shotdataEX1.impactTimestamp,
      ball: fixture.expected_decode_SI.ball,
      club: fixture.expected_decode_SI.club,
      assurance: {
        spin: 97,
        clubSpeed: 95,
        clubPath: 95,
        faceAngle: 0,
        attackAngle: 95,
        loftAngle: 0,
        lieAngle: 0,
        faceImpactLateral: 0,
        faceImpactVertical: 0,
      },
      smashFactor: fixture.expected_decode_SI.smashFactor,
      shotImgPath: null,
    };
    const parsed = MeasuredShotSchema.parse(decoded);
    expect(parsed.club.faceAngleDeg).toBeNull();
    expect(parsed.club.loftDeg).toBeNull();
    expect(parsed.club.attackAngleDeg).toBe(-6.2);
  });

  it('maps every club category to its sensor mode', () => {
    expect(categoryToSensorMode.driver).toBe('tee');
    expect(categoryToSensorMode.wood).toBe('iron');
    expect(categoryToSensorMode.hybrid).toBe('iron');
    expect(categoryToSensorMode.iron).toBe('iron');
    expect(categoryToSensorMode.wedge).toBe('iron');
    expect(categoryToSensorMode.putter).toBe('putter');
  });

  it('rejects a FlightResult that claims to be measured', () => {
    const result = FlightResultSchema.safeParse({
      path: [{ t: 0, x: 0, y: 0, z: 0 }],
      carryM: 100,
      totalM: 105,
      apexM: 20,
      descentDeg: 40,
      flightTimeS: 5,
      offlineM: 1,
      landing: { x: 100, z: 1 },
      rolloutM: 5,
      computed: false,
    });
    expect(result.success).toBe(false);
  });

  it('parses a WristShot and attaches it to a ShotRecord', () => {
    const wrist = WristShotSchema.parse(wristShotFixture);
    expect(wrist.calibrated).toBe(false);
    expect(wrist.impact.angles.extensionDeg).toBeNull();

    const record = ShotRecordSchema.parse({
      id: 'r1',
      sessionId: 's1',
      clubId: 'c1',
      shotGuid: 'g-1',
      capturedAt: 1783975921450,
      discarded: false,
      measured: {
        shotGuid: 'g-1',
        handedness: 'right',
        impactTimestamp: 1783975921445500,
        ball: fixture.expected_decode_SI.ball,
        club: fixture.expected_decode_SI.club,
        assurance: {
          spin: 97,
          clubSpeed: 95,
          clubPath: 95,
          faceAngle: 0,
          attackAngle: 95,
          loftAngle: 0,
          lieAngle: 0,
          faceImpactLateral: 0,
          faceImpactVertical: 0,
        },
        smashFactor: fixture.expected_decode_SI.smashFactor,
        shotImgPath: null,
      },
      flight: null,
      wrist: wristShotFixture,
    });
    expect(record.wrist?.peakAngularSpeedDegS).toBeCloseTo(645.2);

    // wrist is optional — a shot with no wrist unit still parses
    const noWrist = ShotRecordSchema.parse({ ...record, wrist: undefined });
    expect(noWrist.wrist).toBeUndefined();
  });

  it('validates club and analysis verdict shapes', () => {
    const club = ClubSchema.parse({
      id: 'c1',
      name: '60° ½ swing',
      category: 'wedge',
      sensorMode: 'iron',
      swingTag: 'half',
      loftDeg: 60,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
      createdAt: 1,
    });
    expect(club.sensorMode).toBe(categoryToSensorMode[club.category]);

    const verdict = AnalysisVerdictSchema.safeParse({
      headline: 'Face control is the leak',
      issues: [
        {
          area: 'face control',
          severity: 'high',
          evidence: 'avg face +3.2° open, path -1°',
          why: 'drives the push-fade pattern',
        },
      ],
      strengths: [],
      drills: [],
      caveats: ['only 6 shots — directional, not conclusive'],
    });
    expect(verdict.success).toBe(true);
  });
});
