import { Contact, ShotRecord } from '@golf/types';

import { mean, sampleSd } from './stats';

const collect = (
  shots: ShotRecord[],
  pick: (shot: ShotRecord) => number | null,
): number[] =>
  shots.flatMap((shot) => {
    const value = pick(shot);
    return value === null ? [] : [value];
  });

/**
 * Contact-quality summary: face-impact scatter (centroid + sample-sd spread,
 * horizontal = heel/toe mm, vertical = high/low mm) and smash-factor
 * consistency. Every field honors the null rule — when a quantity was never
 * measured across the given shots it is null, never 0. Spread is 0 (not null)
 * when measured exactly once: measured, but no spread claimable.
 */
export const computeContact = (shots: ShotRecord[]): Contact => {
  const h = collect(shots, (s) => s.measured.club.faceImpactHMm);
  const v = collect(shots, (s) => s.measured.club.faceImpactVMm);
  const smash = collect(shots, (s) => s.measured.smashFactor);

  return {
    faceCentroidHMm: h.length > 0 ? mean(h) : null,
    faceCentroidVMm: v.length > 0 ? mean(v) : null,
    faceSpreadHMm: h.length > 0 ? sampleSd(h) : null,
    faceSpreadVMm: v.length > 0 ? sampleSd(v) : null,
    smashMean: smash.length > 0 ? mean(smash) : null,
    smashSd: smash.length > 0 ? sampleSd(smash) : null,
  };
};
