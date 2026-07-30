/**
 * Replay a recorded wrist capture through the full coach-export pipeline and
 * print the wrist portion of the session JSON — exactly what the Reform
 * Coach agent would receive — plus the coverage object, for eyeballing.
 *
 *   node -r @swc-node/register tools/wrist-coach-export.ts \
 *     captures/<file>.ndjson [--calibration cal.json] [--handedness right]
 *
 * Calibration precedence: --calibration file, else the capture's own
 * `context` lines (recorded from this change onward), else none — in which
 * case every swing honestly lands in dropped_uncalibrated and zero blocks
 * export (the contract's omission-over-garbage invariant, on real data).
 */
import { readFileSync } from 'fs';

import { buildWristSessionExport, WristPairShot } from '@golf/analytics';
import {
  Handedness,
  WristCalibration,
  WristCalibrationSchema,
  WristCoachBlock,
  WristSwingRecord,
} from '@golf/types';
import {
  detectSwingsWithCoach,
  parseCapture,
  CoachCalibrationEvent,
} from '@golf/wrist';

const flags = new Map<string, string>();
const positional: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) {
    flags.set(args[i].slice(2), args[i + 1] ?? '');
    i += 1;
  } else {
    positional.push(args[i]);
  }
}
if (positional.length !== 1) {
  console.error(
    'usage: node -r @swc-node/register tools/wrist-coach-export.ts <capture.ndjson> [--calibration cal.json] [--handedness right|left]',
  );
  process.exit(1);
}

const capture = parseCapture(readFileSync(positional[0], 'utf8'));

// Calibration: an explicit --calibration file applies to the whole capture;
// otherwise replay the capture's own timestamped context calibrations, so a
// mid-capture recalibration switches frames exactly where the live session
// did instead of poisoning later swings with a stale frame.
const calibrationFile = flags.get('calibration') ?? null;
const fixedCalibration: WristCalibration | null = calibrationFile
  ? WristCalibrationSchema.parse(JSON.parse(readFileSync(calibrationFile, 'utf8')))
  : null;
const calibrationEvents: CoachCalibrationEvent[] = fixedCalibration
  ? []
  : capture.contexts
      .filter((c) => c.calibration !== null)
      .map((c) => ({ tMs: c.tMs, calibration: c.calibration }));
const calibrated = fixedCalibration !== null || calibrationEvents.length > 0;
const handedness = Handedness.parse(flags.get('handedness') ?? 'right');

const swings = detectSwingsWithCoach(
  capture.samples,
  { calibration: fixedCalibration },
  calibrationEvents,
);

const swingRecords: WristSwingRecord[] = swings.map((swing, i) => ({
  id: `swing-${i + 1}`,
  sessionId: 'capture',
  tImpactMs: swing.tImpactMs,
  coach: swing.coach ?? { status: 'dropped', reason: 'glitch' },
  createdAt: swing.tImpactMs,
}));

const shotLabels: (WristPairShot & { label: (typeof capture.shots)[number] })[] =
  capture.shots.map((label, i) => ({
    id: label.shotGuid ?? `shot-${i + 1}`,
    tMs: label.tMs,
    label,
  }));

const exported = buildWristSessionExport(swingRecords, shotLabels, handedness);

interface ShotJson {
  shot_guid: string | null;
  club_id: string | null;
  carry_m: number | null;
  ball_speed_ms: number | null;
  t_ms: number;
  wrist?: WristCoachBlock;
}

const shotsJson: ShotJson[] = shotLabels
  .sort((a, b) => a.tMs - b.tMs)
  .map((shot) => {
    const block = exported.blocks[shot.id];
    return {
      shot_guid: shot.label.shotGuid,
      club_id: shot.label.clubId,
      carry_m: shot.label.carryM,
      ball_speed_ms: shot.label.ballSpeedMs,
      t_ms: shot.tMs,
      ...(block ? { wrist: block } : {}),
    };
  });

const sessionJson: Record<string, unknown> = {
  capture: positional[0],
  started_at: capture.meta.startedAt ?? null,
  calibrated,
  handedness,
  shots: shotsJson,
  wrist_coverage: exported.coverage,
  ...(exported.strapDrift ? { wrist_strap_drift: true } : {}),
};

console.error(
  `[wrist-coach-export] ${capture.samples.length} samples, ${swings.length} wrist swings, ${capture.shots.length} MINI shot labels`,
);
console.log(JSON.stringify(sessionJson, null, 2));
