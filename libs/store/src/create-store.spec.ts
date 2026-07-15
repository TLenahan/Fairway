import {
  AnalysisRecord,
  Club,
  DataStore,
  FlightModel,
  FlightResult,
  MeasuredShot,
  MonitorService,
  MonitorServiceEvents,
  Session,
  ShotRecord,
  WristService,
  WristServiceEvents,
  WristShot,
} from '@golf/types';

import { createFairwayStore } from './create-store';

const flightFixture: FlightResult = {
  path: [{ t: 0, x: 0, y: 0, z: 0 }],
  carryM: 150,
  totalM: 155,
  apexM: 25,
  descentDeg: 45,
  flightTimeS: 5.5,
  offlineM: -2,
  landing: { x: 150, z: -2 },
  rolloutM: 5,
  computed: true,
};

const measuredFixture = (guid: string): MeasuredShot => ({
  shotGuid: guid,
  handedness: 'right',
  impactTimestamp: 1783975921445500,
  ball: {
    speedMs: 26.092,
    launchAngleDeg: 25.63,
    launchDirectionDeg: -2.011,
    backspinRpm: 6918.153,
    sidespinRpm: 1396.358,
    rollspinRpm: 1028.395,
    spinAssurance: 97,
  },
  club: {
    speedMs: 25.357,
    pathDeg: -1.867,
    faceAngleDeg: null,
    attackAngleDeg: -6.2,
    loftDeg: null,
    lieDeg: null,
    faceImpactHMm: null,
    faceImpactVMm: null,
  },
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
  smashFactor: 1.028986,
  shotImgPath: null,
});

type Handler = MonitorServiceEvents[keyof MonitorServiceEvents];

class FakeMonitor implements MonitorService {
  setClubCalls: string[] = [];
  private handlers = new Map<string, Handler[]>();
  startDiscovery(): void {}
  stopDiscovery(): void {}
  async connect(): Promise<void> {}
  disconnect(): void {}
  async setClub(mode: 'tee' | 'iron' | 'putter'): Promise<void> {
    this.setClubCalls.push(mode);
  }
  async setHandedness(): Promise<void> {}
  getState(): 'disconnected' {
    return 'disconnected';
  }
  on<K extends keyof MonitorServiceEvents>(
    e: K,
    h: MonitorServiceEvents[K],
  ): void {
    this.handlers.set(e, [...(this.handlers.get(e) ?? []), h]);
  }
  off(): void {}
  emit<K extends keyof MonitorServiceEvents>(
    e: K,
    ...args: Parameters<MonitorServiceEvents[K]>
  ): void {
    for (const h of this.handlers.get(e) ?? []) {
      (h as (...a: Parameters<MonitorServiceEvents[K]>) => void)(...args);
    }
  }
}

class FakeData implements DataStore {
  clubs: Club[] = [];
  sessions: Session[] = [];
  shots: ShotRecord[] = [];
  private nextId = 1;

