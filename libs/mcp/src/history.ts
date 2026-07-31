import { loadShotHistory } from '@golf/data';
import {
  InsightShot,
  InsightsReport,
  InsightsWire,
  analyzeShots,
  serializeReport,
  toInsightShots,
} from '@golf/insights';
import { Club, DataStore, ShotIntent, ShotRecord } from '@golf/types';

/**
 * The all-time history with the engine already run over it — what every
 * insight-shaped tool in this lib reads.
 *
 * Deliberately NOT cached. The hub writes shots to this database while the
 * MCP process reads it, so a cached report would go stale the moment a
 * session ended and there is no cheap signal here that it had. Recomputing is
 * O(shots) over a local file; being wrong about a golfer's baseline costs
 * more than the milliseconds do. If this ever needs a cache, the key is
 * (shot count, newest capturedAt) — not a timer.
 */
export interface InsightsView {
  shots: ShotRecord[];
  clubs: Club[];
  /** engine projection of `shots`, minus any whose club no longer exists */
  insightShots: InsightShot[];
  report: InsightsReport;
  /**
   * The report in its canonical serialized form — the same bytes the hub UI
   * and the coach payload read. Tools project from this wherever it carries
   * the field they need, and drop to `report` only for the numbers the wire
   * deliberately omits (per-metric baseline medians and sigmas).
   */
  wire: InsightsWire;
  clubName(clubId: string): string;
}

export async function loadInsightsView(data: DataStore): Promise<InsightsView> {
  const { shots, clubs } = await loadShotHistory(data);
  const insightShots = toInsightShots(shots, clubs);
  const report = analyzeShots(insightShots);
  const names = new Map(clubs.map((c) => [c.id, c.name]));
  return {
    shots,
    clubs,
    insightShots,
    report,
    wire: serializeReport(report, clubs),
    clubName: (clubId) => names.get(clubId) ?? 'Unknown',
  };
}

/**
 * `untagged` is the quarantine bucket (§6.1) — the engine skips it, so no
 * baseline, finding, or certification will ever mention it. A tool asked to
 * filter on it would return an empty result that reads like "you have no
 * problems with that club" rather than "that is not a bucket".
 */
export const BUCKET_INTENTS = ['stock', 'draw', 'fade'] as const;

export function isBucketIntent(intent: ShotIntent): boolean {
  return (BUCKET_INTENTS as readonly string[]).includes(intent);
}
