import { InsightsWire } from '@golf/insights';
import {
  Club,
  FlightResult,
  Session,
  ShotRecord,
  WristSwingRecord,
} from '@golf/types';

import { buildDailySessionExport } from './daily-export';
import { parseCoachRecap } from './recap';

const flight: FlightResult = {
  path: [],
  carryM: 150.34,
  totalM: 158.2,
  apexM: 24.1,
  descentDeg: 44,
  flightTimeS: 5.6,
  offlineM: -3.2,
  curveM: 1.4,
  landing: { x: 150, z: -3.2 },
  rolloutM: 8,
  computed: true,
};

let counter = 0;

interface ShotOverrides {
  capturedAt?: number;
  smashFactor?: number | null;
  clubSpeedMs?: number | null;
  flight?: FlightResult | null;
}

const buildShot = (overrides: ShotOverrides = {}): ShotRecord => {
  counter += 1;
  return {
    id: `shot-${counter}`,
    sessionId: 'ses-1',
    clubId: 'club-1',
    shotGuid: `guid-${counter}`,
    capturedAt: overrides.capturedAt ?? counter * 1000,
    discarded: false,
    intent: 'stock',
    warmup: false,
    measured: {
      shotGuid: `guid-${counter}`,
      handedness: 'right',
      impactTimestamp: 0,
      ball: {
        speedMs: 55.12,
        launchAngleDeg: 18.4,
        launchDirectionDeg: -1.2,
        backspinRpm: 6200,
        sidespinRpm: 300,
        rollspinRpm: 6207,
        spinAssurance: 90,
      },
      club: {
        speedMs: overrides.clubSpeedMs === undefined ? 39.9 : overrides.clubSpeedMs,
        pathDeg: 1.2,
        faceAngleDeg: null,
        attackAngleDeg: -4.1,
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
      smashFactor: overrides.smashFactor === undefined ? 1.38 : overrides.smashFactor,
      shotImgPath: null,
    },
    flight: overrides.flight === undefined ? flight : overrides.flight,
  };
};

const session: Session = {
  id: 'ses-1',
  name: null,
  notes: null,
  startedAt: 1_000_000,
  endedAt: 2_000_000,
  environment: { altitudeM: 1800, temperatureC: 22, presetName: null },
  defaultIntent: 'stock',
  createdAt: 1_000_000,
};

const club = (id: string, name: string): Club => ({
  id,
  name,
  category: 'iron',
  sensorMode: 'iron',
  swingTag: 'full',
  loftDeg: 34,
  notes: null,
  tracerColor: null,
  focusNote: null,
  archived: false,
  createdAt: 0,
});

const KEYFRAME = { extensionDeg: 10, deviationDeg: -3, rotationDeg: 5 };

const swing = (tImpactMs: number): WristSwingRecord => ({
  id: `sw-${tImpactMs}`,
  sessionId: 'ses-1',
  tImpactMs,
  coach: {
    status: 'ok',
    keyframes: {
      setup: KEYFRAME,
      top: { ...KEYFRAME, extensionDeg: 28 },
      impact: { ...KEYFRAME, extensionDeg: -2 },
      peakDownExtensionDeg: 30,
    },
  },
  createdAt: tImpactMs,
});

const insights: InsightsWire = {
  findings: [
    {
      club_id: 'club-1',
      club_name: '7 Iron',
      intent: 'stock',
      failure_mode: 'pull',
      metric: 'launchDirDeg',
      effect_size: 1.4,
      direction: 'lower',
      sessions_seen: 3,
      counts: { bad: 14, great: 9, bad_beyond_great_range: 11 },
    },
  ],
  buckets: [
    {
      club_id: 'club-1',
      club_name: '7 Iron',
      intent: 'stock',
      n_total: 40,
      n_great: 9,
      great_rate: 0.225,
      certification: 'certified',
      dispersion_index: 1.12,
      carry_sigma_m: 4.3,
      offline_sigma_m: 6.1,
      changepoint: 'bad-day',
      bias: [{ metric: 'launchDirDeg', mean_offset: -1.8 }],
      variance_drivers: ['smash'],
      carry_variance_dominant: 'smash',
    },
  ],
};

describe('buildDailySessionExport', () => {
  it('assembles shots in capture order with intent, warmup, and rounding', () => {
    const shots = [
      { ...buildShot({ capturedAt: 500 }), intent: 'draw' as const, warmup: false },
      { ...buildShot({ capturedAt: 100 }), intent: 'stock' as const, warmup: true },
    ];
    const out = buildDailySessionExport(session, shots, [], [club(shots[0].clubId, '7 Iron')], 'right');

    expect(out.contract).toBe(4);
    expect(out.shots.map((s) => s.t_ms)).toEqual([100, 500]);
    expect(out.shots[0].warmup).toBe(true);
    expect(out.shots[0].intent).toBe('stock');
    expect(out.shots[1].intent).toBe('draw');
    expect(out.default_intent).toBe('stock');
    expect(out.environment.altitude_m).toBe(1800);
    expect(out.clubs).toHaveLength(1);
    expect(out.clubs[0].name).toBe('7 Iron');
  });

  it('omits unmeasured fields instead of writing zeros', () => {
    const shot = buildShot({
      smashFactor: null,
      clubSpeedMs: null,
      flight: null,
    });
    const [row] = buildDailySessionExport(session, [shot], [], [], 'right').shots;

    expect(row).not.toHaveProperty('smash');
    expect(row).not.toHaveProperty('club_speed_ms');
    expect(row).not.toHaveProperty('carry_m');
    expect(row.ball_speed_ms).toBeGreaterThan(0);
  });

  it('attaches wrist blocks by shot and reports coverage', () => {
    const shot = {
      ...buildShot({ capturedAt: 10_000 }),
      intent: 'stock' as const,
      warmup: false,
    };
    const out = buildDailySessionExport(session, [shot], [swing(10_500)], [], 'right');

    expect(out.wrist_coverage.paired).toBe(1);
    expect(out.shots[0].wrist?.ext_top).toBe(28);
    expect(out.wrist_strap_drift).toBe(false);
  });

  it('omits the insights block entirely when none is supplied', () => {
    const out = buildDailySessionExport(session, [buildShot()], [], [], 'right');

    expect(out).not.toHaveProperty('insights');
    expect(out.insights).toBeUndefined();
  });

  it('passes the engine insights through verbatim', () => {
    const out = buildDailySessionExport(
      session,
      [buildShot()],
      [],
      [],
      'right',
      insights,
    );

    expect(out.insights).toEqual(insights);
    expect(out.insights?.findings[0].counts.bad_beyond_great_range).toBe(11);
    expect(out.insights?.buckets[0].certification).toBe('certified');
  });
});

describe('parseCoachRecap', () => {
  it('splits narrative from the fenced verdict', () => {
    const verdict = {
      headline: 'Solid ball-striking day',
      issues: [],
      strengths: [{ area: 'contact', evidence: '14 of 16 smash above 1.30' }],
      drills: [],
      caveats: [],
    };
    const text = `Good work today.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;
    const recap = parseCoachRecap(text);

    expect(recap.narrative).toBe('Good work today.');
    expect(recap.verdict?.headline).toBe('Solid ball-striking day');
  });

  it('falls back to narrative-only on malformed json', () => {
    const recap = parseCoachRecap('Nice session.\n```json\n{broken\n```');
    expect(recap.verdict).toBeNull();
    expect(recap.narrative).toContain('Nice session.');
  });
});
