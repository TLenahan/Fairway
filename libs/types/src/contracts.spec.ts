import fixture from './fixtures/sample-shot.json';

import {
  AnalysisVerdictSchema,
  categoryToSensorMode,
  ClubSchema,
  FlightResultSchema,
  MeasuredShotSchema,
  ShotDataEX1Schema,
} from './index';

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

  it('validates club and analysis verdict shapes', () => {
    const club = ClubSchema.parse({
      id: 'c1',
      name: '60° ½ swing',
      category: 'wedge',
      sensorMode: 'iron',
      swingTag: 'half',
      loftDeg: 60,
      notes: null,
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
