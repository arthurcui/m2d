// A missing/bad instrument must not abort unrelated holdings. Authentication,
// transport and quota failures still stop the batch without automatic retries.
export function isMarketSourceFailure(code: string | null | undefined) {
  return [
    'NO_COVERAGE',
    'UNSUPPORTED_EXCHANGE',
    'UNSUPPORTED_INSTRUMENT',
    'INSTRUMENT_MISMATCH',
    'ASSET_CLASS_MISMATCH',
    'INVALID_MARKET_DATA',
    'OPTIONS_UNAVAILABLE',
    'FX_UNAVAILABLE',
  ].includes(code ?? '');
}
export function marketFailureMessage(code: string | null | undefined) {
  const messages: Record<string, string> = {
    ASSET_CLASS_MISMATCH:
      'Provider security type differs from the recorded stock/ETF class; review this holding before applying a price.',
    NO_COVERAGE: 'No price available for the requested trading date.',
    UNSUPPORTED_EXCHANGE:
      'This exchange is not covered by the configured feed.',
    UNSUPPORTED_INSTRUMENT:
      'This instrument is not supported by the configured feed.',
    INSTRUMENT_MISMATCH:
      'Provider identity does not match the recorded instrument; no price applied.',
    INVALID_MARKET_DATA:
      'Provider data failed validation; previous evidence is retained.',
    MARKET_RATE_LIMIT:
      'Provider rate limit reached. Wait before refreshing again.',
    MARKET_BUSY:
      'Another market refresh is running. Try again after it finishes.',
    MARKET_NOT_CONFIGURED: 'The market provider key is not configured.',
    MARKET_ENTITLEMENT_REQUIRED:
      'The provider rejected access. Check the key and data plan.',
    MARKET_UNAVAILABLE: 'The market provider is temporarily unavailable.',
    IBKR_AUTH_REQUIRED: 'Connect or reconnect IBKR on the Market page.',
    IBKR_CONNECTION_FAILED:
      'IBKR is unavailable. Check connectivity and reconnect if authorization expired.',
    IBKR_TOOL_UNAVAILABLE:
      'This IBKR connection does not expose the requested market data tool.',
    IBKR_TOOL_FAILED:
      'IBKR could not complete the market request. Check subscriptions and connection status.',
  };
  return messages[code ?? ''] ?? `Refresh failed (${code ?? 'unknown error'}).`;
}
