import type { ChatGPTAuthRecord } from '../../types';

export const AUTH_JSON_LIMIT = 128000;
export interface AuthJsonTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  account_id: string;
  expiresAt?: number;
}
export function parseAuthJson(raw: string): AuthJsonTokens {
  if (typeof raw !== 'string' || raw.length > AUTH_JSON_LIMIT)
    throw new Error('auth.json 不能超过 128,000 个字符。');
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('auth.json 不是有效的 JSON。');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.auth_mode !== undefined && value.auth_mode !== 'chatgpt') ||
    (value.OPENAI_API_KEY !== undefined && value.OPENAI_API_KEY !== null) ||
    !value.tokens ||
    typeof value.tokens !== 'object' ||
    Array.isArray(value.tokens)
  )
    throw new Error('请填写 ChatGPT 账号的 auth.json，需包含 tokens 对象。');
  const tokens = value.tokens;
  for (const key of ['access_token', 'refresh_token', 'id_token', 'account_id']) {
    if (typeof tokens[key] !== 'string' || !tokens[key].trim() || /\s/.test(tokens[key]))
      throw new Error('auth.json 的账号 ID 或令牌字段不完整。');
  }
  let expiresAt: number | undefined;
  if (value.expires_at !== undefined) {
    expiresAt = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= 0)
      throw new Error('auth.json 的 expires_at 必须是有效的日期字符串。');
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    account_id: tokens.account_id,
    expiresAt,
  };
}
export function serializeAuthJson(record: ChatGPTAuthRecord): string {
  return JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: record.idToken,
        access_token: record.accessToken,
        refresh_token: record.refreshToken,
        account_id: record.accountId,
      },
      expires_at: new Date(record.expiresAt).toISOString(),
    },
    null,
    2,
  );
}
