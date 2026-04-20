export interface ClusterOptions {
  maxIterations?: number;
  seed?: number;
  k?: number;
}

export interface ClusterResult {
  centroids: Float32Array[];
  assignments: number[];
  k: number;
  iterations: number;
}

const MIN_K = 5;
const MAX_K = 50;
const DEFAULT_MAX_ITER = 20;
const DEFAULT_SEED = 0x9e3779b9;

export function chooseK(n: number): number {
  if (n <= 0) return 0;
  const raw = Math.floor(Math.sqrt(n / 2));
  if (raw < MIN_K) return Math.min(MIN_K, n);
  if (raw > MAX_K) return MAX_K;
  return raw;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function l2norm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

function squaredDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return sum;
}

function pickInitialCentroids(
  vectors: Float32Array[],
  k: number,
  rand: () => number,
): Float32Array[] {
  // k-means++ seeding: first centroid uniform, each next weighted by squared
  // distance to the nearest already-chosen centroid. Deterministic under `rand`.
  const centroids: Float32Array[] = [];
  const firstIdx = Math.floor(rand() * vectors.length);
  const first = vectors[firstIdx];
  if (!first) throw new Error("pickInitialCentroids: empty vectors");
  centroids.push(new Float32Array(first));

  const dist = new Float64Array(vectors.length);
  for (let i = 0; i < vectors.length; i++) {
    dist[i] = squaredDistance(vectors[i] as Float32Array, first);
  }

  while (centroids.length < k) {
    let total = 0;
    for (let i = 0; i < dist.length; i++) total += dist[i] ?? 0;
    if (total === 0) {
      // All remaining points are identical to some centroid. Pick deterministically
      // to keep k centroids distinct by index order.
      const used = new Set<number>();
      for (let i = 0; i < vectors.length; i++) {
        if (centroids.length >= k) break;
        if (!used.has(i)) {
          centroids.push(new Float32Array(vectors[i] as Float32Array));
          used.add(i);
        }
      }
      break;
    }
    const target = rand() * total;
    let acc = 0;
    let chosen = dist.length - 1;
    for (let i = 0; i < dist.length; i++) {
      acc += dist[i] ?? 0;
      if (acc >= target) {
        chosen = i;
        break;
      }
    }
    const next = vectors[chosen];
    if (!next) throw new Error("pickInitialCentroids: chosen index out of range");
    centroids.push(new Float32Array(next));

    for (let i = 0; i < vectors.length; i++) {
      const d = squaredDistance(vectors[i] as Float32Array, next);
      if (d < (dist[i] ?? Infinity)) dist[i] = d;
    }
  }
  return centroids;
}

function assign(vectors: Float32Array[], centroids: Float32Array[]): number[] {
  const assignments = new Array<number>(vectors.length);
  for (let i = 0; i < vectors.length; i++) {
    let best = 0;
    let bestDist = Infinity;
    const v = vectors[i] as Float32Array;
    for (let c = 0; c < centroids.length; c++) {
      const d = squaredDistance(v, centroids[c] as Float32Array);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    assignments[i] = best;
  }
  return assignments;
}

function recomputeCentroids(
  vectors: Float32Array[],
  assignments: number[],
  k: number,
  dim: number,
): { centroids: Float32Array[]; empty: number[] } {
  const sums: Float32Array[] = [];
  const counts = new Int32Array(k);
  for (let i = 0; i < k; i++) sums.push(new Float32Array(dim));

  for (let i = 0; i < vectors.length; i++) {
    const cluster = assignments[i] ?? 0;
    const v = vectors[i] as Float32Array;
    const target = sums[cluster] as Float32Array;
    for (let d = 0; d < dim; d++) {
      target[d] = (target[d] ?? 0) + (v[d] ?? 0);
    }
    counts[cluster] = (counts[cluster] ?? 0) + 1;
  }

  const centroids: Float32Array[] = [];
  const empty: number[] = [];
  for (let c = 0; c < k; c++) {
    const count = counts[c] ?? 0;
    const out = new Float32Array(dim);
    if (count === 0) {
      empty.push(c);
    } else {
      const s = sums[c] as Float32Array;
      for (let d = 0; d < dim; d++) {
        out[d] = (s[d] ?? 0) / count;
      }
    }
    centroids.push(out);
  }
  return { centroids, empty };
}

function centroidsChanged(a: Float32Array[], b: Float32Array[], tol: number): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as Float32Array;
    const bi = b[i] as Float32Array;
    for (let d = 0; d < ai.length; d++) {
      if (Math.abs((ai[d] ?? 0) - (bi[d] ?? 0)) > tol) return true;
    }
  }
  return false;
}

export function clusterEmbeddings(
  vectors: Float32Array[],
  options: ClusterOptions = {},
): ClusterResult {
  const n = vectors.length;
  if (n === 0) {
    return { centroids: [], assignments: [], k: 0, iterations: 0 };
  }
  const first = vectors[0];
  if (!first) throw new Error("clusterEmbeddings: empty vector slot");
  const dim = first.length;
  const k = Math.max(1, Math.min(options.k ?? chooseK(n), n));
  const maxIter = options.maxIterations ?? DEFAULT_MAX_ITER;
  const rand = mulberry32(options.seed ?? DEFAULT_SEED);

  let centroids = pickInitialCentroids(vectors, k, rand);
  let assignments: number[] = assign(vectors, centroids);

  let iterations = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    const { centroids: next, empty } = recomputeCentroids(vectors, assignments, k, dim);
    // Re-seed empty clusters with the farthest-from-its-centroid point to keep k stable.
    for (const idx of empty) {
      let farPoint = 0;
      let farDist = -1;
      for (let i = 0; i < vectors.length; i++) {
        const cluster = assignments[i] ?? 0;
        const d = squaredDistance(vectors[i] as Float32Array, centroids[cluster] as Float32Array);
        if (d > farDist) {
          farDist = d;
          farPoint = i;
        }
      }
      next[idx] = new Float32Array(vectors[farPoint] as Float32Array);
    }
    const changed = centroidsChanged(centroids, next, 1e-6);
    centroids = next;
    assignments = assign(vectors, centroids);
    if (!changed) break;
  }

  return { centroids, assignments, k, iterations };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  const denom = l2norm(a) * l2norm(b);
  if (denom === 0) return 0;
  return dot / denom;
}

export const __cluster_internals__ = {
  mulberry32,
  squaredDistance,
  pickInitialCentroids,
  MIN_K,
  MAX_K,
};
