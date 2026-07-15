/**
 * Tiny dependency-free linear algebra for the calibration math. `analyze.py`
 * leaned on numpy's eigh/svd; here we roll a cyclic Jacobi eigensolver (exact
 * for the small 3×3 / 4×4 symmetric matrices we need) plus the handful of
 * matrix ops it takes to build a nearest-rotation frame.
 */
export type Matrix = number[][];

export function identity(n: number): Matrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
}

export function transpose(a: Matrix): Matrix {
  const rows = a.length;
  const cols = a[0].length;
  return Array.from({ length: cols }, (_, j) =>
    Array.from({ length: rows }, (_, i) => a[i][j]),
  );
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const m = b[0].length;
  const k = b.length;
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      let sum = 0;
      for (let p = 0; p < k; p += 1) sum += a[i][p] * b[p][j];
      out[i][j] = sum;
    }
  }
  return out;
}

export function det3(a: Matrix): number {
  return (
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  );
}

export interface EigenResult {
  /** eigenvalues, sorted descending */
  values: number[];
  /** eigenvectors as columns, aligned to `values` */
  vectors: Matrix;
}

/**
 * Eigen-decomposition of a real symmetric matrix via cyclic Jacobi rotations.
 * Returns eigenpairs sorted by descending eigenvalue. Exact to machine
 * precision for the tiny matrices used here.
 */
export function jacobiEigenSymmetric(input: Matrix): EigenResult {
  const n = input.length;
  let a = input.map((row) => row.slice());
  let v = identity(n);

  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) off += a[p][q] * a[p][q];
    }
    if (off < 1e-30) break;

    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-300) continue;
        const tau = (a[q][q] - a[p][p]) / (2 * apq);
        const t =
          tau === 0
            ? 1
            : Math.sign(tau) / (Math.abs(tau) + Math.sqrt(tau * tau + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const j = identity(n);
        j[p][p] = c;
        j[q][q] = c;
        j[p][q] = s;
        j[q][p] = -s;
        a = matMul(matMul(transpose(j), a), j);
        v = matMul(v, j);
      }
    }
  }

  const pairs = a
    .map((row, i) => ({ value: row[i], index: i }))
    .sort((x, y) => y.value - x.value);
  const values = pairs.map((p) => p.value);
  const vectors = pairs.map((p) => v.map((row) => row[p.index]));
  // vectors is currently row-per-eigenvector; transpose back to column form
  return { values, vectors: transpose(vectors) };
}

export function columnOf(m: Matrix, j: number): number[] {
  return m.map((row) => row[j]);
}
