export type ImportResult = {
  id: string;
  symbol: string;
  status: string;
  error: string | null;
  document_ids: string[];
  added_count: number | null;
  reused_count: number | null;
  passage_count: number | null;
};
export type Operation = {
  state: 'working' | 'done' | 'error';
  message: string;
  result?: ImportResult;
};
export function importSummary(r: ImportResult) {
  if (r.added_count == null)
    return `Import complete · ${r.document_ids.length} documents.`;
  return r.added_count === 0
    ? `Already saved · ${r.reused_count} document${r.reused_count === 1 ? '' : 's'} reused · ${r.passage_count} searchable passages.`
    : `Imported ${r.added_count} new document${r.added_count === 1 ? '' : 's'} · ${r.reused_count} already saved · ${r.passage_count} searchable passages.`;
}
export async function researchRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(`/api/v1/research${path}`, {
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value = (await r.json()) as { data: T; error?: { message: string } };
  if (!r.ok)
    throw new Error(value.error?.message ?? 'Research request failed.');
  return value.data;
}
export function OperationFeedback({
  operation,
  onOpen,
}: {
  operation?: Operation | undefined;
  onOpen: (id: string) => void;
}) {
  if (!operation) return null;
  return (
    <div
      className="research-operation"
      role={operation.state === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <p>{operation.message}</p>
      {operation.result?.document_ids.slice(0, 5).map((id, i) => (
        <button type="button" key={id + i} onClick={() => onOpen(id)}>
          Open document
          {operation.result!.document_ids.length > 1 ? ` ${i + 1}` : ''}
        </button>
      ))}
    </div>
  );
}
