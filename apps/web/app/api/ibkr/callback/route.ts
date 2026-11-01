import { NextRequest, NextResponse } from 'next/server';
export async function GET(request: NextRequest) {
  let connected = false;
  try {
    const state = request.nextUrl.searchParams.get('state');
    const code = request.nextUrl.searchParams.get('code');
    const issuer = request.nextUrl.searchParams.get('iss');
    if (
      state &&
      code &&
      !request.nextUrl.searchParams.has('error') &&
      state === request.cookies.get('m2d-ibkr-state')?.value &&
      issuer === 'https://api.ibkr.com'
    ) {
      const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
      const response = await fetch(base + '/api/v1/market/ibkr/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, code, issuer }),
        cache: 'no-store',
        signal: AbortSignal.timeout(60000),
      });
      connected = response.ok;
    }
  } catch {
    /* Show a safe connection outcome, never OAuth codes or tokens. */
  }
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      Location: '/market?ibkr=' + (connected ? 'connected' : 'failed'),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
  response.cookies.set('m2d-ibkr-state', '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/ibkr',
    maxAge: 0,
  });
  return response;
}
