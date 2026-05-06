// Embeddings via @xenova/transformers — runs sentence-transformers locally in Node.
// First call downloads the model (~80MB) and caches under ~/.cache; subsequent
// calls are offline and fast. Good enough for prototype clustering; swap to
// OpenAI/Voyage if quality matters in production.

import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2"; // 384-dim, ~80MB

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL) as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  // out.data is flat Float32Array of shape [N, dim]; reshape
  const dim = out.data.length / texts.length;
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(Array.from((out.data as Float32Array).slice(i * dim, (i + 1) * dim)));
  }
  return result;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  // Inputs are already L2-normalized → cosine = dot product
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
