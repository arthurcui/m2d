import OpenAI from 'openai';
import {
  LlmError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
} from './contracts.js';
export const supportedModels = ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'];
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly adapterVersion = 'openai-responses-workbook-v1';
  private readonly client: OpenAI;
  constructor(key: string, fetcher?: typeof fetch) {
    if (!key.trim())
      throw new LlmError(
        'LLM_UNCONFIGURED',
        'Add a backend OpenAI API key to enable workbook parsing.',
      );
    this.client = new OpenAI({
      apiKey: key,
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      timeout: 120000,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
  }
  capabilities(model: string) {
    return { structuredOutput: supportedModels.includes(model) };
  }
  async generate(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    if (
      !this.capabilities(request.model).structuredOutput ||
      request.history.some((i) => i.kind !== 'text')
    )
      throw new LlmError(
        'LLM_CAPABILITY_UNSUPPORTED',
        'This workbook adapter requires a supported structured-output model and text evidence.',
      );
    try {
      const response = await this.client.responses.create(
        {
          model: request.model,
          store: false,
          instructions: request.instructions,
          input: request.history.flatMap((i) =>
            i.kind === 'text' ? [{ role: i.role, content: i.text }] : [],
          ),
          max_output_tokens: request.limits.maxOutputTokens,
          reasoning: { effort: 'low' },
          text: {
            format: {
              type: 'json_schema',
              name: 'workbook_interpretation',
              strict: true,
              schema: request.outputSchema,
            },
          },
        },
        { timeout: request.limits.timeoutMs, ...(signal ? { signal } : {}) },
      );
      const refused = response.output.some(
        (item) =>
          item.type === 'message' &&
          item.content.some((c) => c.type === 'refusal'),
      );
      const status = refused
        ? 'refused'
        : response.status === 'completed'
          ? 'completed'
          : 'incomplete';
      let structuredOutput: unknown = null;
      if (status === 'completed') {
        try {
          structuredOutput = JSON.parse(response.output_text);
        } catch {
          throw new LlmError(
            'LLM_INVALID_OUTPUT',
            'AI returned invalid structured data. Nothing was changed.',
          );
        }
      }
      return {
        status,
        structuredOutput,
        items: [
          {
            id: response.id,
            kind: 'text',
            role: 'assistant',
            text: response.output_text,
          },
        ],
        usage: response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
            }
          : null,
        providerRequestId: response._request_id ?? null,
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError || signal?.aborted)
        throw new LlmError(
          'LLM_TIMEOUT',
          'AI parsing timed out or was cancelled. Usage may have been charged; no portfolio changes were made.',
        );
      if (error instanceof OpenAI.APIError) {
        const code =
          error.status === 401
            ? 'LLM_AUTHENTICATION'
            : error.status === 429
              ? error.code === 'insufficient_quota'
                ? 'LLM_QUOTA'
                : 'LLM_RATE_LIMIT'
              : error.status === 403 || error.status === 404
                ? 'LLM_MODEL_UNAVAILABLE'
                : 'LLM_UNAVAILABLE';
        const messages: Record<string, string> = {
          LLM_AUTHENTICATION: 'The OpenAI API key was rejected.',
          LLM_QUOTA:
            'OpenAI API quota is exhausted. Check API billing before retrying.',
          LLM_RATE_LIMIT:
            'OpenAI is rate limiting requests. Please retry later.',
          LLM_MODEL_UNAVAILABLE:
            'The configured model is unavailable to this API project.',
          LLM_UNAVAILABLE:
            'OpenAI could not complete this request. No portfolio changes were made.',
        };
        throw new LlmError(code, messages[code]!);
      }
      throw new LlmError(
        'LLM_TIMEOUT',
        'AI parsing was interrupted or timed out. Usage may have been charged; no portfolio changes were made.',
      );
    }
  }
}
