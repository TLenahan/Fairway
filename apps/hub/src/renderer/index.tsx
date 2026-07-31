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
import type { TrainingBlockWire } from '@golf/program';
import { ShotIntent } from '@golf/types';

import {
  HubCommand,
  HubSnapshot,
  RecapsPayload,
  RecapWire,
  SnapshotMessage,
} from '../shared/protocol';

/**
 * What `GET /api/insights` returns: the engine wire plus the training blocks
 * the §6.10 prescription loop has issued against it.
 *
 * Declared structurally here rather than imported because the server-side
 * `HubInsightsPayload` lands in a sibling change; once it exists in
 * ../shared/protocol this local type should be deleted in favour of it. The
 * shape is the contract either way.
 */
interface HubInsightsPayload extends InsightsWire {
  blocks: TrainingBlockWire[];
}

const INTENTS: ShotIntent[] = ['stock', 'draw', 'fade'];

/** Session UI v1: connection status, session controls, club picker, shot log. */

const MS_TO_MPH = 2.23694;
const M_TO_YD = 1.09361;
const MAX_FINDINGS = 8;
const RECAP_POLL_MS = 5000;

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
function useInsights(snapshot: HubSnapshot | null): HubInsightsPayload | null {
  const [insights, setInsights] = useState<HubInsightsPayload | null>(null);
  const fetched = useRef(false);
  const live = snapshot?.session != null && snapshot.session.endedAt === null;

  useEffect(() => {
    if (live && fetched.current) return;
    fetched.current = true;
    let disposed = false;
    fetch('/api/insights')
      .then((response) => (response.ok ? response.json() : null))
      .then((wire: HubInsightsPayload | null) => {
        // `blocks` is defaulted at the boundary so a hub build that predates
        // the prescription endpoint still renders insights instead of
        // throwing on a field that isn't on the wire yet.
        if (!disposed && wire) setInsights({ ...wire, blocks: wire.blocks ?? [] });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [live]);

  return insights;
}

/**
 * Shared by the falling-edge fetch and the poll. A failed request resolves to
 * null rather than throwing, so one bad poll leaves the panel showing the
 * recap it already had instead of blanking it.
 */
async function fetchRecaps(): Promise<RecapsPayload | null> {
  try {
    const response = await fetch('/api/recaps');
    if (!response.ok) return null;
    const wire: RecapsPayload = await response.json();
    return wire;
  } catch {
    return null;
  }
}

/**
 * The coach writes a recap when a session closes, so this fetches on the same
 * falling edge `useInsights` uses. The difference is what happens next: a
 * coach run is a managed-agent session that takes minutes, so while the server
 * reports `running` this polls until it isn't — the recap arrives in the panel
 * on its own rather than on a manual refresh. The interval lives only for the
 * duration of that `running` window.
 */
function useRecaps(snapshot: HubSnapshot | null): RecapsPayload | null {
  const [recaps, setRecaps] = useState<RecapsPayload | null>(null);
  const fetched = useRef(false);
  const live = snapshot?.session != null && snapshot.session.endedAt === null;
  const running = recaps?.status === 'running';

  useEffect(() => {
    if (live && fetched.current) return;
    fetched.current = true;
    let disposed = false;
    void fetchRecaps().then((wire) => {
      if (!disposed && wire) setRecaps(wire);
    });
    return () => {
      disposed = true;
    };
  }, [live]);

  // Leaving `running` re-runs this effect, which is what stops the poll —
  // there is no other exit, so the interval can never outlive the run (or the
  // component).
  useEffect(() => {
    if (!running) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void fetchRecaps().then((wire) => {
        if (!disposed && wire) setRecaps(wire);
      });
    }, RECAP_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [running]);

  return recaps;
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

/**
 * Units for the metrics a tolerance band can sit on. The leading space is
 * part of the unit ("8.2 m/s" but "8.2°"), and an absent entry means the
 * metric reads fine bare — smash is a ratio, and nothing here should invent a
 * unit it isn't sure of.
 */
const UNITS: Partial<Record<InsightMetricKey, string>> = {
  ballSpeedMs: ' m/s',
  clubSpeedMs: ' m/s',
  launchDeg: '°',
  launchDirDeg: '°',
  backspinRpm: ' rpm',
  sidespinRpm: ' rpm',
  carryM: ' m',
  offlineM: ' m',
  curveM: ' m',
  apexM: ' m',
  strikeHMm: ' mm',
  strikeVMm: ' mm',
  wristExtTop: '°',
  wristExtImpact: '°',
  wristExtPeakDown: '°',
};

/**
 * A block's `failure_mode` / `target_metric` / `tolerance.metric` cross the
 * wire as plain strings — it is a serialized payload, not the engine's unions
 * — so they are looked up defensively rather than asserted back onto a union.
 * An unrecognised key degrades to null (caller falls back) instead of
 * rendering a raw engine id.
 */
function words(map: Record<string, string | undefined>, key: string | null): string | null {
  return key === null ? null : (map[key] ?? null);
}

const unitFor = (metric: string): string => words(UNITS, metric) ?? '';

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
      : state === 'connecting' ||
          state === 'discovering' ||
          state === 'scanning' ||
          state === 'running'
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

/**
 * What a block is training, in the same vocabulary the Insights panel uses —
 * e.g. "peak wrist extension in transition on low-smash strikes". Program
 * blocks carry no finding, so they fall back to the drill's own summary.
 */
function blockTargets(block: TrainingBlockWire): string {
  const metric = words(METRIC_WORDS, block.target_metric);
  const failure = words(FAILURE_WORDS, block.failure_mode);
  if (metric !== null && failure !== null) return `${metric} on ${failure}`;
  if (metric !== null) return metric;
  if (failure !== null) return failure;
  return block.drill_summary;
}

/**
 * "target 8.2° ± 3.1°". The band comes from the user's own great shots at
 * issue time (§6.10), so it is shown as-is — never re-derived here.
 */
function toleranceWords(tolerance: TrainingBlockWire['tolerance']): string | null {
  if (tolerance === null) return null;
  const unit = unitFor(tolerance.metric);
  return `target ${fmt(tolerance.center)}${unit} ± ${fmt(tolerance.half_width)}${unit}`;
}

/**
 * The window size, not a progress bar: nothing on the wire says how many
 * qualifying shots have landed in the bucket since issue, and the live
 * snapshot only holds the current session — counting from it would report a
 * number the loop is not actually judging. When the runner has already
 * written a note on an active block, that note is its own progress line and
 * is shown verbatim underneath.
 */
function ActiveBlock({
  block,
  bucket,
}: {
  block: TrainingBlockWire;
  bucket: string;
}): React.JSX.Element {
  const band = toleranceWords(block.tolerance);
  return (
    <li>
      <div className="row" style={{ gap: 8 }}>
        <span className="who">{block.drill_name}</span>
        <span className="dim">{bucket}</span>
        <span className="dim" style={{ marginLeft: 'auto' }}>
          re-measure after {block.remeasure_shots} shots
        </span>
      </div>
      <div>
        {blockTargets(block)}
        {band !== null && <span className="dim"> · {band}</span>}
      </div>
      {block.protocol !== '' && <div className="protocol dim">{block.protocol}</div>}
      {block.resolution_note !== null && (
        <div className="dim">{block.resolution_note}</div>
      )}
    </li>
  );
}

function ResolvedBlock({
  block,
  bucket,
}: {
  block: TrainingBlockWire;
  bucket: string;
}): React.JSX.Element {
  const graduated = block.status === 'graduated';
  return (
    <li className="resolved">
      <div className="row" style={{ gap: 8 }}>
        <span>{block.drill_name}</span>
        <span className="dim">{bucket}</span>
        <span className={graduated ? 'good' : 'warn'} style={{ marginLeft: 'auto' }}>
          {graduated ? 'graduated' : 'escalated'}
        </span>
      </div>
      {block.resolution_note !== null && (
        <div className="dim">{block.resolution_note}</div>
      )}
    </li>
  );
}

/**
 * The prescription loop made visible: what is being trained now, and what the
 * loop already judged. `abandoned` blocks are deliberately absent — a
 * superseded block is history, not training.
 */
function Training({
  blocks,
  clubs,
}: {
  blocks: TrainingBlockWire[];
  clubs: HubSnapshot['clubs'];
}): React.JSX.Element | null {
  // The wire carries club_id only; the snapshot is the one place club names
  // live, so the bucket is named from there rather than duplicated onto it.
  const clubName = new Map(clubs.map((club) => [club.id, club.name]));
  const bucketOf = (block: TrainingBlockWire): string =>
    block.club_id === null || block.intent === null
      ? 'program work'
      : `${clubName.get(block.club_id) ?? 'Unknown'} · ${block.intent}`;

  // Oldest first — the block nearest the end of its re-measure window is the
  // one with something to say next.
  const active = blocks
    .filter((block) => block.status === 'active')
    .sort((a, b) => a.started_at_ms - b.started_at_ms);
  // Most recently judged first; a block missing resolvedAt falls back to when
  // it was issued so the ordering never collapses.
  const resolved = blocks
    .filter((block) => block.status === 'graduated' || block.status === 'escalated')
    .sort(
      (a, b) =>
        (b.resolved_at_ms ?? b.started_at_ms) - (a.resolved_at_ms ?? a.started_at_ms),
    );

  if (active.length === 0 && resolved.length === 0) return null;

  return (
    <div className="panel">
      <h2>Training</h2>
      {active.length === 0 ? (
        <span className="dim">No active blocks — nothing prescribed right now.</span>
      ) : (
        <ul className="blocks">
          {active.map((block) => (
            <ActiveBlock key={block.id} block={block} bucket={bucketOf(block)} />
          ))}
        </ul>
      )}

      {resolved.length > 0 && (
        <>
          <h3>Resolved</h3>
          <ul className="blocks">
            {resolved.map((block) => (
              <ResolvedBlock key={block.id} block={block} bucket={bucketOf(block)} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

type RecapIssue = RecapWire['verdict']['issues'][number];

const SEVERITY_CLASS: Record<RecapIssue['severity'], string> = {
  high: 'bad',
  medium: 'warn',
  low: 'dim',
};

/**
 * The coach writes prose, not a blob: blank lines are paragraph breaks and are
 * rendered as such. Single newlines inside a paragraph are left in the text and
 * survive via `white-space: pre-line`, because the coach uses them for lists
 * and this has no business guessing which ones were meant to be structural.
 */
function paragraphs(narrative: string): string[] {
  return narrative
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '');
}

const recapDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

/**
 * One recap, verdict first. The headline leads because it is the coach's own
 * one-line answer; the prose is the argument for it. Empty verdict sections are
 * dropped rather than shown as bare headings — a recap with no drills should
 * read as a recap with no drills, not as a broken panel.
 */
function Recap({ recap, earlier }: { recap: RecapWire; earlier: number }): React.JSX.Element {
  const { verdict } = recap;
  return (
    <>
      <div className="recap-headline">{verdict.headline}</div>

      <div className="recap-prose">
        {paragraphs(recap.narrative).map((block, index) => (
          <p key={index}>{block}</p>
        ))}
      </div>

      {verdict.issues.length > 0 && (
        <>
          <h3>Issues</h3>
          <ul className="recap">
            {verdict.issues.map((issue, index) => (
              <li key={index}>
                <div className="row" style={{ gap: 8 }}>
                  <span className={`severity ${SEVERITY_CLASS[issue.severity]}`}>
                    {issue.severity}
                  </span>
                  <span className="who">{issue.area}</span>
                </div>
                <div>{issue.why}</div>
                <div className="dim">{issue.evidence}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      {verdict.strengths.length > 0 && (
        <>
          <h3>Strengths</h3>
          <ul className="recap">
            {verdict.strengths.map((strength, index) => (
              <li key={index}>
                <span className="good">{strength.area}</span>
                <div className="dim">{strength.evidence}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      {verdict.drills.length > 0 && (
        <>
          <h3>Drills</h3>
          <ul className="recap">
            {verdict.drills.map((drill, index) => (
              <li key={index}>
                <span className="who">
                  {recap.drill_names[drill.name] ?? drill.name}
                </span>{' '}
                — {drill.goal}
              </li>
            ))}
          </ul>
        </>
      )}

      {verdict.caveats.length > 0 && (
        <>
          <h3>Caveats</h3>
          <ul className="recap">
            {verdict.caveats.map((caveat, index) => (
              <li key={index} className="dim">
                {caveat}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="recap-footer dim">
        <div>
          Session {recapDate(recap.session_started_at_ms)} · written by {recap.model}
        </div>
        {earlier > 0 && (
          <div>
            +{earlier} earlier recap{earlier === 1 ? '' : 's'}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The day's payoff, so it sits directly under Session rather than below the
 * tables. Only the latest recap is shown — earlier ones are a count, not a
 * browser; the point of the panel is "what did the coach say about today".
 */
function Coach({ payload }: { payload: RecapsPayload }): React.JSX.Element {
  // Newest first regardless of how the endpoint happened to order them, so
  // "latest" is decided here rather than assumed off the wire.
  const ordered = [...payload.recaps].sort((a, b) => b.created_at_ms - a.created_at_ms);
  const latest = ordered[0];

  return (
    <div className="panel">
      <h2>Coach</h2>
      {payload.status === 'running' ? (
        <span className="row" style={{ gap: 6 }}>
          <Dot state="running" /> Writing today&rsquo;s recap…
        </span>
      ) : payload.status === 'error' ? (
        <div className="bad">
          The recap failed to generate — your session and shots are saved, only the
          write-up is missing.
          {payload.error !== null && <div className="dim">{payload.error}</div>}
        </div>
      ) : latest === undefined ? (
        <span className="dim">
          No recap yet — end a session with an API key configured.
        </span>
      ) : (
        <Recap recap={latest} earlier={ordered.length - 1} />
      )}
    </div>
  );
}

function App(): React.JSX.Element {
  const { snapshot, connected, send } = useHub();
  const insights = useInsights(snapshot);
  const recaps = useRecaps(snapshot);
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

      {recaps && <Coach payload={recaps} />}

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
      {insights && insights.blocks.length > 0 && (
        <Training blocks={insights.blocks} clubs={s.clubs} />
      )}
    </>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
