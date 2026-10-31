import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import {
  LlmError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelEvent,
  type CanonicalItem,
} from './contracts.js';
export const supportedModels = ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'];
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly adapterVersion = 'openai-responses-v2';
  private readonly client: OpenAI;
  constructor(key: string, fetcher?: typeof fetch) {
    if (!key.trim())
      throw new LlmError(
        'LLM_UNCONFIGURED',
        'Configure the backend OpenAI API key.',
      );
    this.client = new OpenAI({
      apiKey: key,
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      timeout: 60000,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
  }
  capabilities(model: string) {
    const supported = supportedModels.includes(model);
    return {
      structuredOutput: supported,
      tools: supported,
      streaming: supported,
    };
  }
  private input(request: ModelRequest): OpenAI.Responses.ResponseInput {
    const caps = this.capabilities(request.model);
    if (
      !caps.structuredOutput ||
      request.requiredCapabilities?.some((c) => !caps[c])
    )
      throw new LlmError(
        'LLM_CAPABILITY_UNSUPPORTED',
        'The selected model does not support this request.',
      );
    let native: OpenAI.Responses.ResponseInput = [];
    let history = request.history;
    const continuation = request.continuation;
    if (continuation) {
      if (
        continuation.provider !== this.id ||
        continuation.model !== request.model ||
        continuation.adapterVersion !== this.adapterVersion
      )
        throw new LlmError(
          'LLM_CONTINUATION_SCOPE',
          'Continuation belongs to a different provider, model or adapter.',
        );
      const index = history.findIndex(
        (i) => i.id === continuation.acknowledgedItemId,
      );
      if (index < 0 || !Array.isArray(continuation.payload))
        throw new LlmError(
          'LLM_CONTINUATION_INVALID',
          'Continuation boundary is missing.',
        );
      native = continuation.payload as OpenAI.Responses.ResponseInput;
      history = history.slice(index + 1);
    }
    return [
      ...native,
      ...history.map((i): OpenAI.Responses.ResponseInputItem =>
        i.kind === 'text'
          ? { role: i.role, content: i.text }
          : i.kind === 'tool_call'
            ? {
                type: 'function_call',
                call_id: i.callId,
                name: i.name,
                arguments: JSON.stringify(i.arguments),
              }
            : {
                type: 'function_call_output',
                call_id: i.callId,
                output: JSON.stringify(i.output),
              },
      ),
    ];
  }
  private params(
    request: ModelRequest,
    input: OpenAI.Responses.ResponseInput,
  ): OpenAI.Responses.ResponseCreateParamsNonStreaming {
    return {
      model: request.model,
      store: false,
      include: ['reasoning.encrypted_content'],
      instructions: request.instructions,
      input,
      max_output_tokens: request.limits.maxOutputTokens,
      reasoning: { effort: 'low' },
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function' as const,
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              strict: true,
            })),
            parallel_tool_calls: false,
          }
        : {}),
      ...(request.outputSchema
        ? {
            text: {
              format: {
                type: 'json_schema' as const,
                name: 'm2d_output',
                strict: true,
                schema: request.outputSchema,
              },
            },
          }
        : {}),
    };
  }
  private normalize(
    response: OpenAI.Responses.Response,
    request: ModelRequest,
    input: OpenAI.Responses.ResponseInput,
  ): ModelResponse {
    const items: CanonicalItem[] = [];
    let refused = false;
    for (const item of response.output) {
      if (item.type === 'function_call') {
        let args: unknown;
        try {
          args = JSON.parse(item.arguments);
        } catch {
          throw new LlmError(
            'LLM_INVALID_OUTPUT',
            'Invalid tool arguments; no tool was executed.',
          );
        }
        items.push({
          id: item.id ?? randomUUID(),
          kind: 'tool_call',
          callId: item.call_id,
          name: item.name,
          arguments: args,
        });
      } else if (item.type === 'message')
        for (const c of item.content) {
          if (c.type === 'refusal') refused = true;
          else if (c.type === 'output_text')
            items.push({
              id: randomUUID(),
              kind: 'text',
              role: 'assistant',
              text: c.text,
            });
        }
    }
    const status = refused
      ? 'refused'
      : response.status !== 'completed'
        ? 'incomplete'
        : items.some((i) => i.kind === 'tool_call')
          ? 'tool_calls'
          : 'completed';
    let structuredOutput: unknown = null;
    if (status === 'completed' && request.outputSchema)
      try {
        structuredOutput = JSON.parse(response.output_text);
      } catch {
        throw new LlmError(
          'LLM_INVALID_OUTPUT',
          'AI returned invalid structured data. Nothing was changed.',
        );
      }
    const boundary = items.at(-1)?.id ?? request.history.at(-1)?.id;
    return {
      status,
      structuredOutput,
      items,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : null,
      providerRequestId:
        ('request_id' in response ? String(response.request_id) : undefined) ??
        null,
      ...(boundary
        ? {
            continuation: {
              provider: this.id,
              model: request.model,
              adapterVersion: this.adapterVersion,
              acknowledgedItemId: boundary,
              payload: [...input, ...response.output],
            },
          }
        : {}),
    };
  }
  private failure(error: unknown, signal?: AbortSignal): never {
    if (error instanceof LlmError) throw error;
    if (signal?.aborted)
      throw new LlmError(
        'LLM_CANCELLED',
        'Request cancelled; usage may have been charged.',
      );
    if (error instanceof OpenAI.APIConnectionTimeoutError)
      throw new LlmError(
        'LLM_TIMEOUT',
        'Request timed out; usage may have been charged.',
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
              : error.status === 400 || error.status === 422
                ? 'LLM_INVALID_REQUEST'
                : 'LLM_UNAVAILABLE';
      throw new LlmError(
        code,
        code === 'LLM_QUOTA'
          ? 'OpenAI API quota is exhausted. Check API billing before retrying.'
          : code === 'LLM_INVALID_REQUEST'
            ? error.code === 'invalid_function_parameters'
              ? 'Agent’s tool definition was rejected by the provider. This is an application error; changing your answer or work allowance will not fix it.'
              : 'The provider rejected Agent’s request format. This is an application error; changing your answer or work allowance will not fix it.'
            : `Provider request failed (${code}). No financial changes were committed.`,
        {
          ...(typeof error.code === 'string' &&
          /^[a-z_]{1,80}$/.test(error.code)
            ? { providerCode: error.code }
            : {}),
          ...(typeof error.param === 'string' &&
          /^(?:[a-zA-Z0-9_.]|\[|\]){1,200}$/.test(error.param)
            ? { parameter: error.param }
            : {}),
          ...(typeof error.requestID === 'string' &&
          /^req_[a-zA-Z0-9_-]{1,180}$/.test(error.requestID)
            ? { requestId: error.requestID }
            : {}),
        },
      );
    }
    throw new LlmError(
      'LLM_UNAVAILABLE',
      'Provider connection interrupted; usage is uncertain.',
    );
  }
  async generate(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const input = this.input(request);
    try {
      return this.normalize(
        await this.client.responses.create(this.params(request, input), {
          timeout: request.limits.timeoutMs,
          ...(signal ? { signal } : {}),
        }),
        request,
        input,
      );
    } catch (e) {
      return this.failure(e, signal);
    }
  }
  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const input = this.input(request);
    let terminal = false;
    try {
      const stream = await this.client.responses.create(
        { ...this.params(request, input), stream: true },
        { timeout: request.limits.timeoutMs, ...(signal ? { signal } : {}) },
      );
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta')
          yield { type: 'text_delta', delta: event.delta };
        if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete' ||
          event.type === 'response.failed'
        ) {
          terminal = true;
          yield {
            type: 'result',
            result: this.normalize(event.response, request, input),
          };
          break;
        }
      }
      if (!terminal)
        throw new LlmError(
          'LLM_INCOMPLETE',
          'The response stream ended before completion.',
        );
    } catch (e) {
      this.failure(e, signal);
    }
  }
}
