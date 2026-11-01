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
// Validate provenance, not semantic entailment. Only returned passages may be
// cited; document-only citations remain valid for metadata and XBRL facts.
export function validateResearchCitations(
  text: string,
  history: CanonicalItem[],
  finalAnswer = true,
) {
  const allowed = new Set<string>();
  const passages = new Set<string>();
  let currentEvidence = false,
    foundEvidence = false;
  const lastUser = history.findLastIndex(
    (i) => i.kind === 'text' && i.role === 'user',
  );
  const researchCalls = new Set(
    history
      .filter((i) => i.kind === 'tool_call' && i.name.startsWith('research_'))
      .map((i) => (i.kind === 'tool_call' ? i.callId : '')),
  );
  const collect = (value: unknown, inherited?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v) => collect(v, inherited));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const r = value as Record<string, unknown>;
    const id =
      typeof r.document_id === 'string' && typeof r.provider === 'string'
        ? r.document_id
        : typeof r.id === 'string' &&
            typeof r.hash === 'string' &&
            r.available_at !== undefined
          ? r.id
          : inherited;
    if (id) {
      foundEvidence = true;
      allowed.add(id.toLowerCase());
      const index = r.chunk_index ?? r.index;
      if (
        typeof index === 'number' &&
        Number.isInteger(index) &&
        index >= 0 &&
        typeof r.text === 'string'
      )
        passages.add(`${id.toLowerCase()}#chunk-${index}`);
    }
    // Comparison passages are siblings of their document metadata.
    if (r.before && r.after) {
      collect(r.before);
      collect(r.after);
      collect(r.removed, (r.before as Record<string, unknown>).id as string);
      collect(r.added, (r.after as Record<string, unknown>).id as string);
    }
    for (const [key, child] of Object.entries(r))
      if (!['removed', 'added'].includes(key)) collect(child, id);
  };
  for (const [index, item] of history.entries())
    if (item.kind === 'tool_result' && researchCalls.has(item.callId)) {
      foundEvidence = false;
      collect(item.output);
      if (index > lastUser && foundEvidence) currentEvidence = true;
    }
  let citations = 0;
  for (const match of text.matchAll(/\/research\?document=([^\s)\]<>"']+)/g)) {
    const target = match[1]!.toLowerCase();
    const [id, fragment] = target.split('#');
    if (
      !id ||
      !allowed.has(id) ||
      (fragment !== undefined && !passages.has(target))
    )
      throw new LlmError(
        'LLM_INVALID_OUTPUT',
        'Advisor cited a document or passage that was not retrieved. Ask again to retrieve the source evidence.',
      );
    citations++;
  }
  if (
    finalAnswer &&
    currentEvidence &&
    !citations &&
    !/^\s*NO_SIGNAL\b/.test(text)
  )
    throw new LlmError(
      'LLM_INVALID_OUTPUT',
      'Advisor did not cite its retrieved research evidence. Ask again for a cited answer or NO_SIGNAL when evidence is insufficient.',
    );
}
