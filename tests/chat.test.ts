import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  runChat,
  resolvePolicy,
  policies,
  selectMode,
  validateChatOperation,
  type AgentDependencies,
} from '../packages/agent/src/index.js';
import {
  ChatFixtureProvider,
  OpenAiProvider,
  createLlmProvider,
  type CanonicalItem,
  type ModelRequest,
  type ModelResponse,
  type LlmProvider,
} from '../packages/llm/src/index.js';
import {
  stateSchema,
  instrumentSchema,
  instrumentKey,
  applyOperation,
} from '../packages/portfolio/src/index.js';
const stock = instrumentSchema.parse({
  assetType: 'STOCK',
  symbol: 'AAPL',
  exchange: 'NASDAQ',
  currency: 'USD',
  optionRight: null,
  expiry: null,
  strike: null,
  multiplier: '1',
  underlying: null,
  deliverable: null,
});
const empty = stateSchema.parse({
  accounts: [
    {
      accountKey: 'margin',
      displayName: 'Margin',
      institution: 'Fixture',
      accountType: 'MARGIN',
      baseCurrency: 'USD',
      active: true,
    },
  ],
  cash: [{ accountKey: 'margin', currency: 'USD', balance: '10000' }],
  positions: [],
});
const state = applyOperation(empty, {
  kind: 'STOCK_BUY',
  accountKey: 'margin',
  instrument: stock,
  quantity: '100',
  price: '100',
  fees: '0',
  note: 'Fixture',
  effectiveAt: '2026-10-01T00:00:00Z',
}).state;
const ceilings = {
  modelCalls: 16,
  toolCalls: 24,
  deadlineMs: 300000,
  maxOutputTokens: 8192,
  requestTimeoutMs: 60000,
  maxInputCharacters: 80000,
  maxRunCost: null,
  dailyBudget: null,
};
const user = (text: string): Extract<CanonicalItem, { kind: 'text' }> => ({
  id: randomUUID(),
  kind: 'text',
  role: 'user',
  text,
});
function harness(
  provider: LlmProvider = new ChatFixtureProvider(),
  message = 'sell to open 1 covered call AAPL expiry 2026-12-18 strike 200 at 2 no fees standard 100-share contract',
) {
  const changes: unknown[] = [],
    events: unknown[] = [],
    calls = new Map<string, unknown>();
  let history: CanonicalItem[] = [user(message)];
  const deps: AgentDependencies = {
    overview: async () => ({
      state,
      revision: 1,
      effectiveAt: '2026-10-01T00:00:00Z',
    }),
    preview: async (input) => {
      const result = applyOperation(state, input.operation);
      changes.push(result);
      return { id: randomUUID(), ...result };
    },
    tool: async (id, _args, execute) => {
      if (calls.has(id)) return calls.get(id);
      const output = await execute();
      calls.set(id, output);
      return output;
    },
    emit: async (e) => {
      events.push(e);
    },
    checkpoint: async (h) => {
      history = h;
    },
    reserve: async () => {},
    usage: async () => {},
  };
  return {
    changes,
    events,
    deps,
    history: () => history,
    start: (overrides: Partial<Parameters<typeof runChat>[0]> = {}) =>
      runChat(
        {
          runId: randomUUID(),
          model: provider.id === 'fixture' ? 'fixture-v1' : 'gpt-5.4-mini',
          provider,
          history,
          mode: 'standard',
          limits: resolvePolicy('standard', ceilings),
          signal: new AbortController().signal,
          ...overrides,
        },
        deps,
      ),
  };
}
describe('M2 chat orchestration', () => {
  it('counts uncached search embeddings inside the selected model-attempt allowance', async () => {
    const h = harness(
      undefined,
      'Research context: ACME\nCould it run out of money?',
    );
    let embedded = 0;
    h.deps.research = async (_name, _args, beforeEmbedding) => {
      beforeEmbedding();
      embedded++;
      return { hits: [] };
    };
    await expect(
      h.start({ mode: 'quick', limits: { ...ceilings, modelCalls: 2 } }),
    ).rejects.toMatchObject({ code: 'LLM_BUDGET' });
    expect(embedded).toBe(1);
    expect(h.changes).toHaveLength(0);
    const denied = harness(
      undefined,
      'Research context: ACME\nCould it run out of money?',
    );
    denied.deps.research = async (_name, _args, beforeEmbedding) => {
      beforeEmbedding();
      embedded++;
      return { hits: [] };
    };
    await expect(
      denied.start({ mode: 'quick', limits: { ...ceilings, modelCalls: 1 } }),
    ).rejects.toMatchObject({ code: 'LLM_BUDGET' });
    expect(embedded).toBe(1);
  });
  it('reads cached valuation without a financial preview or invented market values', async () => {
    const h = harness(undefined, 'What is my portfolio valuation?');
    h.deps.valuation = async () => ({
      nav: null,
      knownValue: '500',
      baseCurrency: 'USD',
      quality: 'INCOMPLETE',
      oldestAsOf: '2026-10-30T20:00:00Z',
    });
    const result = await h.start();
    expect(result.previewId).toBeNull();
    expect(h.changes).toHaveLength(0);
    expect(h.history().at(-1)).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('incomplete (known subtotal 500)'),
    });
  });
  it('applies mode precedence and clamps every policy to deployment ceilings', () => {
    expect(selectMode(undefined, undefined, 'standard')).toBe('standard');
    expect(selectMode('quick', 'extensive', 'standard')).toBe('quick');
    expect(selectMode(undefined, 'quick', 'standard')).toBe('quick');
    for (const mode of ['quick', 'standard', 'extensive'] as const) {
      expect(resolvePolicy(mode, ceilings)).toMatchObject(policies[mode]);
      expect(
        resolvePolicy(mode, {
          ...ceilings,
          modelCalls: 1,
          toolCalls: 2,
          deadlineMs: 500,
          maxOutputTokens: 100,
        }),
      ).toMatchObject({
        modelCalls: 1,
        toolCalls: 2,
        deadlineMs: 500,
        maxOutputTokens: 100,
      });
    }
  });
  it('previews a negative covered call and exact cash increase without mutating source state', async () => {
    const h = harness();
    const result = await h.start();
    expect(result.previewId).toBeTruthy();
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]).toMatchObject({
      state: {
        cash: [{ balance: '200' }],
        positions: expect.arrayContaining([
          expect.objectContaining({ quantity: '-1' }),
        ]),
      },
    });
    expect(state.cash[0]?.balance).toBe('0');
    expect(result.attempts).toBe(2);
  });
  it('asks for missing contract facts without a preview', async () => {
    const h = harness(undefined, 'sell to open 1 covered call');
    expect((await h.start()).previewId).toBeNull();
    expect(h.history().at(-1)).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('expiry'),
    });
    expect(h.changes).toHaveLength(0);
  });
  it('does not reuse amounts from a previous accepted proposal', () => {
    const history: CanonicalItem[] = [
      user('buy 1 AAPL at 10 no fees'),
      {
        id: randomUUID(),
        kind: 'tool_result',
        callId: 'old',
        output: { id: randomUUID() },
      },
      user('buy AAPL'),
    ];
    expect(() =>
      validateChatOperation(
        {
          covered: false,
          operation: {
            kind: 'STOCK_BUY',
            accountKey: 'margin',
            instrument: stock,
            quantity: '1',
            price: '10',
            fees: '0',
            effectiveAt: new Date().toISOString(),
            note: 'buy',
          },
        },
        history,
        state,
        new Date().toISOString(),
      ),
    ).toThrow('quantity');
  });
  it('rejects uncovered extra contracts and disallowed tools', async () => {
    const h = harness(
      undefined,
      'sell to open 2 covered calls AAPL expiry 2026-12-18 strike 200 at 2 no fees standard 100-share contract',
    );
    expect((await h.start()).previewId).toBeNull();
    expect(h.history().at(-1)).toMatchObject({
      text: expect.stringContaining('do not cover'),
    });
  });
  it('stops at model budget and honors cancellation before inference', async () => {
    const h = harness();
    await expect(
      h.start({ limits: { ...ceilings, modelCalls: 1 } }),
    ).rejects.toMatchObject({ code: 'LLM_BUDGET' });
    expect(h.changes).toHaveLength(0);
    const controller = new AbortController();
    controller.abort();
    await expect(
      harness().start({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'LLM_CANCELLED' });
  });
  it('requires selected-provider key and capabilities without fallback', async () => {
    expect(() =>
      createLlmProvider(
        { LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-5.4-mini' },
        '',
      ),
    ).toThrow();
    expect(() =>
      createLlmProvider({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'x' }),
    ).toThrow();
    const provider = new ChatFixtureProvider();
    provider.capabilities = () => ({
      structuredOutput: true,
      tools: false,
      streaming: false,
    });
    await expect(harness(provider).start()).rejects.toMatchObject({
      code: 'LLM_CAPABILITY_UNSUPPORTED',
    });
  });
});
const native = (output: unknown[]) => ({
  id: 'resp_test',
  object: 'response',
  status: 'completed',
  created_at: 1,
  model: 'gpt-5.4-mini',
  output,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});
