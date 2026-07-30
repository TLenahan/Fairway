import { InsightMetricKey, InsightShot } from './types';

/** Pure statistics primitives — deterministic, order-insensitive. */

export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

export const iqr = (xs: readonly number[]): number =>
  quantile(xs, 0.75) - quantile(xs, 0.25);

export const mean = (xs: readonly number[]): number =>
  xs.reduce((a, b) => a + b, 0) / xs.length;

export const sampleSd = (xs: readonly number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(
    xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1),
  );
};

/** Pooled-σ Cohen's d (b relative to a: positive = b higher). */
export const cohensD = (a: readonly number[], b: readonly number[]): number => {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return 0;
  const pooled = Math.sqrt(
    ((na - 1) * sampleSd(a) ** 2 + (nb - 1) * sampleSd(b) ** 2) /
      (na + nb - 2),
  );
  if (pooled === 0) return 0;
  return (mean(b) - mean(a)) / pooled;
};

/** Mann-Whitney U with normal approximation (ties handled by midranks).
    Returns the two-sided p approximation. */
export const rankSumP = (a: readonly number[], b: readonly number[]): number => {
  const na = a.length;
  const nb = b.length;
  if (na === 0 || nb === 0) return 1;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))];
  all.sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j += 1;
    const rank = (i + j + 2) / 2; // midrank, 1-based
    for (let k = i; k <= j; k += 1) ranks[k] = rank;
    i = j + 1;
  }
  let ra = 0;
  for (let k = 0; k < all.length; k += 1) if (all[k].g === 0) ra += ranks[k];
  const u = ra - (na * (na + 1)) / 2;
  const mu = (na * nb) / 2;
  const sigma = Math.sqrt((na * nb * (na + nb + 1)) / 12);
  if (sigma === 0) return 1;
  const zAbs = Math.abs((u - mu) / sigma);
  return 2 * (1 - normalCdf(zAbs));
};

export const normalCdf = (z: number): number => {
  // Abramowitz–Stegun 7.1.26 erf approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
};

/** EWMA weights by session recency: weight(sessionAge) = 0.5^(age/halfLife).
    `sessionOrder` maps sessionId → 0-based age (0 = most recent). */
export const ewmaWeight = (
  sessionAge: number,
  halfLifeSessions: number,
): number => 0.5 ** (sessionAge / halfLifeSessions);

export const weightedMean = (
  xs: readonly number[],
  ws: readonly number[],
): number => {
  let sw = 0;
  let sx = 0;
  for (let k = 0; k < xs.length; k += 1) {
    sw += ws[k];
    sx += xs[k] * ws[k];
  }
  return sw === 0 ? 0 : sx / sw;
};

/** One-sided-pair CUSUM on a standardized stream. Returns the 1-based index
    of the first alarm, or null. */
export const cusumAlarm = (
  values: readonly number[],
  mu: number,
  sigma: number,
  thresholdSigma: number,
  driftSigma: number,
): number | null => {
  if (sigma <= 0) return null;
  let hi = 0;
  let lo = 0;
  for (let k = 0; k < values.length; k += 1) {
    const z = (values[k] - mu) / sigma;
    hi = Math.max(0, hi + z - driftSigma);
    lo = Math.max(0, lo - z - driftSigma);
    if (hi > thresholdSigma || lo > thresholdSigma) return k + 1;
  }
  return null;
};

/** Pearson correlation; 0 when degenerate. */
export const pearson = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length || a.length < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let k = 0; k < a.length; k += 1) {
    num += (a[k] - ma) * (b[k] - mb);
    da += (a[k] - ma) ** 2;
    db += (b[k] - mb) ** 2;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
};

/**
 * Standardized OLS via normal equations + Gaussian elimination.
 * Returns standardized coefficients and R² (null when singular/degenerate).
 */
export const standardizedOls = (
  y: readonly number[],
  xs: readonly (readonly number[])[],
): { beta: number[]; r2: number } | null => {
  const n = y.length;
  const p = xs.length;
  if (p === 0 || n < p + 2) return null;
  const zy = standardize(y);
  const zxs = xs.map(standardize);
  if (zy === null || zxs.some((c) => c === null)) return null;
  const Z = zxs as number[][];
  // X'X and X'y over standardized columns
  const a: number[][] = Array.from({ length: p }, (_, r) =>
    Array.from({ length: p + 1 }, (_, c) =>
      c < p ? dot(Z[r], Z[c]) : dot(Z[r], zy),
    ),
  );
  // Gaussian elimination with partial pivoting
  for (let col = 0; col < p; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < p; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < p; r += 1) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= p; c += 1) a[r][c] -= f * a[col][c];
    }
  }
  const beta = a.map((row, r) => row[p] / row[r]);
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < n; k += 1) {
    let pred = 0;
    for (let j = 0; j < p; j += 1) pred += beta[j] * Z[j][k];
    ssRes += (zy[k] - pred) ** 2;
    ssTot += zy[k] ** 2;
  }
  return { beta, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
};

const dot = (a: readonly number[], b: readonly number[]): number => {
  let s = 0;
  for (let k = 0; k < a.length; k += 1) s += a[k] * b[k];
  return s;
};

const standardize = (xs: readonly number[]): number[] | null => {
  const sd = sampleSd(xs);
  if (sd === 0) return null;
  const m = mean(xs);
  return xs.map((x) => (x - m) / sd);
};

/** Metric accessor map — the single place a metric key meets a shot field. */
export const metricValue = (
  shot: InsightShot,
  key: InsightMetricKey,
): number | null => shot[key];

/** Non-null metric values across shots. */
export const metricSeries = (
  shots: readonly InsightShot[],
  key: InsightMetricKey,
): number[] => {
  const out: number[] = [];
  for (const s of shots) {
    const v = metricValue(s, key);
    if (v !== null) out.push(v);
  }
  return out;
};
