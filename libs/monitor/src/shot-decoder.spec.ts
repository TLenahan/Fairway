import fixture from './fixtures/sample-shot.json';
import { decodeShot } from './shot-decoder';

describe('decodeShot — canonical capture fixture', () => {
  const decoded = decodeShot(fixture.raw_shotdataEX1);
  const expected = fixture.expected_decode_SI;

  it('decodes ball kinematics to exact SI values', () => {
    expect(decoded.shotGuid).toBe(expected.shotGuid);
    expect(decoded.handedness).toBe('right');
    expect(decoded.ball.speedMs).toBeCloseTo(26.092, 6);
    expect(decoded.ball.launchAngleDeg).toBeCloseTo(25.63, 6);
    expect(decoded.ball.launchDirectionDeg).toBeCloseTo(-2.011, 6);
    expect(decoded.ball.backspinRpm).toBeCloseTo(6918.153, 6);
    expect(decoded.ball.sidespinRpm).toBeCloseTo(1396.358, 6);
    expect(decoded.ball.rollspinRpm).toBeCloseTo(1028.395, 6);
    expect(decoded.ball.spinAssurance).toBe(97);
  });

  it('decodes measured club metrics', () => {
    expect(decoded.club.speedMs).toBeCloseTo(25.357, 6);
    expect(decoded.club.pathDeg).toBeCloseTo(-1.867, 6);
    expect(decoded.club.attackAngleDeg).toBeCloseTo(-6.2, 6);
    expect(decoded.smashFactor).toBeCloseTo(1.028986, 5);
  });

  it('applies the assurance-null rule — 0.0 here would be WRONG', () => {
    expect(decoded.club.faceAngleDeg).toBeNull();
    expect(decoded.club.loftDeg).toBeNull();
    expect(decoded.club.lieDeg).toBeNull();
    expect(decoded.club.faceImpactHMm).toBeNull();
    expect(decoded.club.faceImpactVMm).toBeNull();
  });

  it('keeps the raw assurances for auditing', () => {
    expect(decoded.assurance).toEqual({
      spin: 97,
      clubSpeed: 95,
      clubPath: 95,
      faceAngle: 0,
      attackAngle: 95,
      loftAngle: 0,
      lieAngle: 0,
      faceImpactLateral: 0,
      faceImpactVertical: 0,
    });
    expect(decoded.impactTimestamp).toBe(
      fixture.raw_shotdataEX1.impactTimestamp,
    );
    expect(decoded.shotImgPath).toBeNull();
  });

  it('nulls smash when club speed is unmeasured', () => {
    const noClub = decodeShot({
      ...fixture.raw_shotdataEX1,
      assurance_clubspeed: 0,
    });
    expect(noClub.club.speedMs).toBeNull();
    expect(noClub.smashFactor).toBeNull();
  });

  it('rejects a payload that is not a shotdataEX1', () => {
    expect(() => decodeShot({ nope: true })).toThrow();
  });
});