const message = {
  id: 'msg1',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Done', annotations: [] }],
};
function sse(response: unknown, delta = '') {
  return new Response(
    (delta
      ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`
      : '') +
      `data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const request: ModelRequest = {
  runId: 'r',
  model: 'gpt-5.4-mini',
  instructions: 'Test',
  history: [user('hello')],
  limits: { maxOutputTokens: 200, timeoutMs: 1000 },
  requiredCapabilities: ['tools', 'streaming'],
};
describe('OpenAI mocked continuation and streaming', () => {
  it('preserves opaque reasoning and exact canonical boundary without duplicate tools or text', async () => {
    const sent: Record<string, unknown>[] = [];
    const tool = {
      type: 'function_call',
      id: 'fc1',
      call_id: 'call1',
      name: 'portfolio_read_v1',
      arguments: '{}',
      status: 'completed',
    };
    const reasoning = {
      id: 'rs1',
      type: 'reasoning',
      summary: [],
      encrypted_content: 'opaque-test',
    };
    let n = 0;
    const provider = new OpenAiProvider('test-key', async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse(
        native(n++ === 0 ? [reasoning, tool] : [message]),
        n === 2 ? 'Done' : '',
      );
    });
    let first: ModelResponse | undefined;
    for await (const e of provider.stream(request))
      if (e.type === 'result') first = e.result;
    expect(first?.status).toBe('tool_calls');
    const history = [
      ...request.history,
      ...first!.items,
      {
        id: 'out1',
        kind: 'tool_result' as const,
        callId: 'call1',
        output: { revision: 0 },
      },
    ];
    const events = [];
    for await (const e of provider.stream({
      ...request,
      history,
      continuation: first!.continuation!,
    }))
      events.push(e);
    expect(events).toContainEqual({ type: 'text_delta', delta: 'Done' });
    expect(sent[1]?.input).toEqual(
      expect.arrayContaining([
        reasoning,
        tool,
        {
          type: 'function_call_output',
          call_id: 'call1',
          output: '{"revision":0}',
        },
      ]),
    );
    expect(sent[1]?.input as unknown[]).toHaveLength(4);
    expect(sent[0]?.store).toBe(false);
    await expect(
      provider.generate({
        ...request,
        continuation: { ...first!.continuation!, model: 'different' },
      }),
    ).rejects.toMatchObject({ code: 'LLM_CONTINUATION_SCOPE' });
  });
  it('does not emit a tool result for truncated tool arguments or incomplete streams', async () => {
    const provider = new OpenAiProvider('test', async () =>
      sse(
        native([
          {
            type: 'function_call',
            id: 'f',
            call_id: 'c',
            name: 'portfolio_read_v1',
            arguments: '{',
          },
        ]),
      ),
    );
    const read = async () => {
      for await (const event of provider.stream(request))
        if (event.type === 'result') throw new Error('Unexpected result');
    };
    await expect(read()).rejects.toMatchObject({ code: 'LLM_INVALID_OUTPUT' });
    const partial = new OpenAiProvider(
      'test',
      async () =>
        new Response(
          'data: ' +
            JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'partial',
            }) +
            '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    await expect(
      (async () => {
        for await (const _ of partial.stream(request)) {
          void _;
        }
      })(),
    ).rejects.toMatchObject({ code: 'LLM_INCOMPLETE' });
  });
});

it('does not execute a completed tool batch after cancellation or refusal', async () => {
  const controller = new AbortController();
  let executions = 0;
  const provider: LlmProvider = {
    id: 'fixture',
    adapterVersion: 'test-v1',
    capabilities: () => ({
      structuredOutput: true,
      tools: true,
      streaming: true,
    }),
    generate: async () => {
      throw new Error('unused');
    },
    async *stream() {
      controller.abort();
      yield {
        type: 'result',
        result: {
          status: 'tool_calls',
          items: [
            {
              id: 'c1',
              kind: 'tool_call',
              callId: 'c1',
              name: 'portfolio_read_v1',
              arguments: {},
            },
          ],
          structuredOutput: null,
          usage: null,
          providerRequestId: null,
        },
      };
    },
  };
  const h = harness(provider);
  h.deps.tool = async () => {
    executions++;
    return {};
  };
  await expect(h.start({ signal: controller.signal })).rejects.toMatchObject({
    code: 'LLM_CANCELLED',
  });
  expect(executions).toBe(0);
  provider.stream = async function* () {
    yield {
      type: 'result',
      result: {
        status: 'refused',
        items: [],
        structuredOutput: null,
        usage: null,
        providerRequestId: null,
      },
    };
  };
  await expect(harness(provider).start()).rejects.toMatchObject({
    code: 'LLM_REFUSED',
  });
});
it('retries only normalized transient failures within the total attempt allowance', async () => {
  const provider = new ChatFixtureProvider();
  let calls = 0;
  provider.stream = async function* () {
    calls++;
    if (calls === 1) {
      const { LlmError } = await import('../packages/llm/dist/index.js');
      throw new LlmError('LLM_RATE_LIMIT', 'retry');
    }
    yield {
      type: 'result',
      result: {
        status: 'completed',
        items: [
          {
            id: randomUUID(),
            kind: 'text',
            role: 'assistant',
            text: 'Recovered',
          },
        ],
        structuredOutput: null,
        usage: null,
        providerRequestId: null,
      },
    };
  };
  const h = harness(provider);
  expect((await h.start()).attempts).toBe(2);
  expect(calls).toBe(2);
});

it('enforces tool and wall-clock budgets before executing another tool', async () => {
  const h = harness();
  await expect(
    h.start({ limits: { ...ceilings, toolCalls: 1 } }),
  ).rejects.toMatchObject({ code: 'LLM_BUDGET' });
  expect(h.changes).toHaveLength(0);
  const provider = new ChatFixtureProvider();
  provider.stream = async function* () {
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield {
      type: 'result',
      result: {
        status: 'completed',
        items: [
          {
            id: randomUUID(),
            kind: 'text',
            role: 'assistant',
            text: 'too late',
          },
        ],
        structuredOutput: null,
        usage: null,
        providerRequestId: null,
      },
    };
  };
  await expect(
    harness(provider).start({ limits: { ...ceilings, deadlineMs: 1 } }),
  ).rejects.toMatchObject({ code: 'LLM_BUDGET' });
});

it('sends a strict provider-compatible tool schema with disjoint operation variants', async () => {
  const { chatTools } = await import('../packages/agent/src/index.js');
  let calls = 0;
  const provider = new OpenAiProvider('test-key', async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as {
      tools: { name: string; parameters: Record<string, unknown> }[];
    };
    function check(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(check);
        return;
      }
      const record = value as Record<string, unknown>;
      expect(record).not.toHaveProperty('oneOf');
      expect(record).not.toHaveProperty('default');
      if (record.type === 'object') {
        expect(record.additionalProperties).toBe(false);
        expect(record.required).toEqual(
          Object.keys(record.properties as object),
        );
      }
      Object.values(record).forEach(check);
    }
    body.tools.forEach((t) => check(t.parameters));
    const operation = (
      body.tools.find((t) => t.name === 'portfolio_preview_v1')!.parameters
        .properties as Record<string, { anyOf: Record<string, unknown>[] }>
    )['operation']!;
    const seen = new Set<string>();
    for (const branch of operation.anyOf) {
      const props = branch.properties as Record<string, { enum: string[] }>;
      expect(Object.keys(props)[0]).toBe('kind');
      for (const kind of props.kind!.enum) {
        expect(seen.has(kind)).toBe(false);
        seen.add(kind);
      }
    }
    expect(seen.has('STOCK_BUY')).toBe(true);
    expect(seen.has('OPTION_STO')).toBe(true);
    return sse(native([message]));
  });
  for await (const event of provider.stream({ ...request, tools: chatTools })) {
    if (event.type === 'result') expect(event.result.status).toBe('completed');
  }
  expect(calls).toBe(1);
});
it('identifies invalid tool schemas without echoing private provider error text', async () => {
  let calls = 0;
  const provider = new OpenAiProvider('test-key', async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_function_parameters',
          param: 'tools[1].parameters',
          message: 'Private portfolio data and test-key must not be echoed',
        },
      }),
      {
        status: 400,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_schema_test',
        },
      },
    );
  });
  try {
    for await (const event of provider.stream(request)) {
      void event;
    }
    throw new Error('Expected rejection');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'LLM_INVALID_REQUEST',
      message: expect.stringContaining('tool definition'),
      diagnostics: {
        providerCode: 'invalid_function_parameters',
        parameter: 'tools[1].parameters',
        requestId: 'req_schema_test',
      },
    });
    expect(String(error)).not.toContain('Private portfolio');
    expect(String(error)).not.toContain('test-key');
  }
  expect(calls).toBe(1);
});