  async createClub(
    input: Omit<Club, 'id' | 'createdAt' | 'sensorMode'>,
  ): Promise<Club> {
    const sensorMode =
      input.category === 'driver'
        ? 'tee'
        : input.category === 'putter'
          ? 'putter'
          : 'iron';
    const created: Club = {
      ...input,
      id: `club-${this.nextId++}`,
      createdAt: 1,
      sensorMode,
    };
    this.clubs.push(created);
    return created;
  }
  async updateClub(id: string, patch: Partial<Club>): Promise<Club> {
    const club = this.clubs.find((c) => c.id === id);
    if (!club) throw new Error('missing');
    Object.assign(club, patch);
    return club;
  }
  async listClubs(): Promise<Club[]> {
    return this.clubs;
  }
  async archiveClub(): Promise<void> {}
  async createSession(
    input: Omit<Session, 'id' | 'createdAt' | 'endedAt'>,
  ): Promise<Session> {
    const created: Session = {
      ...input,
      id: `session-${this.nextId++}`,
      createdAt: 1,
      endedAt: null,
    };
    this.sessions.push(created);
    return created;
  }
  async endSession(id: string): Promise<Session> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) throw new Error('missing');
    session.endedAt = 2;
    return session;
  }
  async getSession(): Promise<Session | null> {
    return null;
  }
  async listSessions(): Promise<Session[]> {
    return this.sessions;
  }
  async insertShot(
    sessionId: string,
    clubId: string,
    m: MeasuredShot,
    flight: FlightResult | null,
  ): Promise<ShotRecord> {
    const record: ShotRecord = {
      id: `shot-${this.nextId++}`,
      sessionId,
      clubId,
      shotGuid: m.shotGuid,
      capturedAt: 3,
      discarded: false,
      measured: m,
      flight,
    };
    this.shots.push(record);
    return record;
  }
  async attachFlight(): Promise<void> {}
  async attachWrist(shotId: string, wrist: WristShot): Promise<void> {
    const shot = this.shots.find((s) => s.id === shotId);
    if (shot) shot.wrist = wrist;
  }
  async setShotDiscarded(): Promise<void> {}
  async listShots(): Promise<ShotRecord[]> {
    return this.shots;
  }
  async listShotsByClub(): Promise<ShotRecord[]> {
    return this.shots;
  }
  async saveAnalysis(): Promise<void> {}
  async listAnalyses(): Promise<AnalysisRecord[]> {
    return [];
  }
}

type WristHandler = WristServiceEvents[keyof WristServiceEvents];

class FakeWrist implements WristService {
  private handlers = new Map<string, WristHandler[]>();
  startScan(): void {}
  stopScan(): void {}
  async connect(): Promise<void> {}
  disconnect(): void {}
  getState(): 'disconnected' {
    return 'disconnected';
  }
  on<K extends keyof WristServiceEvents>(
    e: K,
    h: WristServiceEvents[K],
  ): void {
    this.handlers.set(e, [...(this.handlers.get(e) ?? []), h]);
  }
  off(): void {}
  emit<K extends keyof WristServiceEvents>(
    e: K,
    ...args: Parameters<WristServiceEvents[K]>
  ): void {
    for (const h of this.handlers.get(e) ?? []) {
      (h as (...a: Parameters<WristServiceEvents[K]>) => void)(...args);
    }
  }
}

const swingAt = (tImpactMs: number): WristShot => {
  const kf = {
    tMs: tImpactMs,
    angularSpeedDegS: 100,
    angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
    rotVecDeg: [1, 2, 3] as [number, number, number],
  };
  return {
    tImpactMs,
    durationMs: 700,
    peakAngularSpeedDegS: 480,
    calibrated: false,
    address: kf,
    top: kf,
    impact: kf,
    shock: { tMs: tImpactMs, offsetFromImpactMs: 0, peakAbsLsb: 4000 },
  };
};

