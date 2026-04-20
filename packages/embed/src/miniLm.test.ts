import { beforeAll, describe, expect, test } from "bun:test";
import { cosineSimilarity } from "./cluster";
import { embed, embedBatch, MINI_LM_DIM, MiniLmProvider } from "./miniLm";

// MiniLM model download (~23MB quantized) is cached in BEMATIST_MODEL_CACHE_DIR
// between test runs. First run takes ~20s to download; subsequent runs <1s.
beforeAll(() => {
  process.env.BEMATIST_MODEL_CACHE_DIR ??= "/tmp/bematist-xenova-cache";
});

describe("miniLm.embed", () => {
  test(
    "returns 384-dim Float32Array for a short string",
    async () => {
      const vec = await embed("hello world");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(MINI_LM_DIM);
    },
    { timeout: 120_000 },
  );

  test(
    "is deterministic across two calls on the same text",
    async () => {
      const a = await embed("the quick brown fox jumps over the lazy dog");
      const b = await embed("the quick brown fox jumps over the lazy dog");
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeGreaterThan(0.999999);
    },
    { timeout: 120_000 },
  );

  test(
    "semantically similar sentences have higher cosine sim than unrelated ones",
    async () => {
      const a = await embed("fix the failing test suite");
      const b = await embed("repair the broken test cases");
      const c = await embed("bake a chocolate cake with sprinkles");
      const close = cosineSimilarity(a, b);
      const far = cosineSimilarity(a, c);
      expect(close).toBeGreaterThan(far);
    },
    { timeout: 120_000 },
  );
});

describe("miniLm.embedBatch", () => {
  test(
    "returns one 384-dim vector per input and matches single-call semantically",
    async () => {
      const texts = ["first prompt", "second prompt", "third prompt"];
      const batched = await embedBatch(texts);
      expect(batched.length).toBe(texts.length);
      for (const v of batched) expect(v.length).toBe(MINI_LM_DIM);

      // Batched attention masks pad-right which shifts mean-pooled outputs slightly
      // vs a single-call pass (~0.99 cosine, not bit-identical). The semantic
      // ordering is preserved: batch[i] must be closer to single(texts[i]) than
      // to single(other text).
      const single1 = await embed(texts[1] ?? "");
      const single2 = await embed(texts[2] ?? "");
      const matched = cosineSimilarity(batched[1] as Float32Array, single1);
      const offDiag = cosineSimilarity(batched[1] as Float32Array, single2);
      expect(matched).toBeGreaterThan(0.98);
      expect(matched).toBeGreaterThan(offDiag);
    },
    { timeout: 120_000 },
  );

  test("empty batch returns empty array without calling the pipeline", async () => {
    const out = await embedBatch([]);
    expect(out).toEqual([]);
  });
});

describe("MiniLmProvider interface conformance", () => {
  test("exposes name, dim, embed, embedBatch", () => {
    expect(MiniLmProvider.name).toBe("minilm-l6-v2");
    expect(MiniLmProvider.dim).toBe(MINI_LM_DIM);
    expect(typeof MiniLmProvider.embed).toBe("function");
    expect(typeof MiniLmProvider.embedBatch).toBe("function");
  });
});
