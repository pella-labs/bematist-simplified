import type { EmbeddingProvider } from "./provider";

type FeatureExtractor = (
  input: string | string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DIM = 384;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function loadExtractor(): Promise<FeatureExtractor> {
  // Dynamic import so that importing this module does not pull ONNX runtime
  // and the model download happens only when embed/embedBatch is first called.
  const mod = (await import("@xenova/transformers")) as {
    pipeline: (task: string, model: string, opts?: { quantized?: boolean }) => Promise<unknown>;
    env: { allowLocalModels: boolean; cacheDir?: string };
  };

  if (process.env.BEMATIST_MODEL_CACHE_DIR) {
    mod.env.cacheDir = process.env.BEMATIST_MODEL_CACHE_DIR;
  }
  mod.env.allowLocalModels = false;

  const pipe = (await mod.pipeline("feature-extraction", MODEL_ID, {
    quantized: true,
  })) as FeatureExtractor;
  return pipe;
}

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = loadExtractor();
  }
  return extractorPromise;
}

export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  // Copy to an owned Float32Array — the pipeline reuses its internal buffer on subsequent calls.
  return new Float32Array(output.data);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    const slice = output.data.slice(i * DIM, (i + 1) * DIM);
    result.push(new Float32Array(slice));
  }
  return result;
}

export const MiniLmProvider: EmbeddingProvider = {
  name: "minilm-l6-v2",
  dim: DIM,
  embed,
  embedBatch,
};

export const MINI_LM_DIM = DIM;
export const MINI_LM_MODEL_ID = MODEL_ID;

export const __test__ = {
  reset() {
    extractorPromise = null;
  },
};
