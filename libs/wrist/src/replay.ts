import {
  WristCalibration,
  WristCalibrationSchema,
  WristHold,
  WristPhaseEvent,
  WristShot,
} from '@golf/types';
import { Buffer } from 'buffer';

import { parseFrame, shockOf } from './record-codec';
import { Quat } from './quaternion';
import {
  detectSwings,
  SwingDetectorOptions,
  SwingSample,
} from './swing-detector';

/**
 * Offline capture replay — the bridge between a recorded range session and the
 * live detector. A capture (see apps/fairway wrist-capture.ts, NDJSON v2)
 * carries raw BLE frames plus EYE MINI `shot` labels on one host clock, so this
 * can score the detector against ground truth without a device: every wrist
 * swing that time-aligns to a `shot` struck a ball; the rest are practice.
 *
 * Deliberately dependency-free (manual JSON line parsing, no fs) so it runs in
 * a jest spec, a Node one-off, or a future in-app "re-analyze" screen alike.
 */
export interface CaptureShotLabel {
  tMs: number;
  shotGuid: string | null;
  clubId: string | null;
  carryM: number | null;
  ballSpeedMs: number | null;
}

export interface CaptureContext {
  tMs: number;
  calibrated: boolean;
  /** full anatomical calibration, when the capture recorded it (older
      captures carry only the boolean and cannot replay calibrated angles) */
  calibration: WristCalibration | null;
  club: {
    id: string;
    name: string;
    category: string;
    loftDeg: number | null;
  } | null;
}

export interface ParsedCapture {
  meta: Record<string, unknown>;
  samples: SwingSample[];
  shots: CaptureShotLabel[];
  contexts: CaptureContext[];
}

/** Parse NDJSON capture text into detector samples + ground-truth labels. */
export function parseCapture(text: string): ParsedCapture {
  const meta: Record<string, unknown> = {};
  const samples: SwingSample[] = [];
  const shots: CaptureShotLabel[] = [];
  const contexts: CaptureContext[] = [];

  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const obj = JSON.parse(line) as Record<string, unknown>;
    switch (obj.type) {
      case 'meta':
        Object.assign(meta, obj);
        break;
      case 'frame': {
        const bytes = base64ToBytes(obj.d as string);
        const tMs = obj.t as number;
        for (const rec of parseFrame(bytes)) {
          samples.push({
            tMs,
            tsa: rec.tsA,
            qA: rec.qA as Quat,
            qB: rec.qB as Quat,
            shock: shockOf(rec),
          });
        }
        break;
      }
      case 'shot':
        shots.push({
          tMs: obj.t as number,
          shotGuid: (obj.shotGuid as string) ?? null,
          clubId: (obj.clubId as string) ?? null,
          carryM: (obj.carryM as number) ?? null,
          ballSpeedMs: (obj.ballSpeedMs as number) ?? null,
        });
        break;
      case 'context': {
        const calibration = WristCalibrationSchema.safeParse(obj.calibration);
        contexts.push({
          tMs: obj.t as number,
          calibrated: Boolean(obj.calibrated),
          calibration: calibration.success ? calibration.data : null,
          club: (obj.club as CaptureContext['club']) ?? null,
        });
        break;
      }
      default:
        break;
    }
  }
  return { meta, samples, shots, contexts };
}

export interface ScoredSwing {
  swing: WristShot;
  /** the nearest MINI shot within the join window, else null (practice) */
  matchedShot: CaptureShotLabel | null;
}

export interface ReplayResult {
  meta: Record<string, unknown>;
  sampleCount: number;
  swings: ScoredSwing[];
  holds: WristHold[];
  phases: WristPhaseEvent[];
  shots: CaptureShotLabel[];
  /** MINI shots with no detected swing near them — the false NEGATIVES */
  unmatchedShots: CaptureShotLabel[];
}

/**
 * Run a parsed capture through the detector and score swings against the MINI
 * labels. `joinWindowMs` mirrors the store's wrist↔shot correlation window.
 */
export function replayCapture(
  capture: ParsedCapture,
  options?: SwingDetectorOptions,
  joinWindowMs = 1500,
): ReplayResult {
  const holds: WristHold[] = [];
  const phases: WristPhaseEvent[] = [];
  const swings = detectSwings(capture.samples, options, { holds, phases });

  const usedShots = new Set<CaptureShotLabel>();
  const scored: ScoredSwing[] = swings.map((swing) => {
    let best: CaptureShotLabel | null = null;
    let bestDelta = joinWindowMs;
    for (const shot of capture.shots) {
      if (usedShots.has(shot)) continue;
      const delta = Math.abs(shot.tMs - swing.tImpactMs);
      if (delta <= bestDelta) {
        bestDelta = delta;
        best = shot;
      }
    }
    if (best) usedShots.add(best);
    return { swing, matchedShot: best };
  });

  const unmatchedShots = capture.shots.filter((s) => !usedShots.has(s));
  return {
    meta: capture.meta,
    sampleCount: capture.samples.length,
    swings: scored,
    holds,
    phases,
    shots: capture.shots,
    unmatchedShots,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  // `buffer` is polyfilled in RN and native in Node — same decode both places.
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
