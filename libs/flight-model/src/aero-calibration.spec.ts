import * as fs from 'fs';
import * as path from 'path';

import { Environment } from '@golf/types';

import { DEFAULT_AERO, dragCoefficient, liftCoefficient } from './coefficients';
import { simulate } from './simulate';

/**
 * External-truth calibration harness (2026-07-17 refit; full method, tables
 * and provenance in handoff/FLIGHT_HANDOFF.md, data in fixtures/).
 *
 * Three independent sources, in trust order:
 * 1. fixtures/trackman-driver.csv — 7,938 cleaned TrackMan shots; a stride
 *    sample is replayed here and scored on carry/apex/descent/flight time.
 * 2. fixtures/trackman-tour-averages.json — measured outdoor PGA/LPGA
 *    per-club anchors (sanity band, not exact targets).
 * 3. fixtures/flightscope-oracle.json — independent vendor oracle; validates
 *    RELATIVE altitude carry scaling (its absolute carries read ~8% short of
 *    TrackMan everywhere — a known vendor-model split).
 *
 * Bounds are the observed post-fit stats plus ~35–50% headroom, so a
 * regression toward the pre-refit coefficients (carry −3.6 yd, apex +5.2 ft,
 * descent +1.3° biases) fails loudly while normal jitter passes.
 */

const MPH = 2.2369362920544;
const YD = 1.0936132983377078;
const FT = 3.280839895;
const DEG = Math.PI / 180;

const seaLevel: Environment = { altitudeM: 0, temperatureC: null, presetName: null };

const stats = (vals: number[]): { mean: number; rms: number } => ({
  mean: vals.reduce((a, b) => a + b, 0) / vals.length,
  rms: Math.sqrt(vals.reduce((a, b) => a + b * b, 0) / vals.length),
});

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('aero calibration vs TrackMan dataset (stride sample of 7,938 shots)', () => {
  const lines = fixture('trackman-driver.csv').trim().split('\n');
  const errs = { carryYd: [] as number[], apexFt: [] as number[], descDeg: [] as number[], timeS: [] as number[], sideYd: [] as number[], curveYd: [] as number[] };
  for (let i = 1; i < lines.length; i += 16) {
    const c = lines[i].split(',');
    const hlaDeg = Number(c[2]);
    const spinRpm = Number(c[3]);
    const axisRad = Number(c[4]) * DEG;
    const result = simulate(
      {
        ballSpeedMs: Number(c[0]) / MPH,
        launchAngleDeg: Number(c[1]),
        launchDirectionDeg: hlaDeg,
        backspinRpm: spinRpm * Math.cos(axisRad),
        sidespinRpm: spinRpm * Math.sin(axisRad),
        rollspinRpm: 0,
      },
      seaLevel,
    );
    errs.carryYd.push(
      Math.hypot(result.landing.x, result.landing.z) * YD -
        Math.hypot(Number(c[5]), Number(c[6])),
    );
    errs.apexFt.push(result.apexM * FT - Number(c[7]));
    errs.descDeg.push(result.descentDeg - Number(c[9]));
    errs.timeS.push(result.flightTimeS - Number(c[10]));
    // lateral truth: carrySideYd is the target-frame z, carryYd the target-
    // frame x; curve = both re-projected perpendicular to the start line
    errs.sideYd.push(result.offlineM * YD - Number(c[6]));
    const cos = Math.cos(hlaDeg * DEG);
    const sin = Math.sin(hlaDeg * DEG);
    errs.curveYd.push(
      result.curveM * YD - (Number(c[6]) * cos - Number(c[5]) * sin),
    );
  }

  it('carry matches within bias/RMS bounds', () => {
    const s = stats(errs.carryYd);
    expect(Math.abs(s.mean)).toBeLessThan(2.5);
    expect(s.rms).toBeLessThan(8);
  });

  it('apex matches within bias/RMS bounds', () => {
    const s = stats(errs.apexFt);
    expect(Math.abs(s.mean)).toBeLessThan(1.5);
    expect(s.rms).toBeLessThan(4.5);
  });

  it('descent angle matches within bias/RMS bounds', () => {
    const s = stats(errs.descDeg);
    expect(Math.abs(s.mean)).toBeLessThan(1.2);
    expect(s.rms).toBeLessThan(2.8);
  });

  it('flight time matches within bias/RMS bounds', () => {
    const s = stats(errs.timeS);
    expect(Math.abs(s.mean)).toBeLessThan(0.06);
    expect(s.rms).toBeLessThan(0.24);
  });

  // Full-dataset lateral residuals (2026-07-19): side bias −0.15 / RMS 1.94 yd,
  // curve bias −0.11 / RMS 1.82 yd, model/actual curve slope 0.97. Bounds are
  // those stats plus headroom for the stride sample's jitter.
  it('side (L/R of target) matches within bias/RMS bounds', () => {
    const s = stats(errs.sideYd);
    expect(Math.abs(s.mean)).toBeLessThan(0.75);
    expect(s.rms).toBeLessThan(3);
  });

  it('curve (L/R of start line) matches within bias/RMS bounds', () => {
    const s = stats(errs.curveYd);
    expect(Math.abs(s.mean)).toBeLessThan(0.75);
    expect(s.rms).toBeLessThan(3);
  });
});

