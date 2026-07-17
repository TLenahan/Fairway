import { simulate } from './simulate';

/**
 * Real-device calibration suite: 18 sea-level shots (5/7/9-iron, 2026-07-13)
 * captured on the EYE MINI with Uneekor VIEW's computed carry/total/apex as
 * the reference. Inputs are the measured values VIEW displayed. Tolerances
 * are deliberately loose enough to survive coefficient tweaks but tight
 * enough that a regression to the pre-calibration model fails loudly.
 *
 * Since the 2026-07-17 aero refit (aero-calibration.spec.ts) the model is
 * anchored to TrackMan truth, and a structured TrackMan↔VIEW vendor split
 * shows up here: VIEW flies high-spin 9-irons ~3–5 yd farther and low-spin
 * 5-irons ~3–7 yd shorter than TrackMan physics (overall bias −0.6 yd,
 * mean |err| 3.7 yd). Tolerances below allow that split; the tight bias
 * bound is the real regression tripwire.
 */
// [name, ballMph, launch, hla, back, side, carryYd, totalYd, apexFt]
const SHOTS: [
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
][] = [
  ['9i-1', 128.0, 26.6, 3.3, 7850, -537, 165.0, 174.1, 160.0],
  ['9i-2', 128.1, 24.9, 5.5, 8161, 218, 166.3, 174.9, 152.0],
  ['9i-3', 123.7, 24.8, 3.0, 8036, -332, 161.8, 170.4, 141.6],
  ['9i-4', 126.5, 25.6, 2.4, 7862, -45, 164.8, 173.8, 151.9],
  ['9i-5', 117.1, 23.6, -0.6, 7260, -1364, 156.7, 166.0, 120.4],
  ['9i-6', 116.5, 24.6, 1.7, 7952, -91, 153.3, 161.7, 125.6],
  ['9i-7', 107.8, 22.3, -0.1, 6727, 1003, 145.6, 155.4, 95.1],
  ['9i-8', 122.2, 21.4, -2.5, 8703, 1446, 160.8, 168.4, 121.6],
  ['7i-1', 130.3, 22.1, 8.6, 6390, 268, 180.7, 192.2, 141.4],
  ['7i-2', 132.5, 18.9, 2.6, 5781, 829, 189.4, 201.9, 126.4],
  ['7i-3', 136.1, 15.8, 2.4, 6372, -484, 193.3, 204.9, 116.8],
  ['7i-4', 130.5, 13.8, 6.3, 6311, 1441, 183.2, 194.4, 92.4],
  ['7i-5', 132.5, 17.2, 8.1, 6331, 1126, 186.8, 198.3, 116.8],
  ['5i-1', 143.6, 12.3, 0.9, 4566, -245, 218.4, 233.2, 103.0],
  ['5i-2', 130.3, 3.4, 2.4, 3198, 1948, 140.8, 153.7, 14.0],
  ['5i-3', 137.6, 14.6, 1.3, 3738, -689, 214.5, 230.9, 103.2],
  ['5i-4', 151.2, 12.9, -2.5, 3807, -1569, 230.3, 246.0, 105.3],
  ['5i-5', 139.2, 10.4, 2.9, 2669, -1069, 213.2, 231.1, 62.7],
];

const MPH = 2.2369362920544;
const YD = 1.0936132983377078;
const FT = 3.280839895;

const CARRY_TOLERANCE_YD = 9;
const TOTAL_TOLERANCE_YD = 9;
const APEX_TOLERANCE_FT = 12;
const MEAN_CARRY_TOLERANCE_YD = 4.5;

describe('flight model vs Uneekor VIEW (18 real shots, sea level)', () => {
  const results = SHOTS.map(
    ([name, ball, launch, hla, back, side, carryYd, totalYd, apexFt]) => ({
      name,
      view: { carryYd, totalYd, apexFt },
      ours: simulate(
        {
          ballSpeedMs: ball / MPH,
          launchAngleDeg: launch,
          launchDirectionDeg: hla,
          backspinRpm: back,
          sidespinRpm: side,
          rollspinRpm: 0,
        },
        { altitudeM: 0, temperatureC: null, presetName: null },
      ),
    }),
  );

  it.each(results)('$name matches VIEW within tolerance', ({ view, ours }) => {
    expect(Math.abs(ours.carryM * YD - view.carryYd)).toBeLessThan(
      CARRY_TOLERANCE_YD,
    );
    expect(Math.abs(ours.totalM * YD - view.totalYd)).toBeLessThan(
      TOTAL_TOLERANCE_YD,
    );
    expect(Math.abs(ours.apexM * FT - view.apexFt)).toBeLessThan(
      APEX_TOLERANCE_FT,
    );
  });

  it('has no systematic carry bias', () => {
    const errors = results.map((r) => r.ours.carryM * YD - r.view.carryYd);
    const meanAbs =
      errors.reduce((sum, e) => sum + Math.abs(e), 0) / errors.length;
    const bias = errors.reduce((sum, e) => sum + e, 0) / errors.length;
    expect(meanAbs).toBeLessThan(MEAN_CARRY_TOLERANCE_YD);
    expect(Math.abs(bias)).toBeLessThan(2.5);
  });
});
