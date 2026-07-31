import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// Type-only: the engine never runs in the browser, so esbuild drops this
// import entirely. The renderer reads the wire shape the server computes.
import type {
  BucketStatusWire,
  CertificationStatus,
  FailureMode,
  FindingWire,
  InsightMetricKey,
  InsightsWire,
} from '@golf/insights';
import { ShotIntent } from '@golf/types';

import { HubCommand, HubSnapshot, SnapshotMessage } from '../shared/protocol';

const INTENTS: ShotIntent[] = ['stock', 'draw', 'fade'];

/** Session UI v1: connection status, session controls, club picker, shot log. */

const MS_TO_MPH = 2.23694;
const M_TO_YD = 1.09361;
const MAX_FINDINGS = 8;

function useHub(): {
  snapshot: HubSnapshot | null;
  connected: boolean;
  send(command: HubCommand): void;
} {
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retry: number | undefined;
    const open = (): void => {
      const socket = new WebSocket(`ws://${location.host}/ws`);
      socketRef.current = socket;
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as SnapshotMessage;
        if (message.type === 'snapshot') setSnapshot(message.snapshot);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!disposed) retry = window.setTimeout(open, 1000);
      };
    };
    open();
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  return {
    snapshot,
    connected,
    send: (command) => socketRef.current?.send(JSON.stringify(command)),
  };
}

/**
 * Findings are cross-session by construction, so the engine only has something
 * new to say once a session closes — fetch on mount and on that falling edge
 * rather than polling. Returns null until the first fetch resolves, which is
 * what keeps the panel hidden instead of flashing an empty state.
 */
