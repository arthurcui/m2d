export type CanonicalItem =
  | { id: string; kind: 'text'; role: 'user' | 'assistant'; text: string }
  | {
      id: string;
      kind: 'tool_call';
      callId: string;
      name: string;
      arguments: unknown;
    }
  | { id: string; kind: 'tool_result'; callId: string; output: unknown };
export interface ModelRequest {
  runId: string;
  model: string;
  instructions: string;
  history: CanonicalItem[];
  outputSchema: Record<string, unknown>;
  limits: { maxOutputTokens: number; timeoutMs: number };
}
export interface ModelResponse {
  status: 'completed' | 'refused' | 'incomplete';
  structuredOutput: unknown;
  items: CanonicalItem[];
  usage: { inputTokens: number; outputTokens: number } | null;
  providerRequestId: string | null;
}
export interface LlmProvider {
  readonly id: 'openai' | 'fixture';
  readonly adapterVersion: string;
  capabilities(model: string): { structuredOutput: boolean };
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
export class LlmError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