it('records a yesterday trade now, without asking for an exact UTC time', async () => {
  const { reportedTradeDate, chatTools } =
    await import('../packages/agent/src/index.js');
  const now = '2026-10-31T19:00:00.000Z';
  const history: CanonicalItem[] = [
    {
      ...user('sold 1 share AAPL at $200 in Margin yesterday'),
      createdAt: '2026-10-31T18:30:00Z',
    },
    user('fee 0'),
  ];
  const operation = validateChatOperation(
    {
      covered: false,
      operation: {
        kind: 'STOCK_SELL',
        accountKey: 'margin',
        instrument: stock,
        quantity: '1',
        price: '200',
        fees: '0',
        note: 'Reported sale',
        transactionDate: null,
      },
    },
    history,
    state,
    now,
  );
  expect(operation).toMatchObject({
    kind: 'STOCK_SELL',
    effectiveAt: now,
    transactionDate: '2026-10-30',
  });
  expect(JSON.stringify(chatTools)).not.toContain('effectiveAt');
  // Clarifying after midnight must not move yesterday to a different date.
  expect(reportedTradeDate(history, '2026-11-01T20:00:00Z')).toBe('2026-10-30');
  expect(
    reportedTradeDate(
      [user('sell to open 1 covered call expiry 2026-12-18')],
      now,
    ),
  ).toBeUndefined();
  expect(() =>
    validateChatOperation(
      {
        covered: false,
        operation: { ...operation, transactionDate: '2099-01-01' },
      },
      [user('sold 1 AAPL at 200 fee 0')],
      state,
      now,
    ),
  ).toThrow('future');
});
it('retains real trade facts after a note-only preview and never says a preview is recorded', async () => {
  const now = '2026-10-31T19:00:00.000Z';
  const history: CanonicalItem[] = [
    user('sold 1 AAPL at 200 fee 0 yesterday'),
    {
      id: randomUUID(),
      kind: 'tool_result',
      callId: 'note',
      output: { id: randomUUID(), operation: { kind: 'NOTE_ONLY' } },
    },
    user('this is a real transaction, just reporting late'),
  ];
  const operation = validateChatOperation(
    {
      covered: false,
      operation: {
        kind: 'STOCK_SELL',
        accountKey: 'margin',
        instrument: stock,
        quantity: '1',
        price: '200',
        fees: '0',
        note: 'Late sale',
      },
    },
    history,
    state,
    now,
  );
  expect(operation).toMatchObject({ transactionDate: '2026-10-30' });
  const h = harness(
    undefined,
    'sold 1 share AAPL at 200 in Margin yesterday fee 0',
  );
  const result = await h.start();
  expect(result.previewId).toBeTruthy();
  expect(h.history().at(-1)).toMatchObject({
    kind: 'text',
    text: expect.stringContaining('has not been recorded'),
  });
});

