import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationSchema,
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { MarketError } from './contracts.js';
import { IBKR_READ_TOOLS, type IbkrSession } from './ibkr.js';

export const IBKR_MCP_URL = 'https://api.ibkr.com/v1/api/mcp-public';
const issuer = 'https://api.ibkr.com';
const resourceMetadataUrl = new URL(
  IBKR_MCP_URL + '/.well-known/oauth-protected-resource',
);
const savedSchema = z.object({
  version: z.literal(1),
  redirectUrl: z.url(),
  client: z
    .union([OAuthClientInformationFullSchema, OAuthClientInformationSchema])
    .optional(),
  tokens: OAuthTokensSchema.optional(),
  expiresAt: z.number().optional(),
  pending: z
    .object({
      state: z.string(),
      verifier: z.string().optional(),
      authorizationUrl: z.url().optional(),
      expiresAt: z.number(),
    })
    .optional(),
});
type Saved = z.infer<typeof savedSchema>;
export interface IbkrSecretStore {
  read(): Promise<unknown>;
  write(value: Saved): Promise<void>;
}
export function ibkrFileStore(path: string): IbkrSecretStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT')
          return null;
        throw new Error('IBKR credential file could not be read.');
      }
    },
    async write(value) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
      await writeFile(temporary, JSON.stringify(value), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, path);
    },
  };
}
const authRequired = () =>
  new MarketError(
    'IBKR_AUTH_REQUIRED',
    'Connect or reconnect IBKR on the Market page.',
    401,
  );
