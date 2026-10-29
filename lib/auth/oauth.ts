import { createRemoteJWKSet, jwtVerify, decodeJwt, type JWTVerifyGetKey } from 'jose';
import { CHATGPT_AUTH_ORIGIN, CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI } from '../../config/chatgpt';
import type { ChatGPTAuthRecord, ChatGPTAuthFlow } from '../../types';

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export const authRandom = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function authorization(flow: Pick<ChatGPTAuthFlow, 'state' | 'nonce' | 'verifier'>) {
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier))),
  );
  const url = new URL(`${CHATGPT_AUTH_ORIGIN}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: CHATGPT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CHATGPT_REDIRECT_URI,
    scope: 'openid profile email offline_access',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
  }).toString();
  return url.href;
}
export function callbackParameters(raw: string): URLSearchParams | null {
  try {
    const url = new URL(raw),
      expected = new URL(CHATGPT_REDIRECT_URI);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    for (const key of ['state', 'code', 'error'])
      if (url.searchParams.getAll(key).length > 1) throw new Error('登录回调包含重复参数。');
    return url.searchParams;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('登录')) throw error;
    return null;
  }
}
export class ChatGPTOAuth {
  private keys?: JWTVerifyGetKey;
  constructor(
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
    private testKeys?: JWTVerifyGetKey,
  ) {}
  private async signingKeys() {
    if (this.testKeys) return this.testKeys;
    if (!this.keys) {
      const response = await this.fetcher(
        `${CHATGPT_AUTH_ORIGIN}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(20000), redirect: 'error' },
      );
      if (!response.ok) throw new Error('无法获取 OpenAI 账号验证信息，请重试。');
      const discovery = await response.json();
      if (
        discovery.issuer !== CHATGPT_AUTH_ORIGIN ||
        typeof discovery.jwks_uri !== 'string' ||
        new URL(discovery.jwks_uri).origin !== CHATGPT_AUTH_ORIGIN
      )
        throw new Error('OpenAI 身份验证地址无效。');
      this.keys = createRemoteJWKSet(new URL(discovery.jwks_uri));
    }
    return this.keys;
  }
  private async token(body: URLSearchParams) {
    let response: Response;
    try {
      response = await this.fetcher(`${CHATGPT_AUTH_ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
    } catch {
      throw new Error('无法连接 OpenAI 授权服务，请检查网络后重试。');
    }
    if (!response.ok)
      throw new Error(
        response.status === 400 || response.status === 401
          ? 'ChatGPT 授权已过期或被拒绝，请重新登录。'
          : 'OpenAI 授权服务暂不可用，请稍后重试。',
      );
    return response.json();
  }
  private async record(
    data: any,
    previous?: ChatGPTAuthRecord,
    nonce?: string,
  ): Promise<ChatGPTAuthRecord> {
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      (data.token_type && data.token_type.toLowerCase() !== 'bearer')
    )
      throw new Error('OpenAI 返回的登录凭证不完整。');
    let subject = previous?.subject,
      accountId = previous?.accountId,
      email = previous?.email;
    if (data.id_token !== undefined) {
      if (typeof data.id_token !== 'string') throw new Error('OpenAI 返回的账号身份无效。');
      const { payload } = await jwtVerify(data.id_token, await this.signingKeys(), {
        issuer: CHATGPT_AUTH_ORIGIN,
        audience: CHATGPT_CLIENT_ID,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', ...(nonce ? ['nonce'] : [])],
      });
      const claims = payload['https://api.openai.com/auth'] as
        { chatgpt_account_id?: string } | undefined;
      if (
        (nonce && payload.nonce !== nonce) ||
        !payload.sub ||
        typeof claims?.chatgpt_account_id !== 'string' ||
        !claims.chatgpt_account_id ||
        (previous &&
          (payload.sub !== previous.subject || claims.chatgpt_account_id !== previous.accountId))
      )
        throw new Error('ChatGPT 账号身份不匹配，请重新登录。');
      subject = payload.sub;
      accountId = claims.chatgpt_account_id;
      email = typeof payload.email === 'string' ? payload.email : previous?.email || 'ChatGPT 账号';
    } else if (!previous || nonce) throw new Error('OpenAI 未返回可验证的账号身份。');
    let expiresAt = Date.now() + Number(data.expires_in) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      try {
        expiresAt = Number(decodeJwt(data.access_token).exp) * 1000;
      } catch {
        /* Unusable expiry is rejected below. */
      }
    }
    const refreshToken =
      typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : previous?.refreshToken;
    if (
      !subject ||
      !accountId ||
      !refreshToken ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new Error('OpenAI 返回的登录凭证或过期时间无效。');
    return {
      version: 1,
      id: previous?.id || crypto.randomUUID(),
      subject,
      accountId,
      email: email || 'ChatGPT 账号',
      accessToken: data.access_token,
      refreshToken,
      idToken: data.id_token || previous!.idToken,
      expiresAt,
      revision: crypto.randomUUID(),
    };
  }
  async exchange(code: string, flow: ChatGPTAuthFlow, previous?: ChatGPTAuthRecord) {
    const data = await this.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CHATGPT_CLIENT_ID,
        redirect_uri: CHATGPT_REDIRECT_URI,
        code,
        code_verifier: flow.verifier,
      }),
    );
    return this.record(data, previous, flow.nonce);
  }
  async refresh(previous: ChatGPTAuthRecord) {
    const data = await this.token(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CHATGPT_CLIENT_ID,
        refresh_token: previous.refreshToken,
      }),
    );
    return this.record(data, previous);
  }
}
