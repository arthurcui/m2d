import { z } from 'zod';
export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9.-]{1,24}$/);
export const factSchema = z.object({
  metric: z.string().max(150),
  unit: z.string().max(60),
  start: z.iso.date().nullable(),
  end: z.iso.date(),
  value: z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/)
    .max(100),
  accession: z.string().max(100),
  filed: z.iso.date(),
});
export type Fact = z.infer<typeof factSchema>;
export type Chunk = { index: number; page: number | null; text: string };
export type Source = {
  key: string;
  title: string;
  form: string;
  url: string | null;
  publishedAt: string | null;
  raw: Uint8Array;
  mime:
    | 'text/plain'
    | 'text/html'
    | 'application/json'
    | 'application/pdf'
    | 'application/xml';
  facts?: Fact[];
};
export type ResearchProvider = {
  id: 'fixture' | 'sec';
  configured: boolean;
  fetch(
    symbol: string,
  ): Promise<{ name: string; cik: string | null; sources: Source[] }>;
};
export class ResearchError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const lookupSchema = z.object({
  symbol: symbolSchema,
  at: z.iso
    .datetime()
    .optional()
    .describe(
      'Omit/null for current/latest research. Use a timestamp only for an explicitly requested historical evidence cutoff; never substitute today at midnight.',
    ),
});
export const searchSchema = lookupSchema.extend({
  query: z.string().trim().min(1).max(200),
});
export const compareSchema = z.object({
  before: z.uuid(),
  after: z.uuid(),
  at: z.iso.datetime().optional(),
});