describe('aero calibration vs TrackMan tour averages (measured outdoor anchors)', () => {
  interface TourClub {
    club: string;
    ballSpeedMph: number;
    launchDeg: number;
    spinRpm: number;
    maxHeightYd: number;
    landAngleDeg: number;
    carryYd: number;
  }
  const tour: { pga: TourClub[]; lpga: TourClub[] } = JSON.parse(
    fixture('trackman-tour-averages.json'),
  );
  // Tour events run warmer than ISA; 25 °C is representative (±1% carry over 15–30 °C).
  const tourEnv: Environment = { altitudeM: 0, temperatureC: 25, presetName: null };

  it.each([
    ['pga', tour.pga],
    ['lpga', tour.lpga],
  ] as const)('%s carries/arcs sit inside the sanity band', (_name, clubs) => {
    const carryRel: number[] = [];
    const apexRel: number[] = [];
    const landErr: number[] = [];
    for (const c of clubs) {
      const result = simulate(
        {
          ballSpeedMs: c.ballSpeedMph / MPH,
          launchAngleDeg: c.launchDeg,
          launchDirectionDeg: 0,
          backspinRpm: c.spinRpm,
          sidespinRpm: 0,
          rollspinRpm: 0,
        },
        tourEnv,
      );
      carryRel.push((result.carryM * YD - c.carryYd) / c.carryYd);
      apexRel.push((result.apexM * YD - c.maxHeightYd) / c.maxHeightYd);
      landErr.push(result.descentDeg - c.landAngleDeg);
    }
    const carry = stats(carryRel);
    expect(Math.abs(carry.mean)).toBeLessThan(0.03);
    expect(carry.rms).toBeLessThan(0.07);
    expect(stats(apexRel).rms).toBeLessThan(0.13);
    // Model lands ~4° shallower than tour-measured averages (both vendor
    // oracles agree with the model; see FLIGHT_HANDOFF.md residuals).
    const land = stats(landErr);
    expect(land.mean).toBeGreaterThan(-7);
    expect(land.mean).toBeLessThan(0);
    expect(land.rms).toBeLessThan(7);
  });
});

describe('altitude scaling vs FlightScope oracle (relative carry gains)', () => {
  interface OracleShot {
    tag: string;
    weather: string;
    input: { speedMph: number; elevDeg: number; spinRpm: number };
    out: { carryYd: number };
  }
  const oracle: { shots: OracleShot[] } = JSON.parse(fixture('flightscope-oracle.json'));
  const altitudeM: Record<string, number> = { sea: 0, f2500: 762, f5000: 1524, f7500: 2286 };

  const carryAt = (shot: OracleShot): number => {
    const result = simulate(
      {
        ballSpeedMs: shot.input.speedMph / MPH,
        launchAngleDeg: shot.input.elevDeg,
        launchDirectionDeg: 0,
        backspinRpm: shot.input.spinRpm,
        sidespinRpm: 0,
        rollspinRpm: 0,
      },
      { altitudeM: altitudeM[shot.weather], temperatureC: null, presetName: null },
    );
    return result.carryM * YD;
  };
  const byTag = new Map(oracle.shots.map((s) => [s.tag, s]));
  const gainDelta = (club: string, alt: string): number => {
    const sea = byTag.get(club === 'drv' ? 'drvTour' : club);
    const high = byTag.get(`alt${alt}-${club}`);
    if (!sea || !high) throw new Error(`missing oracle shots for ${club}@${alt}`);
    const oracleGain = high.out.carryYd / sea.out.carryYd - 1;
    const modelGain = carryAt(high) / carryAt(sea) - 1;
    return (modelGain - oracleGain) * 100;
  };

  it.each([
    ['drv', '2500'], ['drv', '5000'], ['drv', '7500'],
    ['7i', '2500'], ['7i', '5000'], ['7i', '7500'],
  ] as const)('%s carry gain at %s ft matches the oracle within 0.75 pp', (club, alt) => {
    expect(Math.abs(gainDelta(club, alt))).toBeLessThan(0.75);
  });

  it.each([['SW', '2500'], ['SW', '5000'], ['SW', '7500']] as const)(
    'wedge carry gain at %s ft stays within the documented 2.5 pp band',
    (club, alt) => {
      expect(Math.abs(gainDelta(club, alt))).toBeLessThan(2.5);
    },
  );
});

describe('fitted Cd/Cl stay inside the measured literature envelope', () => {
  // Envelopes assembled from Bearman & Harvey 1976, Smits & Smith 1994,
  // Li 2017 / Crabill 2018 (LES), Lyu-Kensrud-Smith 2018 (free flight);
  // sources and per-point derivation in FLIGHT_HANDOFF.md.
  const CD_ENVELOPE: [number, number, number][] = [
    [0.0, 0.19, 0.27],
    [0.1, 0.2, 0.32],
    [0.2, 0.25, 0.34],
    [0.3, 0.28, 0.36],
    [0.5, 0.3, 0.42],
  ];
  const CL_ENVELOPE: [number, number, number][] = [
    [0.1, 0.1, 0.22],
    [0.2, 0.17, 0.28],
    [0.3, 0.24, 0.35],
    [0.5, 0.28, 0.42],
  ];

  it.each(CD_ENVELOPE)('Cd(S=%s) within [%s, %s]', (s, lo, hi) => {
    const cd = dragCoefficient(s, DEFAULT_AERO);
    expect(cd).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(cd).toBeLessThanOrEqual(hi + 1e-9);
  });

  it.each(CL_ENVELOPE)('Cl(S=%s) within [%s, %s]', (s, lo, hi) => {
    const cl = liftCoefficient(s, DEFAULT_AERO);
    expect(cl).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(cl).toBeLessThanOrEqual(hi + 1e-9);
  });
});