function useInsights(snapshot: HubSnapshot | null): InsightsWire | null {
  const [insights, setInsights] = useState<InsightsWire | null>(null);
  const fetched = useRef(false);
  const live = snapshot?.session != null && snapshot.session.endedAt === null;

  useEffect(() => {
    if (live && fetched.current) return;
    fetched.current = true;
    let disposed = false;
    fetch('/api/insights')
      .then((response) => (response.ok ? response.json() : null))
      .then((wire: InsightsWire | null) => {
        if (!disposed && wire) setInsights(wire);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [live]);

  return insights;
}

/** Engine keys are never shown raw — these maps are the whole UI vocabulary. */
const METRIC_WORDS: Record<InsightMetricKey, string> = {
  smash: 'smash factor',
  ballSpeedMs: 'ball speed',
  clubSpeedMs: 'club speed',
  launchDeg: 'launch angle',
  launchDirDeg: 'launch direction',
  backspinRpm: 'backspin',
  sidespinRpm: 'sidespin',
  carryM: 'carry',
  offlineM: 'offline',
  curveM: 'curve',
  apexM: 'apex height',
  strikeHMm: 'strike heel-to-toe',
  strikeVMm: 'strike low-to-high',
  wristExtTop: 'wrist extension at top',
  wristExtImpact: 'wrist extension at impact',
  wristExtPeakDown: 'peak wrist extension in transition',
};

const FAILURE_WORDS: Record<FailureMode, string> = {
  pull: 'pulls',
  push: 'pushes',
  'over-curve': 'over-curves',
  'under-curve': 'under-curves',
  'low-smash': 'low-smash strikes',
  short: 'short misses',
  long: 'long misses',
};

const CERTIFICATION_WORDS: Record<CertificationStatus, string> = {
  certified: 'certified',
  'contact-before-shapes': 'contact before shapes',
  uncertified: 'uncertified',
};

const certificationClass = (status: CertificationStatus): string =>
  status === 'certified' ? 'good' : status === 'uncertified' ? 'dim' : 'warn';

/**
 * One session, one club. Before a session the picker chooses the focus;
 * during one it shows only the focus, because every statistic keys on
 * (club, intent) and a session that wanders the bag leaves every bucket
 * short of the gates. Switching focus is deliberate: it ends the session
 * (which recaps that club's work) and opens a new one.
 */
function ClubPicker({
  snapshot,
  send,
}: {
  snapshot: HubSnapshot;
  send(command: HubCommand): void;
}): React.JSX.Element {
  const [switching, setSwitching] = useState(false);
  const focusClubId = snapshot.session?.focusClubId ?? null;
  const inSession = snapshot.session !== null && snapshot.session.endedAt === null;
  const locked = inSession && focusClubId !== null && !switching;

  const changeFocus = (clubId: string): void => {
    setSwitching(false);
    send({ cmd: 'endSession' });
    send({ cmd: 'startSession', intent: snapshot.activeIntent, focusClubId: clubId });
  };

  const shown = locked
    ? snapshot.clubs.filter((c) => c.id === focusClubId)
    : snapshot.clubs;

  return (
    <>
      <div className="row" style={{ marginTop: 10 }}>
        {!inSession && snapshot.activeClubId === null && (
          <span className="dim">Pick the club this session is about:</span>
        )}
        {locked && <span className="dim">Focus:</span>}
        {shown.map((club) => (
          <button
            key={club.id}
            className={club.id === snapshot.activeClubId ? 'active' : ''}
            onClick={() =>
              switching
                ? changeFocus(club.id)
                : send({ cmd: 'selectClub', clubId: club.id })
            }
          >
            {club.name}
          </button>
        ))}
        {locked && (
          <button onClick={() => setSwitching(true)}>Change focus…</button>
        )}
        {switching && (
          <button onClick={() => setSwitching(false)}>Cancel</button>
        )}
      </div>
      {switching && (
        <div className="dim" style={{ marginTop: 6 }}>
          Picking a club ends this session and starts a new one on it.
        </div>
      )}
    </>
  );
}

function Dot({ state }: { state: string }): React.JSX.Element {
  const color =
    state === 'connected'
      ? 'var(--green)'
      : state === 'connecting' || state === 'discovering' || state === 'scanning'
        ? 'var(--amber)'
        : 'var(--dim)';
  return <span className="dot" style={{ background: color }} />;
}

const fmt = (value: number | null, scale = 1, digits = 1): string =>
  value === null ? '—' : (value * scale).toFixed(digits);

const pct = (value: number | null): string =>
  value === null ? '—' : `${Math.round(value * 100)}%`;

/**
 * Counts, never scores: the engine's own numbers read back as "9 of 12", so a
 * finding stays falsifiable and nothing here looks like a grade.
 */
function FindingLine({ finding }: { finding: FindingWire }): React.JSX.Element {
  const { counts, sessions_seen: sessions } = finding;
  return (
    <li>
      <span className="who">
        {finding.club_name} · {finding.intent}
      </span>{' '}
      — {FAILURE_WORDS[finding.failure_mode]}: {METRIC_WORDS[finding.metric]} runs{' '}
      {finding.direction}{' '}
      <span className="dim">
        ({counts.bad_beyond_great_range} of {counts.bad} outside your great-shot range,{' '}
        {sessions} session{sessions === 1 ? '' : 's'})
      </span>
    </li>
  );
}

function Changepoint({ verdict }: { verdict: BucketStatusWire['changepoint'] }): React.JSX.Element {
  if (verdict === 'new-swing') {
    return <span className="warn">new swing — re-baseline</span>;
  }
  if (verdict === 'bad-day') return <span className="dim">rough session</span>;
  return <span className="dim">—</span>;
}

function Insights({ wire }: { wire: InsightsWire }): React.JSX.Element {
  // Most-supported first — the count of bad shots outside the great range is
  // the evidence, so it is also the ranking.
  const ranked = [...wire.findings].sort(
    (a, b) => b.counts.bad_beyond_great_range - a.counts.bad_beyond_great_range,
  );
  const shown = ranked.slice(0, MAX_FINDINGS);
  const hidden = ranked.length - shown.length;

  return (
    <div className="panel">
      <h2>Insights</h2>
      {wire.findings.length === 0 && wire.buckets.length === 0 && (
        <span className="dim">No trends yet — the engine needs a few sessions per club.</span>
      )}

      {shown.length > 0 && (
        <ul className="findings">
          {shown.map((finding) => (
            <FindingLine
              key={`${finding.club_id}:${finding.intent}:${finding.failure_mode}:${finding.metric}`}
              finding={finding}
            />
          ))}
          {hidden > 0 && <li className="dim">+{hidden} more</li>}
        </ul>
      )}

      {wire.buckets.length > 0 && (
        <table style={{ marginTop: shown.length > 0 ? 12 : 0 }}>
          <thead>
            <tr>
              <th>Club</th>
              <th>Intent</th>
              <th>Shots</th>
              <th>Great</th>
              <th>Certification</th>
              <th>Dispersion</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {wire.buckets.map((bucket) => (
              <tr key={`${bucket.club_id}:${bucket.intent}`}>
                <td>{bucket.club_name}</td>
                <td>{bucket.intent}</td>
                <td>{bucket.n_total}</td>
                <td>{pct(bucket.great_rate)}</td>
                <td className={certificationClass(bucket.certification)}>
                  {CERTIFICATION_WORDS[bucket.certification]}
                </td>
                <td>{fmt(bucket.dispersion_index, 1, 2)}</td>
                <td>
                  <Changepoint verdict={bucket.changepoint} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function App(): React.JSX.Element {
  const { snapshot, connected, send } = useHub();
  const insights = useInsights(snapshot);
  if (!snapshot) {
    return <div className="panel dim">Connecting to hub…</div>;
  }
  const s = snapshot;
  const inSession = s.session !== null && s.session.endedAt === null;

  return (
    <>
      <div className="panel row">
        <strong>Fairway Hub</strong>
        {!connected && <span style={{ color: 'var(--red)' }}>UI disconnected</span>}
        <span className="row" style={{ gap: 6 }}>
          <Dot state={s.connection} /> EYE MINI {s.connection}
          {s.device && <span className="dim">({s.device.ip})</span>}
        </span>
        <span className="row" style={{ gap: 6 }}>
          <Dot state={s.wristConnection} /> HackMotion {s.wristConnection}
          {s.wristBatteryPercent !== null && (
            <span className="dim">{s.wristBatteryPercent}%</span>
          )}
        </span>
        {s.ballReady && <span style={{ color: 'var(--green)' }}>● ball ready</span>}
      </div>

      {s.wristAlert && (
        <div className="panel row" style={{ borderColor: 'var(--red)' }}>
          <span style={{ color: 'var(--red)' }}>{s.wristAlert}</span>
          <button onClick={() => send({ cmd: 'dismissWristAlert' })}>Dismiss</button>
        </div>
      )}

      {s.wristConnection === 'disconnected' && s.wristCandidates.length > 0 && (
        <div className="panel row">
          <span className="dim">Wrist sensors:</span>
          {s.wristCandidates.map((d) => (
            <button key={d.id} onClick={() => send({ cmd: 'connectWrist', deviceId: d.id })}>
              {d.name ?? d.id}
            </button>
          ))}
        </div>
      )}

      <div className="panel">
        <h2>Session</h2>
        <div className="row">
          {inSession ? (
            <>
              <button className="primary" onClick={() => send({ cmd: 'endSession' })}>
                End session
              </button>
              <span className="dim">
                {s.shots.filter((x) => !x.discarded).length} shots
              </span>
            </>
          ) : (
            <button
              className="primary"
              disabled={s.activeClubId === null}
              onClick={() =>
                send({
                  cmd: 'startSession',
                  intent: s.activeIntent,
                  ...(s.activeClubId ? { focusClubId: s.activeClubId } : {}),
                })
              }
            >
              Start session
            </button>
          )}
          <span className="dim" style={{ marginLeft: 12 }}>
            Intent:
          </span>
          {INTENTS.map((intent) => (
            <button
              key={intent}
              className={intent === s.activeIntent ? 'active' : ''}
              onClick={() => send({ cmd: 'setActiveIntent', intent })}
            >
              {intent}
            </button>
          ))}
        </div>
        <ClubPicker snapshot={s} send={send} />
      </div>

      <div className="panel">
        <h2>Shots</h2>
        {s.shots.length === 0 ? (
          <span className="dim">No shots yet — hit one.</span>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Club</th>
                <th>Intent</th>
                <th>Ball mph</th>
                <th>Smash</th>
                <th>Carry yd</th>
                <th>Total yd</th>
                <th>Side yd</th>
                <th>Curve yd</th>
                <th>Wrist</th>
              </tr>
            </thead>
            <tbody>
              {s.shots.map((shot) => (
                <tr key={shot.id}>
                  <td className={shot.discarded ? 'discarded' : ''}>{shot.clubName}</td>
                  <td>
                    {shot.warmup ? <span className="dim">warmup</span> : shot.intent}
                  </td>
                  <td>{fmt(shot.ballSpeedMs, MS_TO_MPH)}</td>
                  <td>{shot.smashFactor?.toFixed(2) ?? '—'}</td>
                  <td>{fmt(shot.carryM, M_TO_YD, 0)}</td>
                  <td>{fmt(shot.totalM, M_TO_YD, 0)}</td>
                  <td>{fmt(shot.offlineM, M_TO_YD)}</td>
                  <td>{fmt(shot.curveM, M_TO_YD)}</td>
                  <td>{shot.hasWrist ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {insights && <Insights wire={insights} />}
    </>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
