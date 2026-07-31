import { ShotIntent, TrainingBlock, TrainingBlockStatus } from '@golf/types';

import { Drill } from './drill-content';

/**
 * Serializable view of a training block — what the coach payload and the hub
 * UI both read. Carries the drill's human-readable name and protocol
 * alongside the block so neither consumer has to re-resolve the library
 * (and so a recap can quote the protocol the block was issued against, not
 * whatever the library says today).
 */
export interface TrainingBlockWire {
  id: string;
  source: TrainingBlock['source'];
  status: TrainingBlockStatus;
  drill_id: string;
  drill_name: string;
  drill_summary: string;
  protocol: string;
  club_id: string | null;
  intent: ShotIntent | null;
  /** the failure mode this block was prescribed against; null for program work */
  failure_mode: string | null;
  target_metric: string | null;
  /** band derived from the user's own great shots at issue time */
  tolerance: { metric: string; center: number; half_width: number } | null;
  remeasure_shots: number;
  started_at_ms: number;
  resolved_at_ms: number | null;
  resolution_note: string | null;
}

export function toBlockWire(
  block: TrainingBlock,
  drill: Drill | null,
  parsed: { failureMode: string; metric: string } | null,
): TrainingBlockWire {
  return {
    id: block.id,
    source: block.source,
    status: block.status,
    drill_id: block.drillId,
    drill_name: drill?.name ?? block.drillId,
    drill_summary: drill?.summary ?? '',
    protocol: drill?.protocol ?? '',
    club_id: block.clubId,
    intent: block.intent,
    failure_mode: parsed?.failureMode ?? null,
    target_metric: parsed?.metric ?? null,
    tolerance:
      block.tolerance === null
        ? null
        : {
            metric: block.tolerance.metric,
            center: Math.round(block.tolerance.center * 100) / 100,
            half_width: Math.round(block.tolerance.halfWidth * 100) / 100,
          },
    remeasure_shots: block.remeasureShots,
    started_at_ms: block.startedAt,
    resolved_at_ms: block.resolvedAt,
    resolution_note: block.resolutionNote,
  };
}
