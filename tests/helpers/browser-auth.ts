import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import type { StorageDriver } from '../../lib/storage/repository';
import { Repository } from '../../lib/storage/repository';
import { ChatGPTAccounts, type AuthBrowser } from '../../lib/auth/accounts';
import { ChatGPTOAuth } from '../../lib/auth/oauth';
import { CHATGPT_CLIENT_ID, CHATGPT_AUTH_ORIGIN, CHATGPT_REDIRECT_URI } from '../../config/chatgpt';

export function memoryStorage(): StorageDriver & { data: Record<string, unknown>; fail: boolean } {
  const data: Record<string, unknown> = {};
  return {
    data,
    fail: false,
    async get(keys) {
      return structuredClone(
        keys == null
          ? data
          : Object.fromEntries(
              (typeof keys === 'string' ? [keys] : keys)
                .filter((key) => key in data)
                .map((key) => [key, data[key]]),
            ),
      );
    },
    async set(items) {
      if (this.fail) throw new Error('synthetic storage failure');
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      if (this.fail) throw new Error('synthetic storage failure');
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
    },
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}
export async function browserAuthFixture(
  issuer = CHATGPT_AUTH_ORIGIN,
  redirectUri = CHATGPT_REDIRECT_URI,
) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const controls = {
    refreshes: 0,
    exchanges: 0,
    subject: 'synthetic-reader',
    accountId: 'synthetic-account',
    nonce: undefined as string | undefined,
    audience: CHATGPT_CLIENT_ID,
    afterExchange: undefined as (() => Promise<void>) | undefined,
    afterRefresh: undefined as (() => void) | undefined,
  };
  const accessToken = 'synthetic-access-token-NEVER-IN-UI';
  const refreshToken = 'synthetic-refresh-token-NEVER-IN-UI';
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration'))
      return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (!url.endsWith('/oauth/token')) throw new Error('Unexpected synthetic request');
    const body = new URLSearchParams(String(init?.body));
    if (body.get('client_id') !== CHATGPT_CLIENT_ID) throw new Error('Wrong client ID');
    if (body.get('grant_type') === 'refresh_token') {
      controls.refreshes++;
      controls.afterRefresh?.();
      return Response.json({
        access_token: `${accessToken}-${controls.refreshes}`,
        refresh_token: `${refreshToken}-${controls.refreshes}`,
        expires_in: 3600,
      });
    }
    const code = body.get('code') || '',
      record = codes.get(code);
    controls.exchanges++;
    if (
      !record ||
      body.get('redirect_uri') !== redirectUri ||
      createHash('sha256')
        .update(body.get('code_verifier') || '')
        .digest('base64url') !== record.challenge
    )
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    codes.delete(code);
    const token = await new SignJWT({
      nonce: controls.nonce || record.nonce,
      email: 'reader@example.test',
      'https://api.openai.com/auth': { chatgpt_account_id: controls.accountId },
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience(controls.audience)
      .setSubject(controls.subject)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    await controls.afterExchange?.();
    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: token,
      expires_in: 3600,
      token_type: 'Bearer',
    });
  };
  const local = memoryStorage(),
    session = memoryStorage();
  const repository = new Repository(local),
    sessionRepository = new Repository(session);
  const tabs = new Map<number, string>();
  let lastTab = 0;
  const browser: AuthBrowser = {
    async create() {
      tabs.set(++lastTab, 'about:blank');
      return lastTab;
    },
    async open(id, url) {
      tabs.set(id, url);
    },
    async urls(id) {
      if (!tabs.has(id)) throw new Error('closed');
      return [tabs.get(id)!];
    },
    async close(id) {
      tabs.delete(id);
    },
    async complete(id) {
      tabs.set(id, 'chrome-extension://synthetic/auth-complete.html');
    },
  };
  const oauth = new ChatGPTOAuth(fetcher, createLocalJWKSet({ keys: [jwk] }));
  const accounts = new ChatGPTAccounts(repository, sessionRepository, browser, oauth);
  function authorize(url: string) {
    const auth = new URL(url),
      code = crypto.randomUUID();
    codes.set(code, {
      challenge: auth.searchParams.get('code_challenge')!,
      nonce: auth.searchParams.get('nonce')!,
    });
    const callback = new URL(redirectUri);
    callback.search = new URLSearchParams({
      code,
      state: auth.searchParams.get('state')!,
    }).toString();
    return callback;
  }
  return {
    accounts,
    oauth,
    repository,
    sessionRepository,
    browser,
    local,
    session,
    tabs,
    fetcher,
    controls,
    authorize,
    accessToken,
    refreshToken,
  };
}
