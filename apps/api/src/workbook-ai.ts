import { z } from 'zod';
import type { Config } from '@m2d/config';
import type { PortfolioRepository } from '@m2d/db';
import { PortfolioError, accountDecisionSchema } from '@m2d/portfolio';
import {
  LlmError,
  OpenAiProvider,
  supportedModels,
  type LlmProvider,
} from '@m2d/llm';
import {
  accountBindings,
  bindAccountMapping,
  prepareWorkbook,
  validateInterpretation,
  fixtureForInspection,
  limits,
  PROMPT_VERSION,
  learnImportMemory,
  recallImportMemory,
  workbookDialogueSchema,
  interpretationSchema,
  asksForExplanation,
  explainWorkbookQuestion,
  nextWorkbookQuestion,
  scopedAnswer,
  repeatedQuestion,
  repeatedQuestionReply,
  isInternalWorkbookQuestion,
  workbookRowReply,
  workbookQuestionLocation,
} from '@m2d/agent';
import { resolveWorkbook } from '@m2d/ingestion';

export const parseWorkbookRequest = z
  .object({
    version: z.literal(1),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.uuid(),
    clarification: z.string().max(4000).default(''),
    dialogue: workbookDialogueSchema.optional(),
    retry: z.boolean().default(false),
    accountDecisions: z.array(accountDecisionSchema).max(100).default([]),
  })
  .strict();
