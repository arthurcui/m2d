import { z } from 'zod';

export const priceProviderSchema = z.enum([
  'fixture',
  'massive',
  'ibkr',
  'twelvedata',
]);
export const listingProviderSchema = z.enum([
  'none',
  'fixture',
  'massive',
  'ibkr',
]);
export const refreshSecondsSchema = z
  .number()
  .int()
  .refine(
    (v) => v === 0 || (v >= 15 && v <= 3600),
    'Choose manual refresh or 15–3600 seconds.',
  );
export const marketSettingsUpdateSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    priceProvider: priceProviderSchema.optional(),
    listingProvider: listingProviderSchema.optional(),
    refreshSeconds: refreshSecondsSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.priceProvider !== undefined ||
      v.listingProvider !== undefined ||
      v.refreshSeconds !== undefined,
    'Choose a setting to change.',
  );
export type MarketSettingsUpdate = z.infer<typeof marketSettingsUpdateSchema>;
export type MarketSettings = {
  revision: number;
  priceProvider: z.infer<typeof priceProviderSchema>;
  listingProvider: z.infer<typeof listingProviderSchema>;
  refreshSeconds: number;
  providers: Array<{
    id: z.infer<typeof priceProviderSchema>;
    label: string;
    configured: boolean;
    listings: boolean;
    minimumRefreshSeconds: number;
    priceDescription: string;
    listingDescription: string;
  }>;
};
