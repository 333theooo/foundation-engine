/**
 * Embeddings.
 *
 * An honest note on what this is. Anthropic does not offer an embeddings
 * endpoint, so the default provider here is a **local, deterministic, lexical
 * embedder**: hashed character n-grams and tokens projected into a fixed
 * dimension, L2-normalised. It is not a neural embedding and it does not
 * capture semantics — "daylight factor" and "natural illumination" will not
 * land near each other.
 *
 * It is chosen anyway because it is honest about being lexical, it needs no
 * credentials, it is deterministic (so retrieval tests are stable), and paired
 * with the term-overlap scorer in `retrieve.ts` it does the job a schematic
 * design tool actually needs: find the passage in the user's own uploaded
 * documents that mentions the thing they asked about.
 *
 * `EmbeddingProvider` is the seam. Point `createEmbeddingProvider` at Voyage,
 * OpenAI or a local model server and retrieval quality improves with no other
 * change; `docs/knowledge.md` has the steps.
 */

export const EMBEDDING_DIMENSIONS = 384;

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** FNV-1a. Fast, well-distributed, and stable across runs and platforms. */
function hash(text: string, seed: number): number {
  let value = 2166136261 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏ\s.-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && token.length < 40);
}

/** Term frequencies, used by the lexical half of hybrid retrieval. */
export function termFrequencies(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of tokenize(text)) {
    counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

class LocalLexicalEmbedder implements EmbeddingProvider {
  readonly name = 'local-lexical-v1';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const tokens = tokenize(text);

    for (const token of tokens) {
      // Whole tokens carry the most signal.
      vector[hash(token, 1) % EMBEDDING_DIMENSIONS]! += 1;
      // Character trigrams give partial credit for morphology and typos.
      for (let i = 0; i + 3 <= token.length; i += 1) {
        const gram = token.slice(i, i + 3);
        vector[hash(gram, 7) % EMBEDDING_DIMENSIONS]! += 0.35;
      }
    }

    // Bigrams capture the phrases that matter in this domain
    // ("fire door", "clear width", "solar gain").
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      vector[hash(bigram, 13) % EMBEDDING_DIMENSIONS]! += 0.6;
    }

    // Sub-linear term weighting, then L2 normalise so cosine is a dot product.
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) {
      const value = Math.log1p(vector[i]!);
      vector[i] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i += 1) vector[i] = vector[i]! / norm;
    }
    return vector;
  }
}

let provider: EmbeddingProvider | null = null;

export function createEmbeddingProvider(): EmbeddingProvider {
  provider ??= new LocalLexicalEmbedder();
  return provider;
}

/** Test seam for swapping in a different provider. */
export function setEmbeddingProvider(next: EmbeddingProvider | null): void {
  provider = next;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
