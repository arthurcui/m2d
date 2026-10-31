export type CanonicalItem =
  | {
      id: string;
      kind: 'text';
      role: 'user' | 'assistant';
      text: string;
      createdAt?: string;
      holdingContext?: { accountKey: string; instrumentKey?: string };
    }
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
  outputSchema?: Record<string, unknown>;
  requestId?: string;
  analysisMode?: 'quick' | 'standard' | 'extensive';
  modePolicyVersion?: string;
  tools?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
  requiredCapabilities?: ('structuredOutput' | 'tools' | 'streaming')[];
  continuation?: Continuation;
  limits: { maxOutputTokens: number; timeoutMs: number };
}
export interface ModelResponse {
  status: 'completed' | 'tool_calls' | 'refused' | 'incomplete';
  structuredOutput: unknown;
  items: CanonicalItem[];
  usage: { inputTokens: number; outputTokens: number } | null;
  providerRequestId: string | null;
  continuation?: Continuation;
}
export interface Continuation {
  provider: string;
  model: string;
  adapterVersion: string;
  acknowledgedItemId: string;
  payload: unknown;
}
export type ModelEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'result'; result: ModelResponse };
export interface LlmProvider {
  readonly id: 'openai' | 'fixture';
  readonly adapterVersion: string;
  capabilities(model: string): {
    structuredOutput: boolean;
    tools?: boolean;
    streaming?: boolean;
  };
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  stream?(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}
export class LlmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics?: {
      providerCode?: string;
      parameter?: string;
      requestId?: string;
    },
  ) {
    super(message);
  }
}
