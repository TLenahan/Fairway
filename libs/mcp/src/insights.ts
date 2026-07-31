import { BucketInsights, InsightMetricKey } from '@golf/insights';
import { ShotIntent, ShotIntentSchema } from '@golf/types';
import { z } from 'zod';

import { loadInsightsView } from './history';
import { defineTool } from './tool';

/** Shared bucket filter — every insight tool slices the same way. */
const bucketFilter = {
  club_id: z.string().optional().describe('omit for every club'),
  intent: ShotIntentSchema.optional().describe(
    'stock | draw | fade. Omit for every intent. Buckets are keyed on ' +
      '(club, intent), so a club has a separate baseline per shot shape.',
  ),
};

function matches(
  key: { clubId: string; intent: ShotIntent },
  args: { club_id?: string; intent?: ShotIntent },
): boolean {
  if (args.club_id !== undefined && key.clubId !== args.club_id) return false;
  if (args.intent !== undefined && key.intent !== args.intent) return false;
  return true;
}

export const getFindings = defineTool({
  name: 'get_findings',
  title: 'Get findings',
  description:
    'The engine\'s findings: repeatable, cross-session failure patterns in a ' +
    '(club, intent) bucket, each with the effect size separating bad shots ' +
    'from that golfer\'s own great ones. These are already guardrailed — a ' +
    'pattern that appeared in one session, or that is not statistically ' +
    'separated, is not reported at all — so treat what comes back as real ' +
    'and do not hedge it into nothing. Findings are the input to drills; ' +
    'check get_training_blocks before suggesting work for one.',
  inputSchema: bucketFilter,
  async run({ data }, args) {
    const view = await loadInsightsView(data);
    const findings = view.wire.findings.filter((f) =>
      matches({ clubId: f.club_id, intent: f.intent }, args),
    );
    return { findings, total: findings.length };
  },
});

export const getBucketStatus = defineTool({
  name: 'get_bucket_status',
  title: 'Get bucket status',
  description:
    'Per (club, intent) bucket: how many shots and great shots it holds, ' +
    'whether it is certified, its dispersion index and sigmas, whether a ' +
    'changepoint fired (new-swing vs bad-day), which metrics are systematic ' +
    'bias (aim/setup/fitting — never drills) versus variance drivers (the ' +
    'drill candidates), and what dominates carry variance. This is the ' +
    '"where does this club stand" tool. An uncertified bucket is not a ' +
    'failure — it means not enough evidence yet.',
  inputSchema: bucketFilter,
  async run({ data }, args) {
    const view = await loadInsightsView(data);
    const buckets = view.wire.buckets.filter((b) =>
      matches({ clubId: b.club_id, intent: b.intent }, args),
    );
    return { buckets, total: buckets.length };
  },
});

/**
 * The reference/dispersion numbers themselves, which the bucket wire
 * summarizes but does not carry: the per-metric medians and IQRs over the
 * golfer's own great shots, and the per-metric sigmas over the whole bucket.
 *
 * The asymmetry is the point, and it is §6.3's cardinal rule: the REFERENCE
 * baseline is computed over great shots only (that is what "your good" means)
 * while the DISPERSION baseline is computed over the unfiltered bucket
 * (filtering bad shots out of a dispersion statistic would make consistency
 * look better the more inconsistent it got). Both are labelled with the
 * sample they came from so a thin baseline reads as thin.
 */
function toBaselineWire(bucket: BucketInsights): Record<string, unknown> {
  const reference = bucket.reference;
  const dispersion = bucket.dispersion;

  const perMetric = (
    metrics: Partial<Record<InsightMetricKey, unknown>> | undefined,
  ): Record<string, unknown> => (metrics ? { ...metrics } : {});

  return {
    club_id: bucket.key.clubId,
    intent: bucket.key.intent,
    certification: bucket.certification.status,
    n_total: bucket.nTotal,
    n_great: bucket.certification.nGreat,
    great_rate: bucket.certification.greatRate,
    sigma_stable: bucket.certification.sigmaStable,
    // null when the bucket has too few great shots to define "your good" yet
    reference:
      reference === null
        ? null
        : {
            n_great: reference.nGreat,
            /** metric → { n, median, iqr } over great shots */
            per_metric: perMetric(reference.perMetric),
          },
    // null when the bucket is too thin for dispersion to mean anything
    dispersion:
      dispersion === null
        ? null
        : {
            n_total: dispersion.nTotal,
            carry_sigma_m: dispersion.carrySigma,
            offline_sigma_m: dispersion.offlineSigma,
            smash_sigma: dispersion.smashSigma,
            strike_scatter_mm: dispersion.strikeScatterMm,
            /** metric → sigma over the UNFILTERED bucket */
            per_metric_sigma: perMetric(dispersion.perMetric),
          },
  };
}

export const getBaseline = defineTool({
  name: 'get_baseline',
  title: 'Get baseline',
  description:
    'What "good" looks like for this golfer, in numbers: per-metric medians ' +
    'and IQRs over their own great shots (the reference baseline), and ' +
    'per-metric spread over every shot in the bucket (the dispersion ' +
    'baseline). Never compare these to tour or universal targets — the ' +
    'entire system judges a golfer against their own best, and the reference ' +
    'baseline IS that standard. Check `certification` and the sample counts ' +
    'before leaning on a number: a baseline off six great shots is a hint, ' +
    'not a benchmark.',
  inputSchema: bucketFilter,
  async run({ data }, args) {
    const view = await loadInsightsView(data);
    const baselines = view.report.buckets
      .filter((b) => matches(b.key, args))
      .map((bucket) => ({
        club_name: view.clubName(bucket.key.clubId),
        ...toBaselineWire(bucket),
      }));
    return { baselines, total: baselines.length };
  },
});
