import { Environment, LaunchConditions } from '@golf/types';

import { airDensityKgM3 } from './air';
import { simulate } from './simulate';
import { initialSpinRadS, spinAtTime, SPIN_DECAY_TAU_S } from './spin';

const seaLevel: Environment = {
  altitudeM: 0,
  temperatureC: null,
  presetName: null,
};
const home: Environment = {
  altitudeM: 1850,
  temperatureC: null,
  presetName: 'Home ~6,000 ft',
};

const launch = (over: Partial<LaunchConditions>): LaunchConditions => ({
  ballSpeedMs: 54,
  launchAngleDeg: 17,
  launchDirectionDeg: 0,
  backspinRpm: 7000,
  sidespinRpm: 0,
  rollspinRpm: 0,
  ...over,
});

// FLIGHT_MODEL.md §7 archetypes
const tourDriver = launch({
  ballSpeedMs: 74,
  launchAngleDeg: 11,
  backspinRpm: 2600,
});
const midSevenIron = launch({});
const wedge = launch({
  ballSpeedMs: 40,
  launchAngleDeg: 28,
  backspinRpm: 9000,
});

describe('air density (ISA)', () => {
  it('matches the ISA sanity points', () => {
    expect(airDensityKgM3(0)).toBeCloseTo(1.225, 3);
    const at1850 = airDensityKgM3(1850);
    expect(at1850).toBeGreaterThan(0.98);
    expect(at1850).toBeLessThan(1.05);
  });

  it('a warmer column is thinner', () => {
    expect(airDensityKgM3(0, 30)).toBeLessThan(airDensityKgM3(0, 5));
  });
});

describe('spin', () => {
  it('decays exponentially with τ = 20 s', () => {
    const spin0 = initialSpinRadS(midSevenIron);
    const later = spinAtTime(spin0, SPIN_DECAY_TAU_S);
    expect(later.z / spin0.z).toBeCloseTo(Math.exp(-1), 6);
  });
});

describe('simulate — §7 validation targets', () => {
  it('tour driver carries 229–251 m at sea level', () => {
    const result = simulate(tourDriver, seaLevel);
    expect(result.carryM).toBeGreaterThanOrEqual(229);
    expect(result.carryM).toBeLessThanOrEqual(251);
  });

  it('mid 7-iron carries 146–160 m at sea level', () => {
    const result = simulate(midSevenIron, seaLevel);
    expect(result.carryM).toBeGreaterThanOrEqual(146);
    expect(result.carryM).toBeLessThanOrEqual(160);
  });

  it('wedge carries 87–105 m at sea level', () => {
    const result = simulate(wedge, seaLevel);
    expect(result.carryM).toBeGreaterThanOrEqual(87);
    expect(result.carryM).toBeLessThanOrEqual(105);
  });

  it('identical driver launch carries 6–9% farther at 1850 m', () => {
    const atSea = simulate(tourDriver, seaLevel);
    const atHome = simulate(tourDriver, home);
    const gain = atHome.carryM / atSea.carryM - 1;
    expect(gain).toBeGreaterThanOrEqual(0.06);
    expect(gain).toBeLessThanOrEqual(0.09);
  });
});

describe('simulate — shot shape and curvature', () => {
  it('positive sidespin curves right, negative curves left', () => {
    const fade = simulate(launch({ sidespinRpm: 1500 }), seaLevel);
    const draw = simulate(launch({ sidespinRpm: -1500 }), seaLevel);
    expect(fade.offlineM).toBeGreaterThan(2);
    expect(draw.offlineM).toBeLessThan(-2);
  });

  it('curvature grows monotonically with sidespin', () => {
    const mild = simulate(launch({ sidespinRpm: 500 }), seaLevel);
    const medium = simulate(launch({ sidespinRpm: 1500 }), seaLevel);
    const heavy = simulate(launch({ sidespinRpm: 3000 }), seaLevel);
    expect(medium.offlineM).toBeGreaterThan(mild.offlineM);
    expect(heavy.offlineM).toBeGreaterThan(medium.offlineM);
  });

  it('zero sidespin and zero HLA stays on the target line', () => {
    const straight = simulate(launch({}), seaLevel);
    expect(Math.abs(straight.offlineM)).toBeLessThan(0.5);
  });

  it('zero sidespin with left HLA finishes left of the line (HLA only)', () => {
    const pushLeft = simulate(launch({ launchDirectionDeg: -3 }), seaLevel);
    expect(pushLeft.offlineM).toBeLessThan(-5);
    // no curvature: lateral finish ≈ straight-line projection of HLA
    const expected = Math.tan((-3 * Math.PI) / 180) * pushLeft.carryM;
    expect(Math.abs(pushLeft.offlineM - expected)).toBeLessThan(
      0.15 * Math.abs(expected),
    );
  });
});

describe('simulate — path integrity', () => {
  it('produces a monotonic, grounded, apex-consistent path', () => {
    const result = simulate(midSevenIron, seaLevel);
    for (let i = 1; i < result.path.length; i += 1) {
      expect(result.path[i].t).toBeGreaterThan(result.path[i - 1].t);
      expect(result.path[i].y).toBeGreaterThanOrEqual(0);
    }
    const last = result.path[result.path.length - 1];
    expect(last.y).toBe(0);
    expect(last.t).toBeCloseTo(result.flightTimeS, 6);
    const maxPathY = Math.max(...result.path.map((p) => p.y));
    expect(result.apexM).toBeGreaterThanOrEqual(maxPathY - 1e-9);
    expect(result.apexM).toBeGreaterThan(5);
  });

  it('total exceeds carry via rollout and descent is sane', () => {
    const result = simulate(tourDriver, seaLevel);
    expect(result.totalM).toBeGreaterThan(result.carryM);
    expect(result.rolloutM).toBeGreaterThan(3);
    expect(result.rolloutM).toBeLessThan(40);
    expect(result.descentDeg).toBeGreaterThan(25);
    expect(result.descentDeg).toBeLessThan(60);
    expect(result.computed).toBe(true);
  });

  it('is deterministic', () => {
    const a = simulate(wedge, home);
    const b = simulate(wedge, home);
    expect(a).toEqual(b);
  });
});