it('can submit a second transaction without replaying large historical snapshots', async () => {
  const h = harness();
  await h.start();
  const first = [...h.history()];
  // Simulate a workbook-sized stored tool result from the first trade.
  const snapshot = first.find((i) => i.kind === 'tool_result');
  if (!snapshot || snapshot.kind !== 'tool_result')
    throw Error('missing snapshot');
  snapshot.output = { state: { evidence: 'x'.repeat(100000) }, revision: 1 };
  const original = JSON.stringify(first);
  const next = [...first, user('sold 2 shares AAPL at 210 no fees')];
  const result = await h.start({ history: next });
  expect(result.previewId).toBeTruthy();
  expect(h.changes).toHaveLength(2);
  expect(JSON.stringify(first)).toBe(original);
  expect(result.history).toContainEqual(snapshot);
  expect(h.events).toContainEqual(
    expect.objectContaining({ type: 'context_refreshed' }),
  );
});

it('uses a selected holding for shorthand, but asks for trade price and fees', async () => {
  const selected = {
    accountKey: 'margin',
    instrumentKey: instrumentKey(stock),
  };
  const h = harness();
  const first = await h.start({
    history: [{ ...user('sold 3 shares'), holdingContext: selected }],
  });
  expect(first.previewId).toBeNull();
  expect(h.changes).toHaveLength(0);
  expect(first.history.at(-1)).toMatchObject({
    text: expect.stringContaining('price per share'),
  });
  const result = await h.start({
    history: [
      ...first.history,
      { ...user('at $200, no fees'), holdingContext: selected },
    ],
  });
  expect(result.previewId).toBeTruthy();
  expect(h.changes[0]).toMatchObject({
    state: {
      positions: expect.arrayContaining([
        expect.objectContaining({ quantity: '97' }),
      ]),
      cash: expect.arrayContaining([
        expect.objectContaining({ balance: '600' }),
      ]),
    },
  });
  expect(
    result.history.find((i) => i.kind === 'text' && i.role === 'user'),
  ).toMatchObject({ holdingContext: selected, text: 'sold 3 shares' });
});
it('rejects a different or removed holding instead of using the wrong selected context', async () => {
  const selected = {
    accountKey: 'margin',
    instrumentKey: instrumentKey(stock),
  };
  const history = [
    { ...user('sold 3 shares at 200 no fees'), holdingContext: selected },
  ];
  expect(() =>
    validateChatOperation(
      {
        covered: false,
        operation: {
          kind: 'STOCK_SELL',
          accountKey: 'another-account',
          instrument: stock,
          quantity: '3',
          price: '200',
          fees: '0',
          note: 'sale',
        },
      },
      history,
      state,
      new Date().toISOString(),
    ),
  ).toThrow('selected holding');
  const h = harness();
  h.deps.overview = async () => ({
    state: { ...state, positions: [] },
    revision: 2,
    effectiveAt: null,
  });
  expect(() =>
    validateChatOperation(
      {
        covered: false,
        operation: {
          kind: 'STOCK_SELL',
          accountKey: 'margin',
          instrument: stock,
          quantity: '3',
          price: '200',
          fees: '0',
          note: 'sale',
        },
      },
      history,
      { ...state, positions: [] },
      new Date().toISOString(),
    ),
  ).toThrow('no longer');
});

