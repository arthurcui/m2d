export * from './contracts.js';
export { OpenAiProvider, supportedModels } from './openai.js';
import type { LlmProvider, ModelResponse } from './contracts.js';
// Explicit recorded scenarios for offline tests; never a fallback for OpenAI.
export class FixtureProvider implements LlmProvider {
  readonly id = 'fixture' as const;
  readonly adapterVersion = 'fixture-workbook-v1';
  constructor(private readonly output: unknown) {}
  capabilities(model: string) {
    return { structuredOutput: model === 'fixture-v1' };
  }
  async generate(): Promise<ModelResponse> {
    return {
      status: 'completed',
      structuredOutput: this.output,
      items: [],
      usage: null,
      providerRequestId: null,
    };
  }
}

export * from './factory.js';
