import { CarrySample, targetAngleForCarry, WedgeAnchor } from './angle-model';

// anchor: 80° top angle carries 100 m → guard scale 1.25 m/deg
const anchor: WedgeAnchor = { angleDeg: 80, carryM: 100 };

/** samples on the line carry = slope·angle + intercept */
const line = (
  angles: number[],
  slope: number,
  intercept: number,
): CarrySample[] =>
  angles.map((a) => ({ topAngleDeg: a, carryM: slope * a + intercept }));

describe('targetAngleForCarry — unlearned means null, never assumed', () => {
  it('no samples at all → null (the rung calibrates)', () => {
    expect(targetAngleForCarry([], anchor, 50)).toBeNull();
  });

  it('fewer than 4 samples → null even when they agree perfectly', () => {
    const samples = line([40, 60, 85], 2, -60); // clean line, only 3 points
    expect(targetAngleForCarry(samples, anchor, 60)).toBeNull();
  });

  it('under 12° of angle spread → null (slope unidentifiable)', () => {
    const samples = line([70, 72, 74, 76], 2, -60); // spread 6°
    expect(targetAngleForCarry(samples, anchor, 60)).toBeNull();
  });

  it('one distant sample cannot carry the spread alone (leverage guard)', () => {
    // three clustered fulls + a single mid strike: raw spread 22° passes,
    // but dropping the one mid collapses it to 4° — null until a second
    // mid sample corroborates the line
    const lone = line([78, 80, 82, 60], 1.2, 4);
    expect(targetAngleForCarry(lone, anchor, 60)).toBeNull();
    const corroborated = line([78, 80, 82, 60, 62], 1.2, 4);
    expect(targetAngleForCarry(corroborated, anchor, 60)).not.toBeNull();
  });
});

describe('targetAngleForCarry — learned least-squares fit', () => {
  it('recovers a known linear relationship', () => {
    // carry = 2·angle − 60 over a 45° spread → slope 2 (within [0.375, 3.75])
    const samples = line([40, 55, 70, 85], 2, -60);
    // 80 + (60 − 100)/2 = 60
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(60);
  });

  it('a noisy but well-spread fit still resolves', () => {
    const samples: CarrySample[] = [
      { topAngleDeg: 40, carryM: 21 },
      { topAngleDeg: 55, carryM: 49 },
      { topAngleDeg: 70, carryM: 81 },
      { topAngleDeg: 85, carryM: 109 },
    ];
    // LSQ slope ≈ 1.973: target ≈ 80 + (60 − 100)/1.973 ≈ 59.7
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(59.72, 1);
  });

  it('rejects a near-flat slope (below 0.3 × guard scale) → null', () => {
    const samples = line([40, 55, 70, 85], 0.1, 96); // 0.1 < 0.375
    expect(targetAngleForCarry(samples, anchor, 60)).toBeNull();
  });

  it('rejects a negative slope → null', () => {
    const samples = line([40, 55, 70, 85], -1, 160);
    expect(targetAngleForCarry(samples, anchor, 60)).toBeNull();
  });

  it('rejects an insanely steep slope (above 3 × guard scale) → null', () => {
    const samples = line([40, 55, 70, 85], 5, 0); // 5 > 3.75
    expect(targetAngleForCarry(samples, anchor, 60)).toBeNull();
  });

  it('accepts a slope exactly on the guard boundary', () => {
    const samples = line([40, 55, 70, 85], 3 * 1.25, 0); // exactly 3 × scale
    // 80 + (60 − 100)/3.75 ≈ 69.333
    expect(targetAngleForCarry(samples, anchor, 60)).toBeCloseTo(69.333, 3);
  });
});

describe('targetAngleForCarry — clamping a learned fit', () => {
  // shallow-but-legal slope 0.5 (≥ 0.375): extreme targets hit the clamps
  const shallow = line([40, 55, 70, 85], 0.5, 60);

  it('clamps low at 25% of the anchor angle', () => {
    // raw = 80 + (0 − 100)/0.5 = −120 → clamp to 20
    expect(targetAngleForCarry(shallow, anchor, 0)).toBeCloseTo(20);
  });

  it('clamps high at 105% of the anchor angle', () => {
    // raw = 80 + (120 − 100)/0.5 = 120 → clamp to 84
    expect(targetAngleForCarry(shallow, anchor, 120)).toBeCloseTo(84);
  });

  it('the full carry itself maps back to the anchor angle', () => {
    const samples = line([40, 55, 70, 85], 2, -60);
    expect(targetAngleForCarry(samples, anchor, 100)).toBeCloseTo(80);
  });
});
