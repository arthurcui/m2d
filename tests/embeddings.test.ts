import { expect, it } from 'vitest';
import { OpenAiProvider } from '../packages/llm/dist/index.js';
const request = {
  model: 'text-embedding-3-small',
  input: ['liquidity', 'funding'],
  dimensions: 1536,
  timeoutMs: 1000,
};
const vector = (v: number) =>
  Array.from({ length: 1536 }, (_, i) => (i === 0 ? v : 0));
it('uses the embeddings API with ordered, validated vectors and usage through LlmProvider', async () => {
  let called = 0;
  const provider = new OpenAiProvider('offline-test-key', async (url, init) => {
    called++;
    expect(String(url)).toBe('https://api.openai.com/v1/embeddings');
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      dimensions: number;
      input: string[];
    };
    expect(body).toMatchObject({
      model: request.model,
      dimensions: 1536,
      input: request.input,
    });
    return new Response(
      JSON.stringify({
        object: 'list',
        model: request.model,
        data: [
          { index: 1, embedding: vector(2) },
          { index: 0, embedding: vector(1) },
        ],
        usage: { prompt_tokens: 8, total_tokens: 8 },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'offline-request',
        },
      },
    );
  });
  const result = await provider.embed(request);
  expect(result.vectors[0]?.[0]).toBe(1);
  expect(result.inputTokens).toBe(8);
  expect(called).toBe(1);
});
it('rejects invalid indexes and unsupported models without silently substituting vectors', async () => {
  const provider = new OpenAiProvider(
    'offline-test-key',
    async () =>
      new Response(
        JSON.stringify({
          model: request.model,
          data: [
            { index: 0, embedding: vector(1) },
            { index: 0, embedding: vector(2) },
          ],
          usage: { prompt_tokens: 8, total_tokens: 8 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  await expect(provider.embed(request)).rejects.toMatchObject({
    code: 'LLM_INVALID_RESPONSE',
  });
  await expect(
    provider.embed({ ...request, model: 'unknown-model' }),
  ).rejects.toMatchObject({ code: 'LLM_INVALID_REQUEST' });
  await expect(
    provider.embed({ ...request, input: ['x'.repeat(8001)] }),
  ).rejects.toMatchObject({ code: 'LLM_INVALID_REQUEST' });
});
it('does not retry provider failures automatically', async () => {
  let calls = 0;
  const provider = new OpenAiProvider('offline-test-key', async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: {
          message: 'Offline rate limit',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  });
  await expect(provider.embed(request)).rejects.toMatchObject({
    code: 'LLM_RATE_LIMIT',
  });
  expect(calls).toBe(1);
});
