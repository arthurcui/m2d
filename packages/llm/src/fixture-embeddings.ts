import { createHash } from 'node:crypto';
import {
  LlmError,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from './contracts.js';
/** Synthetic test vectors only. These are not a local semantic model or production fallback. */
export function fixtureEmbeddings(
  request: EmbeddingRequest,
  signal?: AbortSignal,
): EmbeddingResponse {
  if (signal?.aborted)
    throw new LlmError('LLM_CANCELLED', 'Embedding cancelled.');
  if (request.model !== 'fixture-embedding-v1' || request.dimensions !== 1536)
    throw new LlmError(
      'LLM_CAPABILITY_UNSUPPORTED',
      'Fixture embeddings require fixture-embedding-v1 / 1536.',
    );
  const concepts = [
    /liquid|cash|money|solven|funds|runway|operations for|run out/i,
    /revenue|sales|top.line|turnover/i,
    /risk|supplier|concentrat|depend|threat/i,
    /guidance|outlook|forecast|expect|anticipat/i,
    /profit|earnings|net.income/i,
    /margin|costs|expense|efficien/i,
  ];
  return {
    vectors: request.input.map((text) => {
      const vector = Array.from({ length: 1536 }, () => 0);
      for (const [i, pattern] of concepts.entries())
        vector[i] = pattern.test(text) ? 1 : 0;
      vector[
        7 + (createHash('sha256').update(text).digest().readUInt16BE(0) % 1529)
      ] = 0.01; // Defined cosine even for a synthetic out-of-topic passage.
      return vector;
    }),
    inputTokens: 0,
    providerRequestId: null,
  };
}
