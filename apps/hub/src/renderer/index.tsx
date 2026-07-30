import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { HubCommand, HubSnapshot, SnapshotMessage } from '../shared/protocol';

/** Session UI v1: connection status, session controls, club picker, shot log. */

const MS_TO_MPH = 2.23694;
const M_TO_YD = 1.09361;

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

function App(): React.JSX.Element {
  const { snapshot, connected, send } = useHub();
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
            <button className="primary" onClick={() => send({ cmd: 'startSession' })}>
              Start session
            </button>
          )}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {s.clubs.map((club) => (
            <button
              key={club.id}
              className={club.id === s.activeClubId ? 'active' : ''}
              onClick={() => send({ cmd: 'selectClub', clubId: club.id })}
            >
              {club.name}
            </button>
          ))}
        </div>
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
    </>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
