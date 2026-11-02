import type { Chunk } from './contracts.js';
const labels = {
  publisher: /^(?:research firm|broker|bank|publisher)\s*[:：]/i,
  analyst: /^(?:analyst|analysts|author|authors)\s*[:：]/i,
  reportDate: /^(?:report date|publication date|published)\s*[:：]/i,
  rating: /^(?:rating|recommendation|investment rating)\s*[:：]/i,
  target: /^(?:price target|target price|fair value)\s*[:：]/i,
  currency: /^(?:currency|target currency)\s*[:：]/i,
  horizon:
    /^(?:horizon|target horizon|investment horizon|time horizon)\s*[:：]/i,
  forecasts: /^(?:forecast|forecasts|estimates|earnings estimates)\s*[:：]/i,
  assumptions:
    /^(?:assumptions|valuation|valuation assumptions|methodology)\s*[:：]/i,
  catalysts: /^(?:catalyst|catalysts)\s*[:：]/i,
  risks: /^(?:risk|risks|key risks)\s*[:：]/i,
};
/** Exact, explicitly labelled excerpts only. No numeric normalization or inferred identity. */
export function analystProfile(
  chunks: Pick<Chunk, 'index' | 'page' | 'text'>[],
) {
  return {
    version: 'analyst-labels-v1',
    fields: Object.entries(labels).map(([field, pattern]) => ({
      field,
      excerpts: chunks
        .flatMap((chunk) =>
          chunk.text
            .split('\n')
            .filter(
              (line) => pattern.test(line.trim()) && line.trim().length <= 1200,
            )
            .map((line) => ({
              text: line.trim(),
              chunkIndex: chunk.index,
              page: chunk.page,
            })),
        )
        .slice(0, 5),
    })),
  };
}