export function createWorkbookAi(
  r: PortfolioRepository,
  config: Config,
  key: string | undefined,
  provided?: LlmProvider,
) {
  const available =
    config.LLM_PROVIDER === 'openai' &&
    !!key?.trim() &&
    supportedModels.includes(config.LLM_MODEL);
  const status = {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    available,
    status:
      config.LLM_PROVIDER === 'fixture'
        ? 'fixture_only'
        : config.LLM_PROVIDER !== 'openai'
          ? 'not_implemented'
          : available
            ? 'ready'
            : 'unconfigured',
    message:
      config.LLM_PROVIDER === 'fixture'
        ? 'Offline deterministic workbook demo; no model calls.'
        : available
          ? 'AI workbook parsing is configured. Agent chat is available separately.'
          : 'Workbook AI is unavailable. Configure a supported OpenAI model and a backend API key.',
  };
  return {
    status,
    async parse(id: string, raw: z.input<typeof parseWorkbookRequest>) {
      if (
        config.LLM_PROVIDER !== 'fixture' &&
        (config.LLM_MAX_RUN_COST_USD || config.LLM_DAILY_BUDGET_USD)
      )
        throw new PortfolioError(
          'WORKBOOK_COST_ACCOUNTING_UNAVAILABLE',
          'Paid workbook parsing is disabled while chat cost caps are enabled. Its separate M1 pipeline cannot bypass the deployment budget.',
        );
      const input = parseWorkbookRequest.parse(raw);
      // Older clients can resend the last explanation when retrying an empty
      // draft. Retry parsing with accepted facts, not that stale question.
      if (
        input.retry &&
        input.dialogue &&
        (isInternalWorkbookQuestion(input.dialogue.question) ||
          asksForExplanation(input.dialogue.message))
      )
        input.dialogue = undefined;
      let acceptedClarification = input.clarification;
      const clarification = [
        input.clarification,
        input.accountDecisions.length
          ? 'Confirmed account choices: ' +
            JSON.stringify(input.accountDecisions)
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const latest = await r.getImport(id);
      if (latest.preview?.status === 'CONFIRMED')
        return {
          ...latest,
          ai: {
            status: 'completed',
            questions: [],
            provider: config.LLM_PROVIDER,
            model: config.LLM_MODEL,
          },
          exclusions: [],
        };
      const overview = await r.overview();
      if (overview.revision !== input.expectedRevision)
        throw new PortfolioError(
          'REVISION_CONFLICT',
          'Portfolio changed. Reload records before parsing again.',
          409,
        );
      if (config.LLM_PROVIDER !== 'fixture' && !available && !provided)
        throw new PortfolioError('LLM_UNCONFIGURED', status.message, 503);
      if (
        config.LLM_PROVIDER === 'fixture' &&
        config.LLM_MODEL !== 'fixture-v1'
      )
        throw new PortfolioError(
          'LLM_CAPABILITY_UNSUPPORTED',
          'Fixture mode requires fixture-v1.',
          503,
        );
      const source = await r.importSource(id);
      let prepared;
      try {
        prepared = await prepareWorkbook(
          source.bytes,
          overview.state.accounts,
          clarification,
          config.LLM_MODEL,
          input.dialogue,
        );
      } catch (e) {
        throw new PortfolioError(
          e instanceof LlmError ? e.code : 'INVALID_WORKBOOK',
          e instanceof LlmError
            ? e.message
            : 'Cannot safely read this workbook.',
          400,
        );
      }
      const aliases = await r.accountAliases();
      if (input.dialogue && !input.retry) {
        const internal = isInternalWorkbookQuestion(input.dialogue.question);
        const asksRow =
          /\b(which|what|show|identify)\b.*\b(row|line|holding)\b/i.test(
            input.dialogue.message,
          ) || /^please[.!]?$/i.test(input.dialogue.message.trim());
        if (internal || asksRow) {
          const location = workbookQuestionLocation(
            input.dialogue.question,
            prepared.inspection,
          );
          const needsReview = internal || !location.sheet || !location.row;
          return {
            id,
            preview: null,
            errors: [],
            sources: [],
            exclusions: [],
            acceptedClarification,
            ai: {
              status: needsReview ? 'needs_review' : 'needs_clarification',
              provider: 'workbook-review',
              model: 'deterministic',
              asOf: new Date().toISOString(),
              questions: needsReview ? [] : [input.dialogue.question],
              intent: 'explain',
              reply: internal
                ? 'That was an application error, not a question you need to answer. Agent produced an invalid mapping. Import is blocked until it passes validation; it is not merely a review notice. Select Retry interpretation to continue with your existing account choices and accepted answers. Nothing has been committed.'
                : workbookRowReply(
                    input.dialogue.question,
                    prepared.inspection,
                  ),
            },
          };
        }
      }
      const identity = accountBindings(
        prepared.inspection,
        overview.state.accounts,
        aliases,
        input.accountDecisions,
      );
      if (identity.pending.length)
        return {
          id,
          preview: null,
          errors: [],
          sources: [],
          exclusions: [],
          ai: {
            status: 'needs_clarification',
            provider: 'account-review',
            model: 'deterministic',
            questions: [],
            message: 'Choose what each unfamiliar account tab represents.',
            accountQuestions: identity.pending.map((sheet) => ({
              sheet,
              accounts: overview.state.accounts.map((a) => ({
                accountKey: a.accountKey,
                displayName: a.displayName,
                institution: a.institution,
              })),
            })),
          },
        };
      prepared.inspection.mapping = bindAccountMapping(
        prepared.inspection.mapping,
        identity.bindings,
        input.accountDecisions,
      );
      let confirmedMemory: unknown;
      const seenProfiles = new Set<string>();
      for (const saved of await r.importMemories()) {
        if (seenProfiles.has(saved.signature)) continue;
        seenProfiles.add(saved.signature);
        let mapping = recallImportMemory(saved.profile, prepared.inspection);
        if (!mapping) continue;
        mapping = bindAccountMapping(
          mapping,
          identity.bindings,
          input.accountDecisions,
        );
        confirmedMemory = saved.profile;
        prepared.inspection.mapping = mapping;
        const item = prepared.request.history[0];
        if (item?.kind === 'text') {
          const payload = JSON.parse(item.text) as Record<string, unknown>;
          payload.suggestedMapping = mapping;
          payload.confirmedInterpretationRules = mapping.overrides;
          item.text = JSON.stringify(payload);
          if (item.text.length > limits.maxInputCharacters)
            throw new PortfolioError(
              'LLM_INPUT_LIMIT',
              'Workbook and confirmed interpretation rules exceed the configured input limit. No rules or source rows were silently dropped.',
              400,
            );
        }
        if (input.clarification || input.dialogue) break;
        const result = await resolveWorkbook(
          source.bytes,
          mapping,
          overview.state.accounts,
        );
        if (!result.state) break;
        const memory = learnImportMemory(
          prepared.inspection,
          mapping,
          saved.profile,
        );
        const mapped = await r.mapImport(id, {
          ...result,
          mapping,
          expectedRevision: overview.revision,
          ...(memory ? { memory } : {}),
          warnings: [
            ...result.warnings,
            'Agent reused a previously confirmed format. Current workbook values were read again; review before confirming.',
          ],
        });
        return {
          ...mapped,
          exclusions: mapping.excludedRows.map((e) => ({
            ...e,
            values:
              prepared.inspection.sheets.find((s) => s.name === e.sheet)?.rows[
                e.row - 1
              ] ?? [],
          })),
          ai: {
            status: 'completed',
            questions: [],
            provider: 'remembered',
            model: 'format-v2',
            asOf: saved.createdAt,
            message:
              'Agent remembered this format. Please confirm the updated portfolio.',
          },
        };
      }
      const provider =
        provided ??
        (config.LLM_PROVIDER === 'fixture'
          ? fixtureForInspection(prepared.inspection, overview.state.accounts)
          : new OpenAiProvider(key!));
      if (!provider.capabilities(config.LLM_MODEL).structuredOutput)
        throw new PortfolioError(
          'LLM_CAPABILITY_UNSUPPORTED',
          'The configured model does not support this workbook schema.',
          503,
        );
      const run = await r.runImportParse(
        {
          importId: id,
          requestKey: input.idempotencyKey,
          provider: provider.id,
          model: config.LLM_MODEL,
          retry: input.retry,
          fingerprintData: {
            revision: input.expectedRevision,
            clarification,
            dialogue: input.dialogue,
            promptVersion: PROMPT_VERSION,
            defaultExpiryYear: prepared.defaultExpiryYear,
            adapterVersion: provider.adapterVersion,
          },
          request: {
            ...prepared.request,
            promptVersion: PROMPT_VERSION,
            schemaVersion: 1,
            adapterVersion: provider.adapterVersion,
            portfolioRevision: overview.revision,
            policy: 'workbook-v1',
            effectiveLimits: limits,
            costCap: null,
          },
        },
        async () => {
          try {
            return await provider.generate(
              prepared.request,
              AbortSignal.timeout(limits.timeoutMs),
            );
          } catch (e) {
            throw new PortfolioError(
              e instanceof LlmError ? e.code : 'LLM_UNAVAILABLE',
              e instanceof LlmError
                ? e.message
                : 'AI parsing failed. No portfolio changes were made.',
              503,
            );
          }
        },
      );
      const meta = {
        runId: run.id,
        provider: run.provider,
        model: run.model,
        asOf: run.finishedAt,
      };
      if (run.status === 'FAILED')
        return {
          id,
          preview: null,
          errors: [],
          sources: [],
          exclusions: [],
          ai: {
            ...meta,
            status: 'failed',
            questions: [],
            message: run.errorMessage,
            code: run.errorCode,
          },
        };
      try {
        const response = z
          .object({
            status: z.enum(['completed', 'refused', 'incomplete']),
            structuredOutput: z.unknown(),
          })
          .parse(run.response);
        if (response.status === 'completed' && input.dialogue) {
          const parsedOutput = interpretationSchema.safeParse(
            response.structuredOutput,
          );
          const output = parsedOutput.success ? parsedOutput.data : null;
          if (
            input.dialogue.explain ||
            asksForExplanation(input.dialogue.message) ||
            output?.intent === 'explain'
          ) {
            // An explanation is audited but never remaps the upload, replaces
            // staging, generates a preview, or becomes financial evidence.
            return {
              id,
              preview: null,
              errors: [],
              sources: [],
              exclusions: [],
              acceptedClarification,
              ai: {
                ...meta,
                status: 'needs_clarification',
                questions: input.dialogue.question
                  ? [input.dialogue.question]
                  : [],
                reply:
                  output?.intent === 'explain' && output.reply.trim()
                    ? output.reply
                    : explainWorkbookQuestion(input.dialogue.question),
                intent: 'explain',
              },
            };
          }
          acceptedClarification = [
            input.clarification,
            scopedAnswer(input.dialogue.question, input.dialogue.message),
          ]
            .filter(Boolean)
            .join('\n');
          if (acceptedClarification.length > 4000)
            throw new PortfolioError(
              'CLARIFICATION_LIMIT',
              'The workbook answers have reached the length limit. Correct the workbook and upload it again; no answers were discarded.',
              400,
            );
        }
        const evidence = [
          acceptedClarification,
          input.accountDecisions.length
            ? 'Confirmed account choices: ' +
              JSON.stringify(input.accountDecisions)
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        let result = await validateInterpretation(
          response,
          source.bytes,
          prepared.inspection,
          evidence,
          overview.state.accounts,
        );
        let bound = bindAccountMapping(
          result.mapping,
          identity.bindings,
          input.accountDecisions,
        );
        const finalIdentity = accountBindings(
          {
            ...prepared.inspection,
            // A model may omit or exclude a previously reviewed tab. That
            // affects mapping coverage, never the validity of the user's
            // account choices for the original workbook.
            mapping: {
              ...bound,
              tables: [...prepared.inspection.mapping.tables, ...bound.tables],
            },
          },
          overview.state.accounts,
          aliases,
          input.accountDecisions,
        );
        if (finalIdentity.pending.length)
          return {
            id,
            preview: null,
            errors: [],
            sources: [],
            exclusions: [],
            ai: {
              status: 'needs_clarification',
              provider: 'account-review',
              model: 'deterministic',
              questions: [],
              message: 'Choose what each unfamiliar account tab represents.',
              accountQuestions: finalIdentity.pending.map((sheet) => ({
                sheet,
                accounts: overview.state.accounts.map((a) => ({
                  accountKey: a.accountKey,
                  displayName: a.displayName,
                  institution: a.institution,
                })),
              })),
            },
          };
        bound = bindAccountMapping(
          bound,
          finalIdentity.bindings,
          input.accountDecisions,
        );
        const resolved = await resolveWorkbook(
          source.bytes,
          bound,
          overview.state.accounts,
        );
        result = {
          ...result,
          ...resolved,
          mapping: bound,
          state: result.questions.length ? null : resolved.state,
          warnings: [...new Set([...result.warnings, ...resolved.warnings])],
        };
        const memory =
          result.state && !result.questions.length
            ? learnImportMemory(
                prepared.inspection,
                result.mapping,
                confirmedMemory,
              )
            : null;
        const mapped = await r.mapImport(id, {
          ...result,
          warnings: [
            ...result.warnings,
            ...(memory
              ? [
                  `After confirmation, Agent will save this format and ${memory.rules?.length ?? 0} source-matched interpretation rules. Future quantities, costs and cash balances will be read from the new workbook.`,
                ]
              : []),
          ],
          expectedRevision: overview.revision,
          ...(memory ? { memory } : {}),
        });
        const question = nextWorkbookQuestion(
          result.questions,
          result.errors,
          prepared.inspection,
        );
        const repeated =
          !mapped.preview && repeatedQuestion(question, acceptedClarification);
        const incompleteMapping =
          !mapped.preview &&
          result.errors.some((error) => error.field === 'unmapped');
        return {
          ...mapped,
          acceptedClarification,
          exclusions: result.exclusions,
          ai: {
            ...meta,
            status: mapped.preview
              ? 'completed'
              : repeated || incompleteMapping
                ? 'needs_review'
                : 'needs_clarification',
            ...(repeated ? { reply: repeatedQuestionReply } : {}),
            questions: incompleteMapping ? [] : question ? [question] : [],
            ...(incompleteMapping
              ? {
                  reply:
                    'Agent left part of the workbook unmapped, so import is blocked. Select Retry interpretation to rebuild the complete mapping. Your accepted answers and account choices are retained; nothing has been committed.',
                }
              : {}),
            message:
              provider.id === 'fixture'
                ? 'Offline fixture interpretation; no AI inference was used.'
                : 'AI interpretation validated. Review the proposed portfolio before confirming.',
          },
        };
      } catch (e) {
        if (e instanceof PortfolioError) throw e;
        const message =
          e instanceof LlmError
            ? e.message
            : 'AI output did not pass validation. Please clarify the workbook layout or missing information.';
        const internal =
          isInternalWorkbookQuestion(message) ||
          (e instanceof LlmError && e.code === 'LLM_INVALID_OUTPUT');
        await r.mapImport(id, {
          expectedRevision: overview.revision,
          mapping: {
            version: 1,
            accountDecisions: [],
            tables: [],
            excludedRows: [],
            overrides: [],
            cashBalances: [],
          },
          state: null,
          errors: [
            { sheet: 'Workbook', row: 0, field: 'interpretation', message },
          ],
          sources: [],
          warnings: [],
        });
        return {
          id,
          preview: null,
          errors: [],
          sources: [],
          exclusions: [],
          acceptedClarification,
          ai: {
            ...meta,
            status:
              e instanceof LlmError &&
              ['LLM_REFUSED', 'LLM_INCOMPLETE'].includes(e.code)
                ? 'failed'
                : internal || repeatedQuestion(message, acceptedClarification)
                  ? 'needs_review'
                  : 'needs_clarification',
            ...(repeatedQuestion(message, acceptedClarification)
              ? { reply: repeatedQuestionReply }
              : {}),
            questions: internal ? [] : [message],
            ...(internal
              ? {
                  reply:
                    'Agent produced an invalid mapping, so import is blocked. This is an application interpretation error, not a question you need to answer. Select Retry interpretation; your account choices and accepted answers are retained and nothing has been committed.',
                }
              : {}),
            message,
          },
        };
      }
    },
  };
}
export type WorkbookAi = ReturnType<typeof createWorkbookAi>;
