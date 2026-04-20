import { describe, expect, test } from "bun:test";
import { chooseK, clusterEmbeddings, cosineSimilarity } from "./cluster";

const DIM = 384;

function project2DTo384(x: number, y: number, noise: number, seed: number): Float32Array {
  // Embed a 2D point into 384-d by placing (x, y) in the first two dims
  // and filling the rest with deterministic low-amplitude noise.
  const out = new Float32Array(DIM);
  out[0] = x;
  out[1] = y;
  let s = (seed >>> 0) + 1;
  for (let i = 2; i < DIM; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const n = (s / 4294967296 - 0.5) * noise;
    out[i] = n;
  }
  return out;
}

function syntheticBlobs(): Float32Array[] {
  // Three well-separated 2D blobs lifted into 384-d.
  const vectors: Float32Array[] = [];
  const centers: [number, number][] = [
    [10, 10],
    [-10, 10],
    [0, -10],
  ];
  let seed = 1;
  for (let c = 0; c < centers.length; c++) {
    const [cx, cy] = centers[c] as [number, number];
    for (let i = 0; i < 20; i++) {
      seed++;
      const jx = ((Math.sin(seed) * 1000) % 1) * 0.6;
      const jy = ((Math.cos(seed) * 1000) % 1) * 0.6;
      vectors.push(project2DTo384(cx + jx, cy + jy, 0.01, seed));
    }
  }
  return vectors;
}

describe("chooseK", () => {
  test("clamps below floor for small n", () => {
    expect(chooseK(1)).toBe(1);
    expect(chooseK(4)).toBe(4);
    expect(chooseK(9)).toBe(5);
    expect(chooseK(10)).toBe(5);
  });

  test("clamps above ceiling for large n", () => {
    // sqrt(5000/2) = 50, sqrt(10000/2) = 70 > 50 cap
    expect(chooseK(5_000)).toBe(50);
    expect(chooseK(10_000)).toBe(50);
    expect(chooseK(1_000_000)).toBe(50);
  });

  test("square-root math in the mid range", () => {
    expect(chooseK(200)).toBe(10);
    expect(chooseK(800)).toBe(20);
    expect(chooseK(1_000)).toBe(22);
  });

  test("zero yields zero", () => {
    expect(chooseK(0)).toBe(0);
  });
});

describe("clusterEmbeddings", () => {
  test("recovers well-separated blobs with expected membership", () => {
    const vectors = syntheticBlobs();
    const result = clusterEmbeddings(vectors, { k: 3, seed: 42 });
    expect(result.centroids.length).toBe(3);
    expect(result.assignments.length).toBe(vectors.length);

    // Each 20-point blob should be assigned to exactly one cluster id.
    const blobClusters = [
      new Set(result.assignments.slice(0, 20)),
      new Set(result.assignments.slice(20, 40)),
      new Set(result.assignments.slice(40, 60)),
    ];
    for (const set of blobClusters) {
      expect(set.size).toBe(1);
    }
    // All three blob clusters must be distinct.
    const allIds = blobClusters.map((s) => [...s][0]);
    expect(new Set(allIds).size).toBe(3);
  });

  test("is deterministic for the same seed", () => {
    const vectors = syntheticBlobs();
    const a = clusterEmbeddings(vectors, { k: 3, seed: 7 });
    const b = clusterEmbeddings(vectors, { k: 3, seed: 7 });
    expect(a.assignments).toEqual(b.assignments);
    for (let i = 0; i < a.centroids.length; i++) {
      const sim = cosineSimilarity(a.centroids[i] as Float32Array, b.centroids[i] as Float32Array);
      expect(sim).toBeGreaterThan(0.999999);
    }
  });

  test("converges before the iteration cap on easy data", () => {
    const vectors = syntheticBlobs();
    const result = clusterEmbeddings(vectors, { k: 3, seed: 11, maxIterations: 20 });
    expect(result.iterations).toBeLessThan(20);
  });

  test("handles n=1 by returning a single centroid equal to the point", () => {
    const v = project2DTo384(1, 2, 0, 99);
    const result = clusterEmbeddings([v], { k: 1, seed: 0 });
    expect(result.centroids.length).toBe(1);
    expect(result.assignments).toEqual([0]);
    const sim = cosineSimilarity(result.centroids[0] as Float32Array, v);
    expect(sim).toBeGreaterThan(0.999999);
  });

  test("empty input returns empty result with k=0", () => {
    const result = clusterEmbeddings([]);
    expect(result).toEqual({ centroids: [], assignments: [], k: 0, iterations: 0 });
  });

  test("k is derived from chooseK when not provided", () => {
    const vectors = syntheticBlobs();
    const result = clusterEmbeddings(vectors, { seed: 3 });
    // 60 points -> floor(sqrt(30)) = 5, which is at the floor
    expect(result.k).toBe(5);
  });
});
