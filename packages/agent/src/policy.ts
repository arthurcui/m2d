import { z } from 'zod';
export const modeSchema = z.enum(['quick', 'standard', 'extensive']);
export type AnalysisMode = z.infer<typeof modeSchema>;
export const modePolicyVersion = 'analysis-v1';
export const policies = {
  quick: {
    modelCalls: 3,
    toolCalls: 4,
    deadlineMs: 45000,
    maxOutputTokens: 2048,
  },
  standard: {
    modelCalls: 8,
    toolCalls: 12,
    deadlineMs: 120000,
    maxOutputTokens: 4096,
  },
  extensive: {
    modelCalls: 16,
    toolCalls: 24,
    deadlineMs: 300000,
    maxOutputTokens: 8192,
  },
} as const;
export interface Limits {
  modelCalls: number;
  toolCalls: number;
  deadlineMs: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxInputCharacters: number;
  maxRunCost: string | null;
  dailyBudget: string | null;
}
export function resolvePolicy(mode: AnalysisMode, ceilings: Limits) {
  const policy = policies[mode];
  return {
    ...ceilings,
    modelCalls: Math.min(policy.modelCalls, ceilings.modelCalls),
    toolCalls: Math.min(policy.toolCalls, ceilings.toolCalls),
    deadlineMs: Math.min(policy.deadlineMs, ceilings.deadlineMs),
    maxOutputTokens: Math.min(policy.maxOutputTokens, ceilings.maxOutputTokens),
  };
}
export function selectMode(
  explicit: unknown,
  saved: unknown,
  fallback: unknown,
): AnalysisMode {
  return modeSchema.parse(explicit ?? saved ?? fallback);
}
