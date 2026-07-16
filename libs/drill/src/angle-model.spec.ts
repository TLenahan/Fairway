import { CarrySample, targetAngleForCarry, WedgeAnchor } from './angle-model';

// anchor: 80° top angle carries 100 m → prior slope 1.25 m/deg
const anchor: WedgeAnchor = { angleDeg: 80, carryM: 100 };

/** samples on the line carry = slope·angle + intercept */
const line = (
  angles: number[],
  slope: number,
  intercept: number,
): CarrySample[] =>
  angles.map((a) => ({ topAngleDeg: a, carryM: slope * a + intercept }));

describe('targetAngleForCarry — proportional prior', () => {
  it('bootstraps with no samples at all', () => {
    // 80 + (50 − 100)/1.25 = 40
    expect(targetAngleForCarry([], anchor, 50)).toBeCloseTo(40);
  });

  it('ignores fewer than 4 samples even when they disagree', () => {
    const samples = line([40, 60, 85], 2, -60); // real slope 2, only 3 points
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(48); // prior
  });

  it('ignores samples with under 12° of angle spread', () => {
    const samples = line([70, 72, 74, 76], 2, -60); // spread 6°
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(48); // prior
  });
});

describe('targetAngleForCarry — least-squares takeover', () => {
  it('recovers a known linear relationship', () => {
    // carry = 2·angle − 60 over a 45° spread → slope 2 (within [0.375, 3.75])
    const samples = line([40, 55, 70, 85], 2, -60);
    // 80 + (60 − 100)/2 = 60 (prior would have said 48)
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(60);
  });

  it('a noisy but well-spread fit still beats the prior', () => {
    const samples: CarrySample[] = [
      { topAngleDeg: 40, carryM: 21 },
      { topAngleDeg: 55, carryM: 49 },
      { topAngleDeg: 70, carryM: 81 },
      { topAngleDeg: 85, carryM: 109 },
    ];
    // LSQ slope ≈ 1.973: target ≈ 80 + (60 − 100)/1.973 ≈ 59.7
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(59.72, 1);
  });

  it('rejects a near-flat slope (below 0.3 × prior)', () => {
    const samples = line([40, 55, 70, 85], 0.1, 96); // 0.1 < 0.375
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(48); // prior
  });

  it('rejects a negative slope', () => {
    const samples = line([40, 55, 70, 85], -1, 160);
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(48); // prior
  });

  it('rejects an insanely steep slope (above 3 × prior)', () => {
    const samples = line([40, 55, 70, 85], 5, 0); // 5 > 3.75
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(48); // prior
  });

  it('accepts a slope exactly on the guard boundary', () => {
    const samples = line([40, 55, 70, 85], 3 * 1.25, 0); // exactly 3 × prior
    // 80 + (60 − 100)/3.75 ≈ 69.333
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(69.333, 3);
  });
});

describe('targetAngleForCarry — clamping', () => {
  it('clamps low at 25% of the anchor angle', () => {
    // raw = 80 + (0 − 100)/1.25 = 0 → clamp to 20
    expect(targetAngleForCarry([], anchor, 0)).toBeCloseTo(20);
  });

  it('clamps high at 105% of the anchor angle', () => {
    // raw = 80 + (120 − 100)/1.25 = 96 → clamp to 84
    expect(targetAngleForCarry([], anchor, 120)).toBeCloseTo(84);
  });

  it('the full carry itself maps back to the anchor angle', () => {
    expect(targetAngleForCarry([], anchor, 100)).toBeCloseTo(80);
  });
});
