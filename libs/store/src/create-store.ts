import {
  ActiveSessionSlice,
  Club,
  ConnectionSlice,
  DataStore,
  Environment,
  FlightModel,
  LaunchConditions,
  LiveSlice,
  MeasuredShot,
  MonitorService,
  ShotRecord,
  WristService,
  WristShot,
} from '@golf/types';
import { createStore } from 'zustand/vanilla';

/** Wrist swings and launch-monitor shots ride independent, unsynced device
    clocks, so they can only be joined on host arrival time. Nearest-neighbour
    within this window; buffered events older than PRUNE_MS are dropped. */
const JOIN_WINDOW_MS = 1500;
const PRUNE_MS = 5000;

export type FairwayState = ConnectionSlice & LiveSlice & ActiveSessionSlice;

export interface FairwayStoreDeps {
  monitor: MonitorService;
  data: DataStore;
  flightModel: FlightModel;
  /** optional wrist sensor; when present, its swings are joined onto shots */
  wrist?: WristService;
  /** current environment for implicit quick sessions — read at shot time */
  getDefaultEnvironment(): Environment;
  /** non-fatal pipeline errors (e.g. persist failure) — surface, don't swallow */
  onError(err: Error): void;
}

export type FairwayStore = ReturnType<typeof createFairwayStore>;

const launchConditionsFrom = (m: MeasuredShot): LaunchConditions => ({
  ballSpeedMs: m.ball.speedMs,
  launchAngleDeg: m.ball.launchAngleDeg,
  launchDirectionDeg: m.ball.launchDirectionDeg,
  backspinRpm: m.ball.backspinRpm,
  sidespinRpm: m.ball.sidespinRpm,
  rollspinRpm: m.ball.rollspinRpm,
});

/**
 * The one cross-domain wiring point outside the app: subscribes to
 * MonitorService events, persists shots via DataStore, attaches FlightModel
 * results, and exposes the three CONTRACTS slices to the UI.
 */
export function createFairwayStore(deps: FairwayStoreDeps) {
  const { monitor, wrist, data, flightModel, getDefaultEnvironment, onError } =
    deps;

  const store = createStore<FairwayState>()((set, get) => ({
    /* ── ConnectionSlice ── */
    connection: 'disconnected',
    device: null,
    startDiscovery() {
      monitor.startDiscovery();
    },
    async connect(ip: string) {
      await monitor.connect(ip);
    },
    disconnect() {
      monitor.disconnect();
    },

    /* ── LiveSlice ── */
    ballReady: false,
    lastShot: null,
    sessionShots: [],

    /* ── ActiveSessionSlice ── */
    session: null,
    activeClub: null,
    async startSession(env: Environment) {
      const session = await data.createSession({
        name: null,
        notes: null,
        startedAt: Date.now(),
        environment: env,
      });
      set({ session, sessionShots: [] });
    },
    async endSession() {
      const current = get().session;
      if (!current) return;
      await data.endSession(current.id);
      set({ session: null, sessionShots: [], lastShot: null });
    },
    async selectClub(clubId: string) {
      const clubs = await data.listClubs({ includeArchived: true });
      const club = clubs.find((c) => c.id === clubId);
      if (!club) throw new Error(`Unknown club: ${clubId}`);
      await activateClub(club);
    },
    async createClub(input: Omit<Club, 'id' | 'createdAt' | 'sensorMode'>) {
      const club = await data.createClub(input);
      await activateClub(club);
      return club;
    },
  }));

  /** re-tag is free; only a sensor-mode change costs a device round-trip */
  async function activateClub(club: Club): Promise<void> {
    const previous = get().activeClub;
    if (previous?.sensorMode !== club.sensorMode) {
      await monitor.setClub(club.sensorMode);
    }
    set({ activeClub: club });
  }

  const { getState: get, setState: set } = store;

  async function ensureSession() {
    const existing = get().session;
    if (existing) return existing;
    // Implicit "quick session" (BUILD_SPEC F2): never lose a shot because no
    // session was started.
    const session = await data.createSession({
      name: 'Quick session',
      notes: null,
      startedAt: Date.now(),
      environment: getDefaultEnvironment(),
    });
    set({ session, sessionShots: [] });
    return session;
  }

  async function ensureClub(): Promise<Club> {
    const active = get().activeClub;
    if (active) return active;
    const clubs = await data.listClubs();
    const fallback = clubs[0];
    if (!fallback) throw new Error('No clubs exist — seed defaults first');
    set({ activeClub: fallback });
    return fallback;
  }

  // Wrist↔shot correlation buffers (only used when a wrist service is wired).
  const pendingSwings: { swing: WristShot; at: number }[] = [];
  const pendingShots: { record: ShotRecord; at: number }[] = [];

  function nearestWithin(times: { at: number }[], target: number): number {
    let best = -1;
    let bestDelta = JOIN_WINDOW_MS;
    times.forEach((entry, i) => {
      const delta = Math.abs(entry.at - target);
      if (delta <= bestDelta) {
        bestDelta = delta;
        best = i;
      }
    });
    return best;
  }

  function prune(now: number): void {
    while (pendingSwings.length && now - pendingSwings[0].at > PRUNE_MS) {
      pendingSwings.shift();
    }
    while (pendingShots.length && now - pendingShots[0].at > PRUNE_MS) {
      pendingShots.shift();
    }
  }

  async function attachWrist(record: ShotRecord, swing: WristShot): Promise<void> {
    await data.attachWrist(record.id, swing);
    set({
      sessionShots: get().sessionShots.map((s) =>
        s.id === record.id ? { ...s, wrist: swing } : s,
      ),
    });
  }

  async function handleShot(measured: MeasuredShot): Promise<void> {
    // Monitor already dedups; this guards the store against replays across
    // reconnects within one session.
    if (get().sessionShots.some((s) => s.shotGuid === measured.shotGuid)) {
      return;
    }
    const session = await ensureSession();
    const club = await ensureClub();
    // Flight simulation is meaningless for putts (no ballistic flight).
    const flight =
      club.category === 'putter'
        ? null
        : flightModel.simulate(
            launchConditionsFrom(measured),
            session.environment,
          );
    const record = await data.insertShot(session.id, club.id, measured, flight);
    set({
      lastShot: measured,
      sessionShots: [record, ...get().sessionShots],
    });

    if (!wrist) return;
    const arrivalAt = Date.now();
    prune(arrivalAt);
    const idx = nearestWithin(pendingSwings, arrivalAt);
    if (idx >= 0) {
      const [{ swing }] = pendingSwings.splice(idx, 1);
      await attachWrist(record, swing);
    } else {
      pendingShots.push({ record, at: arrivalAt });
    }
  }

  async function handleSwing(swing: WristShot): Promise<void> {
    prune(swing.tImpactMs);
    const idx = nearestWithin(pendingShots, swing.tImpactMs);
    if (idx >= 0) {
      const [{ record }] = pendingShots.splice(idx, 1);
      await attachWrist(record, swing);
    } else {
      // Practice swings fire the wrist unit but produce no shot — they simply
      // age out of the buffer unmatched.
      pendingSwings.push({ swing, at: swing.tImpactMs });
    }
  }

  monitor.on('connection', (connection) => set({ connection }));
  monitor.on('device', (device) => set({ device }));
  monitor.on('ballDetected', (_mode, exists) => set({ ballReady: exists }));
  monitor.on('shot', (measured) => {
    void handleShot(measured).catch((err: Error) => onError(err));
  });
  wrist?.on('swing', (swing) => {
    void handleSwing(swing).catch((err: Error) => onError(err));
  });

  return store;
}
