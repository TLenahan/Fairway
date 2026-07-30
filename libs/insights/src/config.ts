import { ShotIntent } from '@golf/types';

import { InsightShot } from './types';

/**
 * Every threshold in the engine lives here, not in code (BUILD_SPEC §6 /
 * §9.4). Defaults are the spec's numbers where it gives them and tunable
 * placeholders where it doesn't.
 */

export interface IntentCorridor {
  /** start-line window (deg, target = 0; sign mirrored for left-handers) */
  startLineDeg: [number, number];
  /** required curve direction; 'either' = magnitude-only judgment */
  curveDirection: 'left' | 'right' | 'either';
}

export interface InsightsConfig {
  greatShot: {
    /** absolute smash ceilings per club category; pass = smash >= ceiling × factor */
    smashCeiling: Record<InsightShot['clubCategory'], number>;
    smashFactor: number;
    /** strike radius from face center when strike location is available (mm) */
    strikeRadiusMm: number;
    /** carry within ± this fraction of the (club,intent) rolling median */
    carryWindowPct: number;
    /** low-smash disambiguation: |strike| beyond this = contact problem */
    strikeContactMm: number;
    /** intent corridors, right-handed convention (mirror for lefty) */
    corridors: Record<Exclude<ShotIntent, 'untagged'>, IntentCorridor>;
  };
  certification: {
    minGreat: number;
    minTotal: number;
    /** rolling carry-σ change over the stability window must stay under this */
    sigmaStabilityPct: number;
    sigmaStabilityWindow: number;
    /** past this many session swings, verdict leans contact-before-shapes */
    sessionCap: number;
  };
  findings: {
    minEffectSize: number;
    minSessions: number;
    minBadBucket: number;
    minGreatBucket: number;
    /** normal-approximation rank-sum p must be under this */
    maxPApprox: number;
  };
  ewma: { halfLifeSessions: number };
  changepoint: {
    /** CUSUM threshold in σ units on the stock-bucket carry stream */
    cusumThresholdSigma: number;
    cusumDriftSigma: number;
    /** dispersion spike = rolling σ beyond this multiple of baseline σ */
    dispersionSpikeFactor: number;
    minShots: number;
  };
  failureModes: {
    /** beyond corridor edge by this margin (deg) = pull/push */
    startLineMarginDeg: number;
    /** curve magnitude beyond/below intent expectation (m) */
    overCurveM: number;
    underCurveM: number;
    /** low-smash = below ceiling × this */
    lowSmashFactor: number;
    /** carry beyond ± this fraction of bucket median = short/long */
    carryFraction: number;
  };
  dispersionIndex: {
    minShots: number;
    weights: { carry: number; offline: number; smash: number; strike: number };
  };
  biasVariance: {
    /** |mean offset| ≥ this many σ with σ under tightSigma → bias */
    biasOffsetSigma: number;
    /** |r| vs outcome dispersion ≥ this → variance driver */
    minOutcomeCorrelation: number;
    minShots: number;
  };
  carryDecomposition: { minShots: number };
}

export const DEFAULT_INSIGHTS_CONFIG: InsightsConfig = {
  greatShot: {
    smashCeiling: {
      driver: 1.5,
      wood: 1.48,
      hybrid: 1.44,
      iron: 1.38,
      wedge: 1.25,
      putter: 1.0,
    },
    smashFactor: 0.96,
    strikeRadiusMm: 12,
    carryWindowPct: 0.07,
    strikeContactMm: 15,
    corridors: {
      stock: { startLineDeg: [-3, 3], curveDirection: 'either' },
      draw: { startLineDeg: [0.5, 6], curveDirection: 'left' },
      fade: { startLineDeg: [-6, -0.5], curveDirection: 'right' },
    },
  },
  certification: {
    minGreat: 20,
    minTotal: 30,
    sigmaStabilityPct: 10,
    sigmaStabilityWindow: 10,
    sessionCap: 80,
  },
  findings: {
    minEffectSize: 0.5,
    minSessions: 2,
    minBadBucket: 8,
    minGreatBucket: 8,
    maxPApprox: 0.05,
  },
  ewma: { halfLifeSessions: 5 },
  changepoint: {
    cusumThresholdSigma: 4,
    cusumDriftSigma: 0.5,
    dispersionSpikeFactor: 1.5,
    minShots: 20,
  },
  failureModes: {
    startLineMarginDeg: 1,
    overCurveM: 12,
    underCurveM: 2,
    lowSmashFactor: 0.9,
    carryFraction: 0.08,
  },
  dispersionIndex: {
    minShots: 10,
    weights: { carry: 0.35, offline: 0.3, smash: 0.2, strike: 0.15 },
  },
  biasVariance: {
    biasOffsetSigma: 1,
    minOutcomeCorrelation: 0.4,
    minShots: 15,
  },
  carryDecomposition: { minShots: 15 },
};
