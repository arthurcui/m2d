import { randomUUID } from 'node:crypto';
import {
  LlmError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelEvent,
} from './contracts.js';
import { OpenAiProvider } from './openai.js';
import { fixtureEmbeddings } from './fixture-embeddings.js';
export class ChatFixtureProvider implements LlmProvider {
  async embed(...args: Parameters<typeof fixtureEmbeddings>) {
    return fixtureEmbeddings(...args);
  }
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
    const user = request.history[last];
    const valuationQuestion =
      user?.kind === 'text' &&
      /\b(nav|valuation|portfolio worth|unrealized)\b/i.test(user.text) &&
      !/\b(buy|bought|sell|sold)\b/i.test(user.text);
    const researchQuestion =
      user?.kind === 'text' &&
      /Research context:|stored research|research documents/i.test(user.text);
    if (researchQuestion) {
      const symbol = (
        /Research context: ([A-Z0-9.-]+)/.exec(user.text)?.[1] ?? 'TSLA'
      ).replace(/\.$/, '');
      if (!result)
        return call('research_search_evidence_v2', {
          symbol,
          query: /Review the stored research/.test(user.text)
            ? 'revenue OR risk OR outlook'
            : user.text
                .replace(/^Research context:[^\n]*\n/, '')
                .split('\n')[0]!
                .slice(0, 500),
        });
      const output = result.output as {
        hits?: {
          document_id: string;
          title: string;
          text: string;
          chunk_index: number;
          provider: string;
          available_at: string;
        }[];
        error?: { message: string };
      };
      if (output.error) return reply(output.error.message);
      const rows = output.hits ?? [];
      const source = rows[0];
      return source
        ? reply(
            `Synthetic fixture research. The retrieved source states: ${source.text.slice(0, 220)} [${source.title}](/research?document=${source.document_id}#chunk-${source.chunk_index}). Available: ${source.available_at}. This quote is evidence, not a trading recommendation. Interpretation: inspect the changed outlook and concentration risks before deciding. NO_SIGNAL: no executable strategy is evaluated.`,
          )
        : reply(
            'NO_SIGNAL: No matching stored research. Import reports on Research first.',
          );
    }
    if (!result)
      return call(
        valuationQuestion ? 'market_valuation_read_v1' : 'portfolio_read_v1',
        {},
      );
    if (valuationQuestion) {
      const value = result.output as {
        nav?: string | null;
        knownValue?: string;
        baseCurrency?: string;
        quality?: string;
        oldestAsOf?: string | null;
        error?: { message: string };
      };
      if (value.error) return reply(value.error.message);
      return reply(
        `Stored portfolio valuation: ${value.nav ?? `incomplete (known subtotal ${value.knownValue ?? 'unknown'})`} ${value.baseCurrency ?? ''}. Quality: ${value.quality ?? 'unknown'}. Oldest price: ${value.oldestAsOf ?? 'no market evidence'}. Fixture prices are synthetic, never actual market values. Historical returns and pre-baseline realized P&L are unknown.`,
      );
    }
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
          instrumentKey?: string;
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
        'id' in i.output &&
        !(
          'operation' in i.output &&
          i.output.operation &&
          typeof i.output.operation === 'object' &&
          'kind' in i.output.operation &&
          i.output.operation.kind === 'NOTE_ONLY'
        ),
    );
    const currentUser = request.history[last];
    const currentContext =
      currentUser?.kind === 'text' ? currentUser.holdingContext : undefined;
    const changedContext = request.history.findLastIndex(
      (i) =>
        i.kind === 'text' &&
        i.role === 'user' &&
        JSON.stringify(i.holdingContext) !== JSON.stringify(currentContext),
    );
    const text = request.history
      .slice(Math.max(lastPreview, changedContext) + 1)
      .filter((i) => i.kind === 'text' && i.role === 'user')
      .map((i) => (i.kind === 'text' ? i.text : ''))
      .join('\n');
    const latest = request.history[last];
    const message = latest?.kind === 'text' ? latest.text : '';
    if (/research|recommend|signal|price now|live|opportunit/i.test(message))
      return reply(
        'NO_SIGNAL — research and actionable trade recommendations are unavailable. Stored indicative valuation can be inspected with its source and freshness labels; it is not an execution quote.',
      );
    if (!/buy|bought|sell|sold|deposit|withdraw|cash|covered call/i.test(text))
      return reply(
        `Your self-reported portfolio has ${output.state?.accounts.filter((a) => a.active).length ?? 0} active accounts and ${output.state?.positions.length ?? 0} holdings. This is offline fixture mode; no market analysis ran.`,
      );
    const selected =
      latest?.kind === 'text' ? latest.holdingContext : undefined;
    const selectedPosition = selected
      ? output.state?.positions.find(
          (p) =>
            p.accountKey === selected.accountKey &&
            p.instrumentKey === selected.instrumentKey,
        )
      : undefined;
    const accounts = output.state?.accounts.filter((a) => a.active) ?? [];
    const matching = accounts.filter(
      (a) =>
        text.toLowerCase().includes(a.displayName.toLowerCase()) ||
        text.includes(a.accountKey),
    );
    const account = selected
      ? accounts.find((a) => a.accountKey === selected.accountKey)
      : matching.length === 1
        ? matching[0]
        : accounts.length === 1
          ? accounts[0]
          : undefined;
    if (!account)
      return reply(
        'Which account should this change apply to? Please use its displayed account name.',
      );
    const instrument =
      selectedPosition?.instrument ??
      output.state?.positions.find(
        (p) =>
          p.accountKey === account.accountKey &&
          p.instrument.assetType !== 'OPTION' &&
          text.toUpperCase().includes(String(p.instrument.symbol)),
      )?.instrument;
    if (
      selected &&
      !selected.instrumentKey &&
      !instrument &&
      /sell|sold|buy|bought/i.test(text)
    )
      return reply(
        'Which security in the selected account was traded? Please include its symbol, price and fees if not already supplied.',
      );
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
      /\b(buy|bought|sell|sold)\s+(\d+(?:\.\d+)?)\s+(?:shares?\s+(?:of\s+)?)?([A-Z][A-Z0-9.]*)\b/i,
    );
    const selectedTrade = selected
      ? text.match(
          /\b(buy|bought|sell|sold)\s+(\d+(?:\.\d+)?)\s+(?:shares?|contracts?)\b/i,
        )
      : null;
    const effectiveTrade = selectedTrade ?? trade;
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
    if (selected && effectiveTrade && (!price || fees === undefined))
      return reply(
        'What was the sale or purchase price per share, and the fees (or no fees)? I have the selected account, security and quantity.',
      );
    if (
      effectiveTrade &&
      instrument?.assetType !== 'OPTION' &&
      instrument &&
      price &&
      fees !== undefined
    )
      return call('portfolio_preview_v1', {
        covered: false,
        operation: {
          ...common,
          kind: ['buy', 'bought'].includes(effectiveTrade[1]!.toLowerCase())
            ? 'STOCK_BUY'
            : 'STOCK_SELL',
          instrument,
          quantity: effectiveTrade[2],
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
