import type { CanonicalItem } from '@m2d/llm';
import { LlmError } from '@m2d/llm';
// Preserve canonical history, but do not send evidence/answers from a different
// historical boundary back to the model through history or opaque continuation.
export function researchScopeHistory(history: CanonicalItem[], at?: string) {
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (item.kind !== 'text' || item.role !== 'user') continue;
    const header = item.text.split('\n')[0] ?? '';
    const same = at
      ? header.endsWith(`; evidence available by ${at}.`)
      : !header.includes('; evidence available by ');
    if (!same) break;
    start = i;
  }
  return history.slice(start);
}
// Only links to documents returned by a research read in this conversation may
// be emitted as evidence. Source content cannot grant tools or mutate state.
export function validateResearchCitations(
  text: string,
  history: CanonicalItem[],
) {
  const allowed = new Set<string>();
  const researchCalls = new Set(
    history
      .filter((i) => i.kind === 'tool_call' && i.name.startsWith('research_'))
      .map((i) => (i.kind === 'tool_call' ? i.callId : '')),
  );
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const r = value as Record<string, unknown>;
    if (typeof r.document_id === 'string' && typeof r.provider === 'string')
      allowed.add(r.document_id);
    if (
      typeof r.id === 'string' &&
      typeof r.hash === 'string' &&
      r.available_at !== undefined
    )
      allowed.add(r.id);
    Object.values(r).forEach(collect);
  };
  for (const item of history)
    if (item.kind === 'tool_result' && researchCalls.has(item.callId))
      collect(item.output);
  for (const match of text.matchAll(/\/research\?document=([0-9a-f-]{36})/g))
    if (!allowed.has(match[1]!))
      throw new LlmError(
        'LLM_INVALID_OUTPUT',
        'Agent cited a document that was not retrieved. Ask again to retrieve the source evidence.',
      );
}
