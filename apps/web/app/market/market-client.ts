export function marketTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString('en-CA', {
        timeZone: 'America/Vancouver',
        dateStyle: 'medium',
        timeStyle: 'short',
      }) + ' Vancouver'
    : 'Unavailable';
}
export async function marketApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/v1/${path}`,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = (await response.json()) as {
    data: T;
    error?: { message: string };
  };
  if (!response.ok)
    throw new Error(result.error?.message ?? 'Market request failed.');
  return result.data;
}