it('does not reuse transaction amounts when the selected holding changes', () => {
  const selected = {
    accountKey: 'margin',
    instrumentKey: instrumentKey(stock),
  };
  const history = [
    {
      ...user('sold 3 shares at 200 no fees'),
      holdingContext: { ...selected, accountKey: 'other' },
    },
    { ...user('at 200 no fees'), holdingContext: selected },
  ];
  expect(() =>
    validateChatOperation(
      {
        covered: false,
        operation: {
          kind: 'STOCK_SELL',
          accountKey: 'margin',
          instrument: stock,
          quantity: '3',
          price: '200',
          fees: '0',
          note: 'sale',
        },
      },
      history,
      state,
      new Date().toISOString(),
    ),
  ).toThrow('quantity');
});

it('answers a different ticker with holding or account selection without inference or mutation', async () => {
  const h = harness();
  const current = {
    ...state,
    accounts: [
      ...state.accounts,
      { ...state.accounts[0]!, accountKey: 'tfsa', displayName: 'TFSA' },
    ],
    positions: [
      ...state.positions,
      {
        ...state.positions[0]!,
        instrument: { ...stock, symbol: 'TSLA' },
        quantity: '2.5',
      },
      {
        ...state.positions[0]!,
        accountKey: 'tfsa',
        instrument: { ...stock, symbol: 'TSLA' },
        quantity: '-1.25',
      },
    ],
  };
  h.deps.overview = async () => ({
    state: current,
    revision: 8,
    effectiveAt: '2026-10-31T12:00:00Z',
  });
  for (const holdingContext of [
    { accountKey: 'margin', instrumentKey: 'removed holding' },
    { accountKey: 'margin' },
  ]) {
    const result = await h.start({
      history: [{ ...user('how many tsla?'), holdingContext }],
    });
    expect(result.history.at(-1)).toMatchObject({
      text: expect.stringContaining('2.5 TSLA shares'),
    });
    expect(result.attempts).toBe(0);
    expect(result.previewId).toBeNull();
  }
  const all = await h.start({
    history: [
      {
        ...user('how many tsla across all accounts?'),
        holdingContext: { accountKey: 'margin' },
      },
    ],
  });
  expect(all.history.at(-1)).toMatchObject({
    text: expect.stringContaining('All accounts: 1.25 TSLA shares'),
  });
  expect(h.changes).toHaveLength(0);
});
it('account-only context still requires a security and prevents changes to another account', async () => {
  const h = harness();
  const result = await h.start({
    history: [
      {
        ...user('sold 3 shares at 200 no fees'),
        holdingContext: { accountKey: 'margin' },
      },
    ],
  });
  expect(result.previewId).toBeNull();
  expect(result.history.at(-1)).toMatchObject({
    text: expect.stringContaining('Which security'),
  });
  const next = await h.start({
    history: [
      ...result.history,
      { ...user('AAPL'), holdingContext: { accountKey: 'margin' } },
    ],
  });
  expect(next.previewId).toBeTruthy();
  expect(() =>
    validateChatOperation(
      {
        covered: false,
        operation: {
          kind: 'STOCK_SELL',
          accountKey: 'other',
          instrument: stock,
          quantity: '3',
          price: '200',
          fees: '0',
          note: 'sale',
        },
      },
      [
        {
          ...user('sold 3 AAPL at 200 no fees'),
          holdingContext: { accountKey: 'margin' },
        },
      ],
      state,
      new Date().toISOString(),
    ),
  ).toThrow('selected account');
});
