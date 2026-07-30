import { classifyRep, computeDrillPlan, swingMetrics } from '@golf/drill';
import {
  ActiveSessionSlice,
  Club,
  ConnectionSlice,
  DataStore,
  DrillRep,
  DrillRung,
  DrillSlice,
  DrillState,
  Environment,
  FlightModel,
  LaunchConditions,
  LiveSlice,
  MeasuredShot,
  MonitorService,
  ShotIntent,
  ShotRecord,
  WristService,
  WristShot,
  WristSlice,
} from '@golf/types';
import { createStore } from 'zustand/vanilla';

/** Wrist swings and launch-monitor shots ride independent, unsynced device
    clocks, so they can only be joined on host arrival time. Nearest-neighbour
    within this window; buffered events older than PRUNE_MS are dropped. */
const JOIN_WINDOW_MS = 1500;
const PRUNE_MS = 5000;

/** First shots of a session are warmup (Insights §6.1) — stamped at capture,
    excluded from stats, re-taggable via setShotWarmup. */
export const WARMUP_SHOT_COUNT = 5;

export type FairwayState = ConnectionSlice &
  LiveSlice &
  ActiveSessionSlice &
  WristSlice &
  DrillSlice;

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

  // Distinguishes a user-initiated wrist disconnect from an unexpected drop, so
  // only real deaths raise the toast. Shared by disconnectWrist and the wrist
  // connection handler below (same closure).
  let wristUserDisconnecting = false;

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
    activeIntent: 'stock',
    async startSession(env: Environment, defaultIntent: ShotIntent = 'stock') {
      const session = await data.createSession({
        name: null,
        notes: null,
        startedAt: Date.now(),
        environment: env,
        defaultIntent,
      });
      set({ session, sessionShots: [], activeIntent: defaultIntent });
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
    setActiveIntent(intent: ShotIntent) {
      set({ activeIntent: intent });
    },
    async setShotIntent(shotId: string, intent: ShotIntent) {
      await data.setShotIntent(shotId, intent);
      set({
        sessionShots: get().sessionShots.map((s) =>
          s.id === shotId ? { ...s, intent } : s,
        ),
      });
    },
    async setShotWarmup(shotId: string, warmup: boolean) {
      await data.setShotWarmup(shotId, warmup);
      set({
        sessionShots: get().sessionShots.map((s) =>
          s.id === shotId ? { ...s, warmup } : s,
        ),
      });
    },

    /* ── WristSlice ── */
    wristConnection: wrist?.getState() ?? 'disconnected',
    wristDevice: null,
    wristBatteryPercent: null,
    wristHold: null,
    wristAlert: null,
    startWristScan() {
      wrist?.startScan();
    },
    stopWristScan() {
      wrist?.stopScan();
    },
    async connectWrist(deviceId: string) {
      if (!wrist) throw new Error('No wrist sensor configured');
      await wrist.connect(deviceId);
    },
    disconnectWrist() {
      wristUserDisconnecting = true;
      wrist?.disconnect();
    },
    dismissWristAlert() {
      set({ wristAlert: null });
    },

    /* ── DrillSlice ── */
    drill: null,
    async startDrill(wedgeClubIds: string[]) {
      const clubs = await data.listClubs({ includeArchived: true });
      const wedges = wedgeClubIds.map((id) => {
        const club = clubs.find((c) => c.id === id);
        if (!club) throw new Error(`Unknown club: ${id}`);
        return club;
      });
      drillWedges = wedges;
      drillReps = await data.listDrillReps(wedgeClubIds);
      set({
        drill: {
          plan: computeDrillPlan(wedges, drillReps),
          active: null,
          lastRep: null,
        },
      });
    },
    endDrill() {
      drillWedges = [];
      drillReps = [];
      repBySwing.clear();
      set({ drill: null });
    },
    async selectDrillRung(clubId: string, rung: DrillRung) {
      if (!get().drill) return;
      // Re-tags subsequent shots. Wedges are all sensor-mode 'iron', so the
      // underlying selectClub costs no device round-trip between rungs.
      await get().selectClub(clubId);
      const drill = get().drill;
      if (!drill) return;
      set({ drill: { ...drill, active: { clubId, rung } } });
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
  // Swings that fired before any session existed. The session's FIRST swing
  // routinely lands here (the wrist event beats the MINI record that lazily
  // creates the quick session) — if it went unlogged, the coach export would
  // lose a real swing from wrist_coverage AND lose the ambiguity that guards
  // its one-to-one pairing. Flushed into wrist_swings by the shot handler
  // right after ensureSession; pruned on the same horizon as the join.
  const preSessionSwings: { swing: WristShot; at: number }[] = [];

  // Drill-mode closure state. drillReps mirrors the persisted rows for the
  // drill's wedges (SQLite stays the source of truth); repBySwing lets the
  // wrist↔shot join late-attach a carry to the rep created for that swing.
  let drillWedges: Club[] = [];
  let drillReps: DrillRep[] = [];
  const repBySwing = new Map<WristShot, string>();

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

  async function attachWrist(
    record: ShotRecord,
    swing: WristShot,
  ): Promise<void> {
    await data.attachWrist(record.id, swing);
    set({
      sessionShots: get().sessionShots.map((s) =>
        s.id === record.id ? { ...s, wrist: swing } : s,
      ),
    });

    const repId = repBySwing.get(swing);
    if (!repId) return;
    repBySwing.delete(swing);
    // No flight ⇒ no carry to learn from (putter guard; wedges always fly).
    if (!record.flight) return;
    await data.setDrillRepCarry(repId, record.id, record.flight.carryM);
    const rep = drillReps.find((r) => r.id === repId);
    if (rep) {
      rep.shotId = record.id;
      rep.carryM = record.flight.carryM;
    }
    const drill = get().drill;
    if (drill) {
      set({
        drill: { ...drill, plan: computeDrillPlan(drillWedges, drillReps) },
      });
    }
  }

  async function handleShot(measured: MeasuredShot): Promise<void> {
    // Monitor already dedups; this guards the store against replays across
    // reconnects within one session.
    if (get().sessionShots.some((s) => s.shotGuid === measured.shotGuid)) {
      return;
    }
    const session = await ensureSession();
    // flush swings that beat the session into existence — the first ball's
    // own swing routinely does — dropping any beyond the join horizon
    const flushAt = Date.now();
    for (const held of preSessionSwings.splice(0)) {
      if (flushAt - held.at <= PRUNE_MS) {
        await logWristSwing(session.id, held.swing);
      }
    }
    const club = await ensureClub();
    // Flight simulation is meaningless for putts (no ballistic flight).
    const flight =
      club.category === 'putter'
        ? null
        : flightModel.simulate(
            launchConditionsFrom(measured),
            session.environment,
          );
    // Stamp intent + warmup at capture (Insights §6.1): the active intent,
    // and warmup for the session's first shots — discarded shots don't count
    // toward the warmup window.
    const priorShots = get().sessionShots.filter((s) => !s.discarded).length;
    const record = await data.insertShot(session.id, club.id, measured, flight, {
      intent: get().activeIntent,
      warmup: priorShots < WARMUP_SHOT_COUNT,
    });
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

  /** Judge a swing against the active rung, persist it as a DrillRep, and
      publish the recomputed plan + lastRep feedback. Runs BEFORE the
      wrist↔shot join so the rep is in repBySwing by the time attachWrist
      fires for a shot that arrived first. */
  async function recordDrillRep(
    drill: DrillState,
    active: { clubId: string; rung: DrillRung },
    swing: WristShot,
  ): Promise<void> {
    const metrics = swingMetrics(swing);
    const rungPlan = drill.plan.wedges
      .find((w) => w.club.id === active.clubId)
      ?.rungs.find((r) => r.rung === active.rung);
    const targetAngleDeg = rungPlan?.targetAngleDeg ?? null;
    const outcome = classifyRep(
      metrics.topAngleDeg,
      targetAngleDeg,
      rungPlan?.toleranceDeg ?? 0,
    );
    const rep = await data.insertDrillRep({
      clubId: active.clubId,
      rung: active.rung,
      shotId: null,
      tMs: swing.tImpactMs,
      topAngleDeg: metrics.topAngleDeg,
      topExtensionDeg: metrics.topExtensionDeg,
      backswingMs: metrics.backswingMs,
      downswingMs: metrics.downswingMs,
      targetAngleDeg,
      outcome,
      carryM: null,
    });
    drillReps.push(rep);
    repBySwing.set(swing, rep.id);
    set({
      drill: {
        plan: computeDrillPlan(drillWedges, drillReps),
        active,
        lastRep: {
          repId: rep.id,
          clubId: active.clubId,
          rung: active.rung,
          outcome,
          topAngleDeg: metrics.topAngleDeg,
          targetAngleDeg,
          deltaDeg:
            targetAngleDeg === null
              ? null
              : metrics.topAngleDeg - targetAngleDeg,
          at: Date.now(),
        },
      },
    });
  }

  /** Log a validated swing for the coach export's coverage. Isolated
      failure: a DB hiccup here must not cost the drill rep or the join. */
  async function logWristSwing(sessionId: string, swing: WristShot): Promise<void> {
    await data
      .insertWristSwing({
        sessionId,
        tImpactMs: swing.tImpactMs,
        // the live wrist service always attaches a coach result; a missing
        // one means extraction never ran — integrity unknown, glitch
        coach: swing.coach ?? { status: 'dropped', reason: 'glitch' },
      })
      .catch((err: Error) => onError(err));
  }

  async function handleSwing(swing: WristShot): Promise<void> {
    // Log EVERY validated swing — including practice swings the join below
    // will never match (they'd otherwise age out of the buffer without a
    // trace). With no session yet, hold the swing for the shot handler to
    // flush once its ensureSession runs.
    const session = get().session;
    if (session) {
      await logWristSwing(session.id, swing);
    } else {
      while (
        preSessionSwings.length &&
        swing.tImpactMs - preSessionSwings[0].at > PRUNE_MS
      ) {
        preSessionSwings.shift();
      }
      preSessionSwings.push({ swing, at: swing.tImpactMs });
    }
    const drill = get().drill;
    if (drill?.active) {
      await recordDrillRep(drill, drill.active, swing);
    }
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
  wrist?.on('connection', (wristConnection) => {
    const wasConnected = get().wristConnection === 'connected';
    const dropped =
      wristConnection === 'disconnected' ||
      wristConnection === 'error' ||
      wristConnection === 'poweredOff';
    // A drop from a live connection that the user didn't ask for is a death.
    const died = wasConnected && dropped && !wristUserDisconnecting;
    if (wristConnection === 'connected' || wristConnection === 'disconnected') {
      wristUserDisconnecting = false;
    }
    set(
      wristConnection === 'connected'
        ? { wristConnection, wristAlert: null }
        : {
            wristConnection,
            wristHold: null,
            wristAlert: died
              ? 'HackMotion disconnected — wrist data paused. Reconnect to resume.'
              : get().wristAlert,
          },
    );
  });
  wrist?.on('device', (wristDevice) => set({ wristDevice }));
  wrist?.on('battery', (wristBatteryPercent) => set({ wristBatteryPercent }));
  wrist?.on('hold', (wristHold) => set({ wristHold }));
  wrist?.on('swing', (swing) => {
    void handleSwing(swing).catch((err: Error) => onError(err));
  });

  return store;
}