const fakeFlightModel: FlightModel = {
  simulate: () => flightFixture,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function build(opts: { wrist?: FakeWrist } = {}) {
  const monitor = new FakeMonitor();
  const data = new FakeData();
  const errors: Error[] = [];
  const store = createFairwayStore({
    monitor,
    wrist: opts.wrist,
    data,
    flightModel: fakeFlightModel,
    getDefaultEnvironment: () => ({
      altitudeM: 1849,
      temperatureC: null,
      presetName: 'Home ~6,000 ft',
    }),
    onError: (e) => errors.push(e),
  });
  return { monitor, data, store, errors };
}

async function withActiveIron(store: ReturnType<typeof build>['store']) {
  await store.getState().createClub({
    name: '7 Iron',
    category: 'iron',
    swingTag: 'full',
    loftDeg: 34,
    notes: null,
    tracerColor: null,
    focusNote: null,
    archived: false,
  });
}

describe('createFairwayStore', () => {
  it('persists an incoming shot into an implicit quick session', async () => {
    const { monitor, data, store, errors } = build();
    await data.createClub({
      name: '7 Iron',
      category: 'iron',
      swingTag: 'full',
      loftDeg: 34,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });

    monitor.emit('shot', measuredFixture('g-1'));
    await flush();

    expect(errors).toHaveLength(0);
    const state = store.getState();
    expect(state.session?.name).toBe('Quick session');
    expect(state.sessionShots).toHaveLength(1);
    expect(state.sessionShots[0].flight?.carryM).toBe(150);
    expect(state.lastShot?.shotGuid).toBe('g-1');
  });

  it('ignores a replayed shotGuid within the session', async () => {
    const { monitor, data, store } = build();
    await data.createClub({
      name: '7 Iron',
      category: 'iron',
      swingTag: 'full',
      loftDeg: 34,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });

    monitor.emit('shot', measuredFixture('g-1'));
    await flush();
    monitor.emit('shot', measuredFixture('g-1'));
    await flush();

    expect(store.getState().sessionShots).toHaveLength(1);
    expect(data.shots).toHaveLength(1);
  });

  it('only reconfigures the sensor when the mode actually changes', async () => {
    const { monitor, data, store } = build();
    const seven = await data.createClub({
      name: '7 Iron',
      category: 'iron',
      swingTag: 'full',
      loftDeg: 34,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    const wedge = await data.createClub({
      name: '60° ½ swing',
      category: 'wedge',
      swingTag: 'half',
      loftDeg: 60,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    const driver = await data.createClub({
      name: 'Driver',
      category: 'driver',
      swingTag: 'full',
      loftDeg: 10.5,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });

    await store.getState().selectClub(seven.id); // null → iron: round-trip
    await store.getState().selectClub(wedge.id); // iron → iron: no round-trip
    await store.getState().selectClub(driver.id); // iron → tee: round-trip

    expect(monitor.setClubCalls).toEqual(['iron', 'tee']);
  });

  it('skips flight simulation for putts', async () => {
    const { monitor, data, store } = build();
    const putter = await data.createClub({
      name: 'Putter',
      category: 'putter',
      swingTag: null,
      loftDeg: null,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    await store.getState().selectClub(putter.id);

    monitor.emit('shot', measuredFixture('g-putt'));
    await flush();

    expect(store.getState().sessionShots[0].flight).toBeNull();
  });

  it('quick-add creates and immediately activates the club', async () => {
    const { monitor, store } = build();
    const club = await store.getState().createClub({
      name: '60° ½ swing',
      category: 'wedge',
      swingTag: 'half',
      loftDeg: 60,
      notes: null,
      tracerColor: null,
      focusNote: null,
      archived: false,
    });
    expect(store.getState().activeClub?.id).toBe(club.id);
    expect(monitor.setClubCalls).toEqual(['iron']);
  });

  it('joins a wrist swing arriving just after its shot', async () => {
    const wrist = new FakeWrist();
    const { monitor, data, store, errors } = build({ wrist });
    await withActiveIron(store);

    monitor.emit('shot', measuredFixture('g-1'));
    await flush();
    wrist.emit('swing', swingAt(Date.now()));
    await flush();

    expect(errors).toHaveLength(0);
    expect(store.getState().sessionShots[0].wrist?.peakAngularSpeedDegS).toBe(
      480,
    );
    expect(data.shots[0].wrist).toBeDefined();
  });

  it('joins a wrist swing arriving just before its shot', async () => {
    const wrist = new FakeWrist();
    const { monitor, store } = build({ wrist });
    await withActiveIron(store);

    wrist.emit('swing', swingAt(Date.now()));
    await flush();
    monitor.emit('shot', measuredFixture('g-2'));
    await flush();

    expect(store.getState().sessionShots[0].wrist).toBeDefined();
  });

  it('leaves a shot unjoined when no swing is near in time', async () => {
    const wrist = new FakeWrist();
    const { monitor, store, errors } = build({ wrist });
    await withActiveIron(store);

    // practice swing far in the past: no shot, no crash, ages out
    wrist.emit('swing', swingAt(Date.now() - 100_000));
    await flush();
    expect(store.getState().sessionShots).toHaveLength(0);

    monitor.emit('shot', measuredFixture('g-3'));
    await flush();
    expect(errors).toHaveLength(0);
    expect(store.getState().sessionShots[0].wrist).toBeUndefined();
  });
});
