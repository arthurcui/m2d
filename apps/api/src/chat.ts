import type { RiskService } from './risk.js';
import type { ResearchService } from './research.js';
import type { FastifyInstance } from 'fastify';
import type { MarketService } from './market.js';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { ChatRepository, PortfolioRepository } from '@m2d/db';
import type { Config } from '@m2d/config';
import {
  createLlmProvider,
  LlmError,
  type LlmProvider,
  type CanonicalItem,
} from '@m2d/llm';
import {
  chatContexts,
  chatRequestSchema,
  chatPromptVersion,
  modePolicyVersion,
  resolvePolicy,
  selectMode,
  runChat,
} from '@m2d/agent';
import { PortfolioError } from '@m2d/portfolio';
export async function chatRoutes(
  app: FastifyInstance,
  {
    repository: r,
    portfolio,
    config,
    key,
    provider: override,
    market,
    research,
    risk,
  }: {
    repository: ChatRepository;
    portfolio: PortfolioRepository;
    config: Config;
    key?: string;
    provider?: LlmProvider;
    market?: MarketService;
    research?: ResearchService;
    risk?: RiskService;
  },
) {
  const running = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  app.addHook('onClose', async () => {
    for (const { controller } of running.values()) controller.abort();
    await Promise.allSettled([...running.values()].map((v) => v.task));
  });
  app.addHook('onRequest', async (req, reply) => {
    if (['POST', 'PATCH'].includes(req.method) && req.headers.origin)
      return reply.code(403).send({
        error: {
          code: 'ORIGIN_REJECTED',
          message: 'Use the same-origin application proxy.',
        },
      });
  });
  const context = (params: unknown) =>
    z.object({ context: z.enum(chatContexts) }).parse(params).context;
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  const envelope = (data: unknown) => ({
    data,
    meta: {
      version: 1,
      asOf: new Date().toISOString(),
      dataQuality: 'SELF_REPORTED',
    },
  });
  app.get('/api/v1/settings/analysis', async () => {
    const saved = await r.settings();
    return envelope({
      ...saved,
      effectiveDefault:
        saved.defaultAnalysisMode ?? config.ANALYSIS_MODE_DEFAULT,
      policyVersion: modePolicyVersion,
    });
  });
  app.patch('/api/v1/settings/analysis', async (req) => {
    const input = z
      .object({
        version: z.literal(1),
        expectedRevision: z.number().int().nonnegative(),
        defaultAnalysisMode: z
          .enum(['quick', 'standard', 'extensive'])
          .optional(),
        outputLanguage: z.enum(['en', 'zh-CN']).optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.defaultAnalysisMode !== undefined || v.outputLanguage !== undefined,
        'Choose a mode or output language.',
      )
      .parse(req.body);
    return envelope(
      await r.updateSettings(
        input.expectedRevision,
        input.defaultAnalysisMode,
        input.outputLanguage,
      ),
    );
  });
  app.get('/api/v1/chat/sessions/:context', async (req) =>
    envelope({
      ...(await r.session(context(req.params))),
      dailyUsage: await r.dailyUsage(),
      dailyBudget: config.LLM_DAILY_BUDGET_USD ?? null,
    }),
  );
  app.post('/api/v1/chat/sessions/:context/reset', async (req) => {
    await r.reset(context(req.params));
    return envelope({
      ...(await r.session(context(req.params))),
      dailyUsage: await r.dailyUsage(),
      dailyBudget: config.LLM_DAILY_BUDGET_USD ?? null,
    });
  });
  app.patch('/api/v1/chat/sessions/:context', async (req) => {
    const input = z
      .object({
        version: z.literal(1),
        draft: z.string().max(4000),
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(req.body);
    return envelope(
      await r.draft(context(req.params), input.draft, input.expectedRevision),
    );
  });
  app.get('/api/v1/chat/runs/:id', async (req) =>
    envelope(await r.getRun(id(req.params))),
  );
  app.post('/api/v1/chat/runs/:id/cancel', async (req) => {
    const runId = id(req.params);
    await r.cancel(runId);
    running.get(runId)?.controller.abort();
    return envelope(await r.getRun(runId));
  });
  app.get('/api/v1/chat/runs/:id/events', async (req, reply) => {
    const runId = id(req.params);
    await r.getRun(runId);
    const query = z
      .object({ after: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    let cursor = Math.max(
      query.after,
      Number(req.headers['last-event-id']) || 0,
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let disconnected = false;
    reply.raw.on('close', () => {
      disconnected = true;
    });
    try {
      while (!disconnected) {
        const run = await r.getRun(runId),
          events = run.events as Record<string, unknown>[];
        for (; cursor < events.length; cursor++) {
          if (
            !reply.raw.write(
              `id: ${cursor + 1}\ndata: ${JSON.stringify(events[cursor])}\n\n`,
            )
          )
            await new Promise<void>((resolve) => {
              const done = () => {
                reply.raw.off('drain', done);
                reply.raw.off('close', done);
                resolve();
              };
              reply.raw.once('drain', done);
              reply.raw.once('close', done);
            });
        }
        if (run.status !== 'running') {
          reply.raw.write(
            `event: terminal\ndata: ${JSON.stringify({ status: run.status, previewId: run.previewId, limitReasons: run.limitReasons })}\n\n`,
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      reply.raw.end();
    }
  });
  app.post('/api/v1/chat/sessions/:context/runs', async (req, reply) => {
    const input = chatRequestSchema.parse(req.body),
      ctx = context(req.params),
      saved = await r.settings();
    const mode = selectMode(
      input.analysisMode,
      saved.defaultAnalysisMode,
      config.ANALYSIS_MODE_DEFAULT,
    );
    const limits = resolvePolicy(mode, {
      modelCalls: config.LLM_MAX_STEPS,
      toolCalls: config.LLM_MAX_TOOL_CALLS,
      deadlineMs: config.LLM_RUN_TIMEOUT_MS,
      maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
      maxInputCharacters: config.LLM_MAX_INPUT_CHARACTERS,
      maxRunCost: config.LLM_MAX_RUN_COST_USD ?? null,
      dailyBudget: config.LLM_DAILY_BUDGET_USD ?? null,
    });
    const provider = override ?? createLlmProvider(config, key);
    const caps = provider.capabilities(config.LLM_MODEL);
    if (
      !caps.tools ||
      !caps.structuredOutput ||
      !caps.streaming ||
      !provider.stream
    )
      throw new PortfolioError(
        'LLM_CAPABILITY_UNSUPPORTED',
        'Selected model does not support the required chat capabilities.',
      );
    const priced =
      provider.id === 'fixture' ||
      !!(
        config.LLM_INPUT_USD_PER_MILLION &&
        config.LLM_OUTPUT_USD_PER_MILLION &&
        config.LLM_PRICE_VERSION
      );
    if (!priced && (limits.maxRunCost || limits.dailyBudget))
      throw new PortfolioError(
        'PRICE_DATA_UNAVAILABLE',
        'Configured cost limits require backend input/output price rates and a price version. No inference ran.',
      );
    const overview = await portfolio.overview();
    const claimed = await r.claim({
      context: ctx,
      requestKey: input.idempotencyKey,
      message: input.researchContext
        ? `Research context: ${input.researchContext.symbol}${input.researchContext.at ? '; evidence available by ' + input.researchContext.at : ''}.\n${input.message}`
        : input.message,
      ...(input.holdingContext
        ? {
            holdingContext: {
              accountKey: input.holdingContext.accountKey,
              ...(input.holdingContext.instrumentKey
                ? { instrumentKey: input.holdingContext.instrumentKey }
                : {}),
            },
          }
        : {}),
      ...(input.analysisMode ? { requestedMode: input.analysisMode } : {}),
      ...(input.outputLanguage
        ? { requestedLanguage: input.outputLanguage }
        : {}),
      outputLanguage: input.outputLanguage ?? saved.outputLanguage,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      provider: provider.id,
      model: config.LLM_MODEL,
      analysisMode: mode,
      policyVersion: modePolicyVersion,
      promptVersion: chatPromptVersion,
      adapterVersion: provider.adapterVersion,
      effectiveLimits: { ...limits },
      portfolioRevision: overview.revision,
      priceVersion:
        provider.id === 'fixture'
          ? 'fixture-zero'
          : (config.LLM_PRICE_VERSION ?? null),
    });
    if (!claimed.lease) return envelope(claimed.run);
    const { lease, run } = claimed;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), limits.deadlineMs);
    const started = Date.now();
    const charge = (inputTokens: number, outputTokens: number) =>
      provider.id === 'fixture'
        ? '0'
        : new Decimal(inputTokens)
            .mul(config.LLM_INPUT_USD_PER_MILLION ?? 0)
            .add(
              new Decimal(outputTokens).mul(
                config.LLM_OUTPUT_USD_PER_MILLION ?? 0,
              ),
            )
            .div(1000000)
            .toFixed();
    let reservation = '0',
      history: CanonicalItem[] = lease.history;
    const staged: string[] = [];
    const task = (async () => {
      try {
        const prior = lease.continuation;
        const continuation =
          prior &&
          prior.provider === provider.id &&
          prior.model === config.LLM_MODEL &&
          prior.adapterVersion === provider.adapterVersion
            ? prior
            : undefined;
        const result = await runChat(
          {
            runId: run.id,
            model: config.LLM_MODEL,
            provider,
            history,
            mode,
            outputLanguage: run.outputLanguage === 'zh-CN' ? 'zh-CN' : 'en',
            limits,
            signal: controller.signal,
            riskOnly: ctx === 'risk',
            ...(ctx === 'research'
              ? {
                  researchScope: {
                    query: input.message,
                    ...(input.researchContext?.symbol
                      ? { symbol: input.researchContext.symbol }
                      : {}),
                    ...(input.researchContext?.at
                      ? { at: input.researchContext.at }
                      : {}),
                  },
                }
              : {}),
            ...(continuation ? { continuation } : {}),
          },
          {
            overview: () => portfolio.overview(),
            ...(research
              ? {
                  research: (
                    name: string,
                    args: unknown,
                    beforeEmbedding: () => void,
                  ) =>
                    research.tool(name, args, input.researchContext?.at, {
                      agentRunId: run.id,
                      signal: controller.signal,
                      before: async (cost) => {
                        beforeEmbedding();
                        await r.reserve(
                          run.id,
                          cost,
                          limits.maxRunCost,
                          limits.dailyBudget,
                        );
                      },
                      after: async (tokens, reserved, actual) => {
                        await r.recordUsage(
                          run.id,
                          tokens === null
                            ? null
                            : { inputTokens: tokens, outputTokens: 0 },
                          reserved,
                          actual,
                        );
                        await r.event(run.id, {
                          type: 'search_embedding_usage',
                          inputTokens: tokens,
                          estimatedCost: actual,
                        });
                      },
                    }),
                }
              : {}),
            ...(market ? { valuation: () => market.valuation() } : {}),
            ...(risk
              ? { risk: (name: string, args: unknown) => risk.tool(name, args) }
              : {}),
            preview: async (data) => {
              const preview = await portfolio.preview(data);
              staged.push(preview.id);
              return preview;
            },
            tool: (callId, args, execute) =>
              r.tool(run.id, callId, args, execute),
            emit: (event) => r.event(run.id, event),
            checkpoint: async (items, c) => {
              history = items;
              await r.checkpoint(run.id, items, c);
            },
            reserve: async (characters, tokens) => {
              const state = await r.getRun(run.id);
              if (state.cancelRequested) controller.abort();
              if (controller.signal.aborted)
                throw new LlmError('LLM_CANCELLED', 'Run cancelled.');
              reservation = priced ? charge(characters * 4, tokens) : '0';
              await r.reserve(
                run.id,
                reservation,
                limits.maxRunCost,
                limits.dailyBudget,
              );
            },
            usage: (usage) =>
              r.recordUsage(
                run.id,
                usage,
                reservation,
                priced && usage
                  ? charge(usage.inputTokens, usage.outputTokens)
                  : null,
              ),
          },
        );
        if (controller.signal.aborted)
          throw new LlmError('LLM_CANCELLED', 'Run cancelled.');
        await r.finish(
          run.id,
          'completed',
          result.limitReason,
          result.previewId,
          {
            type: 'completed',
            previewId: result.previewId,
            attempts: result.attempts,
            toolCalls: result.toolCalls,
          },
        );
      } catch (e) {
        for (const previewId of staged)
          await portfolio.reject(previewId).catch(() => undefined);
        const timedOut = Date.now() - started >= limits.deadlineMs,
          code = timedOut
            ? 'LLM_BUDGET'
            : e instanceof LlmError || e instanceof PortfolioError
              ? e.code
              : 'AGENT_FAILED';
        const message =
          e instanceof LlmError || e instanceof PortfolioError
            ? e.message
            : 'Advisor could not finish. No change was committed.';
        // Keep canonical history provider-valid after interrupted tool batches.
        const answered = new Set(
          history.filter((i) => i.kind === 'tool_result').map((i) => i.callId),
        );
        for (const call of history.filter((i) => i.kind === 'tool_call'))
          if (!answered.has(call.callId))
            history.push({
              id: crypto.randomUUID(),
              kind: 'tool_result',
              callId: call.callId,
              output: { error: { code, message } },
            });
        history.push({
          id: crypto.randomUUID(),
          kind: 'text',
          role: 'assistant',
          text: /No (?:financial|portfolio) changes? (?:were|was) committed\./.test(
            message,
          )
            ? message
            : `${message} No portfolio change was committed.`,
        });
        await r.checkpoint(run.id, history, undefined);
        await r.finish(
          run.id,
          code === 'LLM_CANCELLED' ? 'cancelled' : 'failed',
          code,
          null,
          {
            type: 'error',
            code,
            message,
            ...(e instanceof LlmError && e.diagnostics
              ? { diagnostics: e.diagnostics }
              : {}),
          },
        );
      } finally {
        clearTimeout(deadline);
        await lease.release();
        running.delete(run.id);
      }
    })();
    running.set(run.id, { controller, task });
    void task.catch(() =>
      app.log.error('Advisor run persistence failed; recovery required.'),
    );
    return reply.code(202).send(envelope(run));
  });
}