function sanitized(error: unknown): MarketError {
  if (error instanceof MarketError) return error;
  if (
    error instanceof UnauthorizedError ||
    (error instanceof StreamableHTTPError && error.code === 401)
  )
    return authRequired();
  return new MarketError(
    'IBKR_CONNECTION_FAILED',
    'IBKR connection failed. Check connectivity and reconnect if the authorization has expired.',
    502,
  );
}
/** Server-only single-workspace OAuth; no application login or account data access. */
export class IbkrConnection {
  private saved: Saved;
  private busy = false;
  constructor(
    private readonly store: IbkrSecretStore,
    readonly redirectUrl: string,
    private readonly gate: () => Promise<void>,
    private readonly transport: typeof fetch = fetch,
    private readonly clock = Date.now,
  ) {
    const u = new URL(redirectUrl);
    if (
      (u.protocol !== 'https:' &&
        !(
          u.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
        )) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error('IBKR callback must use HTTPS or localhost HTTP.');
    this.saved = { version: 1, redirectUrl };
  }
  async load() {
    const data = await this.store.read();
    if (data !== null && data !== undefined) {
      const parsed = savedSchema.safeParse(data);
      if (!parsed.success)
        throw new Error(
          'Invalid IBKR credential store; restore or reconnect using a new store.',
        );
      if (parsed.data.redirectUrl === this.redirectUrl)
        this.saved = parsed.data;
    }
    if (this.saved.tokens) this.validateTokens(this.saved.tokens);
  }
  private persist() {
    return this.store.write(this.saved);
  }
  get connected() {
    return !!this.saved.tokens;
  }
  status() {
    return {
      connected: this.connected,
      expiresAt: this.saved.expiresAt
        ? new Date(this.saved.expiresAt).toISOString()
        : null,
      scope: 'mcp.read',
      pending:
        !!this.saved.pending && this.saved.pending.expiresAt > this.clock(),
    };
  }
  private async exclusive<T>(work: () => Promise<T>) {
    if (this.busy)
      throw new MarketError(
        'IBKR_CONNECTION_BUSY',
        'An IBKR connection operation is already running.',
        409,
      );
    this.busy = true;
    try {
      return await work();
    } catch (e) {
      throw sanitized(e);
    } finally {
      this.busy = false;
    }
  }
  private validateTokens(tokens: Saved['tokens']) {
    if (
      !tokens ||
      tokens.issuer !== issuer ||
      (tokens.scope ?? 'mcp.read') !== 'mcp.read' ||
      tokens.token_type.toLowerCase() !== 'bearer'
    )
      throw new MarketError(
        'IBKR_SCOPE_REJECTED',
        'IBKR must authorize only the requested read scope.',
        403,
      );
  }
  private fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== issuer ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      ![
        '/v1/api/mcp-public',
        '/v1/api/mcp-public/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/v1/api/mcp-public',
        '/.well-known/oauth-authorization-server',
        '/oauth2/register',
        '/oauth2/api/v1/token',
        '/oauth2/api/v1/token/revoke',
      ].includes(url.pathname)
    )
      throw new MarketError(
        'IBKR_ENDPOINT_REJECTED',
        'IBKR attempted to use an unsupported endpoint.',
        502,
      );
    if (url.pathname === '/v1/api/mcp-public') await this.gate();
    const response = await this.transport(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(20000),
      ]),
    });
    if (response.status === 429)
      throw new MarketError(
        'MARKET_RATE_LIMIT',
        'IBKR rate limit reached. Wait before retrying.',
        429,
      );
    if (response.status === 403)
      throw new MarketError(
        'MARKET_ENTITLEMENT_REQUIRED',
        'IBKR rejected access; check authorization and market data subscriptions.',
        403,
      );
    return response;
  };
  private oauth(interactive: boolean, verifier?: string): OAuthClientProvider {
    return {
      redirectUrl: this.redirectUrl,
      clientMetadata: {
        client_name: 'M2D market data',
        redirect_uris: [this.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp.read',
      },
      state: () => {
        if (!interactive || !this.saved.pending) throw authRequired();
        return this.saved.pending.state;
      },
      clientInformation: () => this.saved.client,
      saveClientInformation: async (client) => {
        if (client.issuer !== issuer) throw authRequired();
        this.saved.client = client;
        await this.persist();
      },
      tokens: () => this.saved.tokens,
      saveTokens: async (tokens) => {
        this.validateTokens(tokens);
        this.saved.tokens = tokens;
        this.saved.expiresAt = tokens.expires_in
          ? this.clock() + tokens.expires_in * 1000
          : undefined;
        await this.persist();
      },
      saveCodeVerifier: async (code) => {
        if (!interactive || !this.saved.pending) throw authRequired();
        this.saved.pending.verifier = code;
        await this.persist();
      },
      codeVerifier: () => {
        const code = verifier ?? this.saved.pending?.verifier;
        if (!code) throw authRequired();
        return code;
      },
      redirectToAuthorization: async (url) => {
        if (
          !interactive ||
          !this.saved.pending ||
          url.origin !== issuer ||
          url.pathname !== '/oauth2/authorize' ||
          url.searchParams.get('scope') !== 'mcp.read' ||
          url.searchParams.get('state') !== this.saved.pending.state ||
          url.searchParams.get('code_challenge_method') !== 'S256'
        )
          throw authRequired();
        this.saved.pending.authorizationUrl = url.toString();
        await this.persist();
      },
      invalidateCredentials: async (scope) => {
        if (scope === 'all' || scope === 'client') delete this.saved.client;
        if (scope === 'all' || scope === 'tokens') {
          delete this.saved.tokens;
          delete this.saved.expiresAt;
        }
        if (scope === 'all' || scope === 'verifier') delete this.saved.pending;
        await this.persist();
      },
    };
  }
  async start() {
    return this.exclusive(async () => {
      if (
        this.saved.pending?.authorizationUrl &&
        this.saved.pending.expiresAt > this.clock()
      )
        return {
          authorizationUrl: this.saved.pending.authorizationUrl,
          state: this.saved.pending.state,
        };
      delete this.saved.tokens;
      delete this.saved.expiresAt;
      this.saved.pending = {
        state: randomBytes(32).toString('base64url'),
        expiresAt: this.clock() + 600000,
      };
      await this.persist();
      // Always pass scope explicitly: SDK defaults may include every advertised scope.
      await auth(this.oauth(true), {
        serverUrl: IBKR_MCP_URL,
        resourceMetadataUrl,
        scope: 'mcp.read',
        fetchFn: this.fetch,
      });
      const url = this.saved.pending?.authorizationUrl;
      if (!url) throw authRequired();
      return { authorizationUrl: url, state: this.saved.pending!.state };
    });
  }
  async complete(state: string, code: string, responseIssuer: string) {
    return this.exclusive(async () => {
      const pending = this.saved.pending;
      if (
        !pending ||
        pending.expiresAt <= this.clock() ||
        responseIssuer !== issuer ||
        state.length !== pending.state.length ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))
      )
        throw new MarketError(
          'IBKR_STATE_REJECTED',
          'This IBKR connection request expired or does not match. Start a new connection.',
          400,
        );
      delete this.saved.pending;
      await this.persist(); // Consume before exchanging: callback replay never repeats a grant.
      await auth(this.oauth(false, pending.verifier), {
        serverUrl: IBKR_MCP_URL,
        resourceMetadataUrl,
        authorizationCode: code,
        scope: 'mcp.read',
        fetchFn: this.fetch,
      });
      return this.status();
    });
  }
  async disconnect() {
    return this.exclusive(async () => {
      // Local token removal is unconditional. Server consent can also be revoked in IBKR.
      this.saved = {
        version: 1,
        redirectUrl: this.redirectUrl,
        ...(this.saved.client ? { client: this.saved.client } : {}),
      };
      await this.persist();
      return this.status();
    });
  }
  private async token() {
    if (!this.saved.tokens) throw authRequired();
    if (
      this.saved.expiresAt !== undefined &&
      this.saved.expiresAt <= this.clock() + 60000
    ) {
      await auth(this.oauth(false), {
        serverUrl: IBKR_MCP_URL,
        resourceMetadataUrl,
        scope: 'mcp.read',
        fetchFn: this.fetch,
      });
    }
    this.validateTokens(this.saved.tokens);
    return this.saved.tokens!.access_token;
  }
  async open(): Promise<IbkrSession> {
    return this.exclusive(async () => {
      const token = await this.token();
      const client = new Client(
        { name: 'm2d-market', version: '1.0.0' },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(IBKR_MCP_URL),
        {
          // OAuth is managed above with fixed scope. Never let a challenge escalate it.
          requestInit: {
            headers: { Authorization: 'Bearer ' + token },
            redirect: 'error',
          },
          fetch: this.fetch,
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        },
      );
      try {
        await client.connect(transport, { timeout: 20000 });
        const tools = await client.listTools({}, { timeout: 20000 });
        const names = new Map<string, string>();
        for (const name of IBKR_READ_TOOLS) {
          const matches = tools.tools.filter((t) =>
            [name, 'ibkr_' + name, 'interactive_brokers_ibkr_' + name].includes(
              t.name,
            ),
          );
          if (matches.length === 1) names.set(name, matches[0]!.name);
        }
        return {
          call: async (name, args) => {
            if (!IBKR_READ_TOOLS.includes(name) || !names.has(name))
              throw new MarketError(
                'IBKR_TOOL_UNAVAILABLE',
                'The requested market data tool is not available in this IBKR connection.',
              );
            if (!this.connected) throw authRequired();
            try {
              const result = await client.callTool(
                { name: names.get(name)!, arguments: args },
                undefined,
                { timeout: 20000 },
              );
              if (result.isError)
                throw new MarketError(
                  'IBKR_TOOL_FAILED',
                  'IBKR could not complete the market request. Check data subscriptions and connection status.',
                  502,
                );
              const blocks = z
                .array(
                  z
                    .object({ type: z.string(), text: z.string().optional() })
                    .passthrough(),
                )
                .parse(result.content);
              const text = blocks
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('\n');
              if (text.length > 2000000)
                throw new MarketError(
                  'INVALID_MARKET_DATA',
                  'IBKR response exceeds the supported size.',
                );
              // Text JSON is the original numerical source; preserve its decimal tokens.
              const data: unknown =
                text.trim().startsWith('{') || text.trim().startsWith('[')
                  ? JSON.parse(
                      text,
                      (
                        _k: string,
                        v: unknown,
                        context?: { source?: string },
                      ) =>
                        typeof v === 'number' && context?.source
                          ? context.source
                          : v,
                    )
                  : result.structuredContent;
              if (!data)
                throw new MarketError(
                  'INVALID_MARKET_DATA',
                  'IBKR returned no structured market data.',
                );
              return { data, raw: result };
            } catch (e) {
              if (
                e instanceof UnauthorizedError ||
                (e instanceof StreamableHTTPError && e.code === 401)
              ) {
                this.saved.expiresAt = 0;
                await this.persist();
              }
              throw sanitized(e);
            }
          },
          close: async () => {
            await client.close();
          },
        };
      } catch (e) {
        await client.close();
        if (
          e instanceof UnauthorizedError ||
          (e instanceof StreamableHTTPError && e.code === 401)
        ) {
          this.saved.expiresAt = 0;
          await this.persist();
        }
        throw sanitized(e);
      }
    });
  }
}
