import { randomUUID } from 'node:crypto';
import {
  LlmError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelEvent,
} from './contracts.js';
import { OpenAiProvider } from './openai.js';
export class ChatFixtureProvider implements LlmProvider {
  readonly id = 'fixture' as const;
  readonly adapterVersion = 'fixture-chat-v1';
  capabilities(model: string) {
    return {
      structuredOutput: model === 'fixture-v1',
      tools: model === 'fixture-v1',
      streaming: model === 'fixture-v1',
    };
  }
  async generate(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    if (signal?.aborted) throw new LlmError('LLM_CANCELLED', 'Cancelled');
    if (request.model !== 'fixture-v1')
      throw new LlmError(
        'LLM_CAPABILITY_UNSUPPORTED',
        'Fixture chat requires fixture-v1.',
      );
    const base = {
      structuredOutput: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      providerRequestId: null,
    };
    const reply = (text: string): ModelResponse => ({
      ...base,
      status: 'completed',
      items: [{ id: randomUUID(), kind: 'text', role: 'assistant', text }],
    });
    const call = (name: string, args: unknown): ModelResponse => ({
      ...base,
      status: 'tool_calls',
      items: [
        {
          id: randomUUID(),
          kind: 'tool_call',
          callId: randomUUID(),
          name,
          arguments: args,
        },
      ],
    });
    const last = request.history.findLastIndex(
      (i) => i.kind === 'text' && i.role === 'user',
    );
    const tail = request.history.slice(last + 1),
      result = tail.findLast((i) => i.kind === 'tool_result');
    if (!result) return call('portfolio_read_v1', {});
    const output = result.output as {
      error?: { message: string };
      id?: string;
      state?: {
        accounts: {
          accountKey: string;
          displayName: string;
          baseCurrency: string;
          active: boolean;
        }[];
        positions: {
          instrument: Record<string, unknown>;
          accountKey: string;
        }[];
      };
    };
    if (output.error) return reply(output.error.message);
    if (output.id)
      return reply(
        'Review the proposed portfolio and cash changes below. Nothing is committed until you confirm.',
      );
    const lastPreview = request.history.findLastIndex(
      (i) =>
        i.kind === 'tool_result' &&
        i.output !== null &&
        typeof i.output === 'object' &&
        'id' in i.output,
    );
    const text = request.history
      .slice(lastPreview + 1)
      .filter((i) => i.kind === 'text' && i.role === 'user')
      .map((i) => (i.kind === 'text' ? i.text : ''))
      .join('\n');
    const latest = request.history[last];
    const message = latest?.kind === 'text' ? latest.text : '';
    if (/research|recommend|signal|price now|live|opportunit/i.test(message))
      return reply(
        'NO_SIGNAL — live market data and research are not implemented in M2. I can inspect your self-reported portfolio or preview a reported change.',
      );
    if (!/buy|sell|deposit|withdraw|cash|covered call/i.test(text))
      return reply(
        `Your self-reported portfolio has ${output.state?.accounts.filter((a) => a.active).length ?? 0} active accounts and ${output.state?.positions.length ?? 0} holdings. This is offline fixture mode; no market analysis ran.`,
      );
    const accounts = output.state?.accounts.filter((a) => a.active) ?? [];
    const matching = accounts.filter(
      (a) =>
        text.toLowerCase().includes(a.displayName.toLowerCase()) ||
        text.includes(a.accountKey),
    );
    const account =
      matching.length === 1
        ? matching[0]
        : accounts.length === 1
          ? accounts[0]
          : undefined;
    if (!account)
      return reply(
        'Which account should this change apply to? Please use its displayed account name.',
      );
    const instrument = output.state?.positions.find(
      (p) =>
        p.accountKey === account.accountKey &&
        p.instrument.assetType !== 'OPTION' &&
        text.toUpperCase().includes(String(p.instrument.symbol)),
    )?.instrument;
    const common = {
      effectiveAt: new Date().toISOString(),
      note: message.slice(0, 1000),
      accountKey: account.accountKey,
    };
    const cash = text.match(
      /\b(deposit|withdraw)\s+\$?(\d+(?:\.\d+)?)\s*(USD|CAD)\b/i,
    );
    if (cash)
      return call('portfolio_preview_v1', {
        covered: false,
        operation: {
          ...common,
          kind:
            cash[1]!.toLowerCase() === 'deposit'
              ? 'CASH_DEPOSIT'
              : 'CASH_WITHDRAW',
          currency: cash[3]!.toUpperCase(),
          amount: cash[2],
        },
      });
    const fees = /no fees|zero fees/i.test(text)
      ? '0'
      : text.match(/fees?\s*[:=]?\s*\$?(\d+(?:\.\d+)?)/i)?.[1];
    const option = text.match(/sell to open\s+(\d+)\s+(?:covered\s+)?calls?/i);
    const trade = text.match(
      /\b(buy|sell)\s+(\d+(?:\.\d+)?)\s+(?:shares?\s+(?:of\s+)?)?([A-Z][A-Z0-9.]*)\b/i,
    );
    const price = text.match(/(?:\bat\b|premium)\s*\$?(\d+(?:\.\d+)?)/i)?.[1];
    if (option) {
      const expiry = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0],
        strike = text.match(/strike\s*\$?(\d+(?:\.\d+)?)/i)?.[1];
      if (
        !instrument ||
        !expiry ||
        !strike ||
        !price ||
        fees === undefined ||
        !/standard.*100|100.*standard/i.test(text)
      )
        return reply(
          'Please specify the underlying symbol, full expiry date, strike, premium per share, fees (or no fees), and verify a standard 100-share contract.',
        );
      return call('portfolio_preview_v1', {
        covered: /covered/i.test(text),
        operation: {
          ...common,
          kind: 'OPTION_STO',
          quantity: option[1],
          price,
          fees,
          instrument: {
            ...instrument,
            assetType: 'OPTION',
            underlying: instrument.symbol,
            optionRight: 'CALL',
            expiry,
            strike,
            multiplier: '100',
            deliverable: 'STANDARD',
          },
        },
      });
    }
    if (trade && instrument && price && fees !== undefined)
      return call('portfolio_preview_v1', {
        covered: false,
        operation: {
          ...common,
          kind: trade[1]!.toLowerCase() === 'buy' ? 'STOCK_BUY' : 'STOCK_SELL',
          instrument,
          quantity: trade[2],
          price,
          fees,
        },
      });
    return reply(
      'Please specify the account, security, quantity, reported unit price and fees. Fixture mode supports explicit buy/sell, deposit/withdraw and covered-call examples; it never guesses missing amounts.',
    );
  }
  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const response = await this.generate(request, signal);
    for (const item of response.items)
      if (item.kind === 'text')
        for (const word of item.text.match(/\S+\s*/g) ?? []) {
          if (signal?.aborted) throw new LlmError('LLM_CANCELLED', 'Cancelled');
          yield { type: 'text_delta', delta: word };
        }
    yield { type: 'result', result: response };
  }
}
export function createLlmProvider(
  config: { LLM_PROVIDER: string; LLM_MODEL: string },
  key?: string,
): LlmProvider {
  if (config.LLM_PROVIDER === 'fixture') {
    if (config.LLM_MODEL !== 'fixture-v1')
      throw new LlmError(
        'LLM_CAPABILITY_UNSUPPORTED',
        'Fixture provider requires fixture-v1.',
      );
    return new ChatFixtureProvider();
  }
  if (config.LLM_PROVIDER === 'openai') return new OpenAiProvider(key ?? '');
  throw new LlmError(
    'LLM_PROVIDER_NOT_IMPLEMENTED',
    'The selected provider is not implemented; no fallback was used.',
  );
}
