import {
  AnalysisRecord,
  Club,
  DataStore,
  DrillRep,
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
  curveM: -1,
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
  drillReps: DrillRep[] = [];
  private nextId = 1;
  private nextCreatedAt = 1;

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
  async insertDrillRep(
    input: Omit<DrillRep, 'id' | 'createdAt'>,
  ): Promise<DrillRep> {
    const created: DrillRep = {
      ...input,
      id: `rep-${this.nextId++}`,
      createdAt: this.nextCreatedAt++,
    };
    this.drillReps.push(created);
    return created;
  }
  async setDrillRepCarry(
    repId: string,
    shotId: string,
    carryM: number,
  ): Promise<void> {
    const rep = this.drillReps.find((r) => r.id === repId);
    if (!rep) throw new Error('missing');
    rep.shotId = shotId;
    rep.carryM = carryM;
  }
  async listDrillReps(clubIds: string[]): Promise<DrillRep[]> {
    return this.drillReps
      .filter((r) => clubIds.includes(r.clubId))
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}

type WristHandler = WristServiceEvents[keyof WristServiceEvents];

class FakeWrist implements WristService {
  private handlers = new Map<string, WristHandler[]>();
  startScan(): void {}
  stopScan(): void {}
  async connect(): Promise<void> {}
  disconnect(): void {}
  setCalibration(): void {}
  setEmitSamples(): void {}
  vibrate(): void {}
  getState(): 'disconnected' {
    return 'disconnected';
  }
  on<K extends keyof WristServiceEvents>(e: K, h: WristServiceEvents[K]): void {
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

const swingAt = (
  tImpactMs: number,
  topFromAddressDeg: [number, number, number] = [1, 2, 3],
): WristShot => {
  const kf = {
    tMs: tImpactMs,
    tDevS: tImpactMs / 1000,
    angularSpeedDegS: 100,
    angles: { extensionDeg: null, deviationDeg: null, rotationDeg: null },
    rotVecDeg: [1, 2, 3] as [number, number, number],
    rotVecFromAddressDeg: [0, 0, 0] as [number, number, number],
  };
  return {
    tImpactMs,
    durationMs: 1300,
    peakAngularSpeedDegS: 480,
    calibrated: false,
    addressHeldMs: 1800,
    backswingMs: 700,
    topPauseMs: 0,
    downswingMs: 250,
    address: kf,
    top: { ...kf, rotVecFromAddressDeg: topFromAddressDeg },
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

async function createWedge(
  data: FakeData,
  name: string,
  loftDeg: number,
): Promise<Club> {
  return data.createClub({
    name,
    category: 'wedge',
    swingTag: null,
    loftDeg,
    notes: null,
    tracerColor: null,
    focusNote: null,
    archived: false,
  });
}

function drillOf(store: ReturnType<typeof build>['store']) {
  const drill = store.getState().drill;
  if (!drill) throw new Error('drill mode is off');
  return drill;
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

describe('createFairwayStore — wrist slice', () => {
  it('mirrors wrist connection, device, and battery events', () => {
    const wrist = new FakeWrist();
    const { store } = build({ wrist });
    expect(store.getState().wristConnection).toBe('disconnected');

    wrist.emit('connection', 'connected');
    wrist.emit('device', {
      id: 'hm-1',
      name: 'HackMotion',
      serial: null,
      batteryPercent: null,
    });
    wrist.emit('battery', 85, 3900);

    const state = store.getState();
    expect(state.wristConnection).toBe('connected');
    expect(state.wristDevice?.id).toBe('hm-1');
    expect(state.wristBatteryPercent).toBe(85);
  });

  it('mirrors hold progress and clears it when the sensor drops', () => {
    const wrist = new FakeWrist();
    const { store } = build({ wrist });
    wrist.emit('connection', 'connected');
    wrist.emit('hold', { tMs: 1000, heldMs: 900, requiredMs: 1500, armed: false });
    expect(store.getState().wristHold?.heldMs).toBe(900);
    wrist.emit('hold', { tMs: 1700, heldMs: 1600, requiredMs: 1500, armed: true });
    expect(store.getState().wristHold?.armed).toBe(true);
    wrist.emit('connection', 'disconnected');
    expect(store.getState().wristHold).toBeNull();
  });

  it('raises a dismissable alert when the wrist drops unexpectedly', () => {
    const wrist = new FakeWrist();
    const { store } = build({ wrist });
    wrist.emit('connection', 'connected');
    expect(store.getState().wristAlert).toBeNull();

    // BLE/battery death: connected → disconnected with no user action
    wrist.emit('connection', 'disconnected');
    expect(store.getState().wristAlert).toContain('HackMotion disconnected');
    expect(store.getState().wristHold).toBeNull();

    store.getState().dismissWristAlert();
    expect(store.getState().wristAlert).toBeNull();
  });

  it('does not alert on a user-initiated wrist disconnect', () => {
    const wrist = new FakeWrist();
    const { store } = build({ wrist });
    wrist.emit('connection', 'connected');
    store.getState().disconnectWrist(); // FakeWrist.disconnect is a no-op…
    wrist.emit('connection', 'disconnected'); // …so emit the drop it would cause
    expect(store.getState().wristAlert).toBeNull();
  });

  it('clears the alert when the wrist reconnects', () => {
    const wrist = new FakeWrist();
    const { store } = build({ wrist });
    wrist.emit('connection', 'connected');
    wrist.emit('connection', 'error');
    expect(store.getState().wristAlert).not.toBeNull();
    wrist.emit('connection', 'connected');
    expect(store.getState().wristAlert).toBeNull();
  });

  it('rejects connectWrist when no wrist service is configured', async () => {
    const { store } = build();
    await expect(store.getState().connectWrist('hm-1')).rejects.toThrow(
      'No wrist sensor configured',
    );
    // scan/disconnect are safe no-ops without a service
    store.getState().startWristScan();
    store.getState().stopWristScan();
    store.getState().disconnectWrist();
    expect(store.getState().wristConnection).toBe('disconnected');
  });
});

describe('createFairwayStore — drill mode', () => {
  it('records a calibrating rep and fires lastRep when no target exists', async () => {
    const wrist = new FakeWrist();
    const { data, store, errors } = build({ wrist });
    const wedge = await createWedge(data, '56°', 56);
    await store.getState().startDrill([wedge.id]);
    await store.getState().selectDrillRung(wedge.id, 'mid');

    wrist.emit('swing', swingAt(Date.now(), [40, 0, 0]));
    await flush();

    expect(errors).toHaveLength(0);
    expect(data.drillReps).toHaveLength(1);
    expect(data.drillReps[0]).toMatchObject({
      clubId: wedge.id,
      rung: 'mid',
      outcome: 'calibrating',
      targetAngleDeg: null,
      topAngleDeg: 40,
      shotId: null,
      carryM: null,
    });
    expect(drillOf(store).lastRep).toMatchObject({
      repId: data.drillReps[0].id,
      clubId: wedge.id,
      rung: 'mid',
      outcome: 'calibrating',
      topAngleDeg: 40,
      targetAngleDeg: null,
      deltaDeg: null,
    });
  });

  it('learns the full anchor and ladders partial targets from joined carries', async () => {
    const wrist = new FakeWrist();
    const { monitor, data, store, errors } = build({ wrist });
    const wedge = await createWedge(data, '56°', 56);
    await store.getState().startDrill([wedge.id]);
    await store.getState().selectDrillRung(wedge.id, 'full');

    const tops: [number, number, number][] = [
      [76, 0, 0],
      [84, 0, 0],
      [80, 0, 0],
    ];
    for (const [i, top] of tops.entries()) {
      wrist.emit('swing', swingAt(Date.now(), top));
      await flush();
      monitor.emit('shot', measuredFixture(`g-full-${i}`));
      await flush();
    }

    expect(errors).toHaveLength(0);
    const [full, mid, low] = drillOf(store).plan.wedges[0].rungs;
    expect(full.rung).toBe('full');
    expect(full.status).toBe('ready');
    expect(full.targetAngleDeg).toBe(80); // median of 76 / 84 / 80
    expect(full.targetCarryM).toBe(150);
    expect(full.carry).toEqual({ n: 3, meanM: 150, sdM: 0 });
    // 3-point even grid over [floor, 150] → partials at 18.288 and 84.144.
    // Angle targets are LEARNED, never assumed: three clustered fulls can't
    // identify the angle↔carry slope, so the partials calibrate on their
    // carry numbers with no angle target in force.
    expect(mid.rung).toBe('mid');
    expect(mid.status).toBe('calibrating');
    expect(mid.targetCarryM).toBeCloseTo(84.144, 2);
    expect(mid.targetAngleDeg).toBeNull();
    expect(low.rung).toBe('low');
    expect(low.status).toBe('calibrating');
    expect(low.targetCarryM).toBeCloseTo(18.288, 2);
    expect(low.targetAngleDeg).toBeNull();

    // reps persist: restarting the drill rebuilds the plan from the store
    store.getState().endDrill();
    await store.getState().startDrill([wedge.id]);
    expect(drillOf(store).plan.wedges[0].rungs[0].status).toBe('ready');
  });

  it('attaches a joined carry to the rep in both arrival orders', async () => {
    const wrist = new FakeWrist();
    const { monitor, data, store, errors } = build({ wrist });
    const wedge = await createWedge(data, '56°', 56);
    await store.getState().startDrill([wedge.id]);
    await store.getState().selectDrillRung(wedge.id, 'full');

    // shot first: the swing's rep must exist before the join fires
    monitor.emit('shot', measuredFixture('g-a'));
    await flush();
    wrist.emit('swing', swingAt(Date.now()));
    await flush();

    expect(errors).toHaveLength(0);
    expect(data.drillReps[0].carryM).toBe(150);
    expect(data.drillReps[0].shotId).toBe(data.shots[0].id);
    expect(drillOf(store).plan.wedges[0].rungs[0].carry?.n).toBe(1);

    // swing first: the carry lands when the shot arrives ~1 s later
    wrist.emit('swing', swingAt(Date.now()));
    await flush();
    expect(data.drillReps[1].carryM).toBeNull();
    monitor.emit('shot', measuredFixture('g-b'));
    await flush();

    expect(data.drillReps[1].carryM).toBe(150);
    expect(data.drillReps[1].shotId).toBe(data.shots[1].id);
    expect(drillOf(store).plan.wedges[0].rungs[0].carry?.n).toBe(2);
  });

  it('records no reps when drill is off or no rung is active', async () => {
    const wrist = new FakeWrist();
    const { data, store } = build({ wrist });
    const wedge = await createWedge(data, '56°', 56);

    wrist.emit('swing', swingAt(Date.now())); // drill off
    await flush();
    expect(data.drillReps).toHaveLength(0);

    await store.getState().startDrill([wedge.id]);
    wrist.emit('swing', swingAt(Date.now())); // drill on, observe-only
    await flush();
    expect(data.drillReps).toHaveLength(0);
  });

  it('endDrill clears drill state and stops judging swings', async () => {
    const wrist = new FakeWrist();
    const { data, store } = build({ wrist });
    const wedge = await createWedge(data, '56°', 56);
    await store.getState().startDrill([wedge.id]);
    await store.getState().selectDrillRung(wedge.id, 'full');
    wrist.emit('swing', swingAt(Date.now()));
    await flush();
    expect(data.drillReps).toHaveLength(1);

    store.getState().endDrill();
    expect(store.getState().drill).toBeNull();

    wrist.emit('swing', swingAt(Date.now()));
    await flush();
    expect(data.drillReps).toHaveLength(1);
  });

  it('startDrill throws on an unknown club id', async () => {
    const { store } = build();
    await expect(store.getState().startDrill(['nope'])).rejects.toThrow(
      'Unknown club: nope',
    );
    expect(store.getState().drill).toBeNull();
  });
});
