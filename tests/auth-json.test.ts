import { afterEach, expect, it, vi } from 'vitest';
import { decodeJwt } from 'jose';
import { AUTH_JSON_LIMIT, parseAuthJson, serializeAuthJson } from '../lib/domain/auth-json';
import { browserAuthFixture } from './helpers/browser-auth';
import { provider } from './fixtures';
import { CHATGPT_PROVIDER_URL } from '../config/chatgpt';

afterEach(() => vi.restoreAllMocks());
async function setup() {
  const value = await browserAuthFixture();
  const flow = await value.accounts.start();
  const [tabId, url] = [...value.tabs].at(-1)!;
  await value.accounts.observe(tabId, value.authorize(url).href);
  const { connection } = await value.accounts.status(flow.flowId, flow.statusKey);
  const account = {
    ...provider,
    authType: 'chatgpt' as const,
    apiKey: '',
    apiFormat: 'openai_responses' as const,
    baseUrl: CHATGPT_PROVIDER_URL,
    chatgpt: {
      connectionId: connection!.id,
      email: connection!.email,
      draftKey: connection!.draftKey,
    },
  };
  return { ...value, account, connection: connection!, flow };
}
async function replacement(value: Awaited<ReturnType<typeof setup>>) {
  value.controls.accountId = 'replacement-account';
  value.controls.subject = 'replacement-subject';
  value.controls.email = 'replacement@example.test';
  const flow = await value.accounts.start();
  const [tabId, url] = [...value.tabs].at(-1)!;
  await value.accounts.observe(tabId, value.authorize(url).href);
  const connection = (await value.accounts.status(flow.flowId, flow.statusKey)).connection!;
  const document = JSON.parse(
    (await value.accounts.authJson(connection.id, connection.draftKey)).json,
  );
  document.tokens.access_token = 'synthetic-replacement-access';
  document.tokens.refresh_token = 'synthetic-replacement-refresh';
  return JSON.stringify(document);
}
it('exposes auth.json only for a saved connection or its own active draft', async () => {
  const value = await setup();
  await expect(value.accounts.authJson(value.connection.id)).rejects.toThrow('不存在');
  await expect(value.accounts.authJson(value.connection.id, 'wrong')).rejects.toThrow('不存在');
  const snapshot = await value.accounts.authJson(value.connection.id, value.connection.draftKey);
  expect(parseAuthJson(snapshot.json).access_token === value.accessToken).toBe(true);
  await value.repository.saveChatGPTProvider(value.account);
  const saved = await value.accounts.authJson(value.connection.id);
  expect(saved.json === snapshot.json).toBe(true);
  expect(JSON.stringify(await value.repository.config()).includes(value.accessToken)).toBe(false);
});
it('round-trips edited credentials and settings together without storing raw JSON or unknown fields', async () => {
  const value = await setup();
  const snapshot = await value.accounts.authJson(value.connection.id, value.connection.draftKey);
  const document = JSON.parse(snapshot.json);
  document.tokens.access_token = 'synthetic-edited-access';
  document.ignored_private_field = 'should-not-be-stored';
  const result = await value.accounts.saveAuthJson(
    { ...value.account, name: '修改后的名称' },
    JSON.stringify(document),
    snapshot.revision,
  );
  expect(result.providers).toHaveLength(1);
  expect(result.providers[0]?.name).toBe('修改后的名称');
  expect(JSON.stringify(result).includes('synthetic-edited-access')).toBe(false);
  expect(JSON.stringify(value.local.data).includes('should-not-be-stored')).toBe(false);
  const credentials = await value.accounts.credentials(value.connection.id);
  expect(credentials.accessToken === 'synthetic-edited-access').toBe(true);
  await value.accounts.discard(value.connection.id, value.connection.draftKey);
  expect(!!(await value.repository.authRecord(value.connection.id))).toBe(true);
});
it('imports a new connection only when explicitly saving and supports expired cached identity tokens', async () => {
  const value = await setup();
  const record = (await value.repository.authRecord(value.connection.id))!;
  const document = serializeAuthJson(record);
  await value.accounts.discard(value.connection.id, value.connection.draftKey);
  const { chatgpt: _, ...newAccount } = value.account;
  expect((await value.repository.config()).providers).toHaveLength(0);
  const pastExpiry = Date.now() + 7200000;
  vi.spyOn(Date, 'now').mockReturnValue(pastExpiry);
  const result = await value.accounts.saveAuthJson(newAccount, document);
  const imported = result.providers[0]!;
  expect(result.currentProviderId).toBe(imported.id);
  expect(imported.chatgpt?.connectionId !== value.connection.id).toBe(true);
  expect(value.controls.refreshes).toBe(0);
  await value.accounts.credentials(imported.chatgpt!.connectionId);
  expect(value.controls.refreshes).toBe(1);
});
it('rejects old edits after a token refresh and keeps the newer credentials', async () => {
  const value = await setup();
  await value.repository.saveChatGPTProvider(value.account);
  const snapshot = await value.accounts.authJson(value.connection.id);
  const latest = await value.accounts.credentials(value.connection.id, snapshot.revision);
  await expect(
    value.accounts.saveAuthJson(value.account, snapshot.json, snapshot.revision),
  ).rejects.toThrow('重新读取');
  expect((await value.accounts.credentials(value.connection.id)).revision).toBe(latest.revision);
});
it('keeps credentials and provider settings unchanged when persistence fails', async () => {
  const value = await setup();
  await value.repository.saveChatGPTProvider(value.account);
  const snapshot = await value.accounts.authJson(value.connection.id);
  const before = JSON.stringify(value.local.data);
  value.local.fail = true;
  await expect(
    value.accounts.saveAuthJson(
      { ...value.account, name: '不能保存的修改' },
      snapshot.json,
      snapshot.revision,
    ),
  ).rejects.toThrow();
  await expect(
    value.accounts.saveAuthJson(value.account, snapshot.json, snapshot.revision, true),
  ).rejects.toThrow();
  expect(JSON.stringify(value.local.data) === before).toBe(true);
});
it('rejects forged identities, inconsistent access accounts and account changes without an explicit replacement', async () => {
  const value = await setup();
  await value.repository.saveChatGPTProvider(value.account);
  const snapshot = await value.accounts.authJson(value.connection.id);
  const document = JSON.parse(snapshot.json);
  const originalToken = document.tokens.id_token;
  const parts = originalToken.split('.');
  parts[1] = btoa(JSON.stringify({ ...decodeJwt(originalToken), sub: 'forged' }))
    .replaceAll('=', '')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
  document.tokens.id_token = parts.join('.');
  await expect(
    value.accounts.saveAuthJson(value.account, JSON.stringify(document), snapshot.revision),
  ).rejects.toThrow('验证失败');
  document.tokens.id_token = originalToken;
  document.tokens.access_token = `e30.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'another-account' } })).replaceAll('=', '')}.fake`;
  await expect(
    value.accounts.saveAuthJson(value.account, JSON.stringify(document), snapshot.revision),
  ).rejects.toThrow('访问令牌');
  value.controls.accountId = 'another-account';
  const flow = await value.accounts.start();
  const [tabId, url] = [...value.tabs].at(-1)!;
  await value.accounts.observe(tabId, value.authorize(url).href);
  const second = (await value.accounts.status(flow.flowId, flow.statusKey)).connection!;
  const other = await value.accounts.authJson(second.id, second.draftKey);
  await expect(
    value.accounts.saveAuthJson(value.account, other.json, snapshot.revision),
  ).rejects.toThrow('其他账号');
  expect((await value.accounts.authJson(value.connection.id)).revision).toBe(snapshot.revision);
});
it('overwrites a saved connection with a pasted account even after local refresh, without mixing credentials', async () => {
  const value = await setup();
  const account = { ...value.account, name: `ChatGPT · ${value.account.chatgpt.email}` };
  await value.repository.saveChatGPTProvider(account);
  const snapshot = await value.accounts.authJson(value.connection.id);
  const document = await replacement(value);
  await value.accounts.credentials(value.connection.id, snapshot.revision);
  const result = await value.accounts.saveAuthJson(account, document, snapshot.revision, true);
  expect(result.providers).toHaveLength(1);
  const saved = result.providers[0]!;
  expect(saved.id).toBe(account.id);
  expect(result.currentProviderId).toBe(account.id);
  expect(saved.chatgpt?.email).toBe('replacement@example.test');
  expect(saved.name).toBe('ChatGPT · replacement@example.test');
  expect(saved.chatgpt?.connectionId).not.toBe(value.connection.id);
  const credentials = await value.accounts.credentials(saved.chatgpt!.connectionId);
  expect(credentials.accessToken).toBe('synthetic-replacement-access');
  expect(credentials.accountId).toBe('replacement-account');
  const record = (await value.repository.authRecord(saved.chatgpt!.connectionId))!;
  expect(record.subject).toBe('replacement-subject');
  expect(record.refreshToken).toBe('synthetic-replacement-refresh');
  expect(record.idToken === JSON.parse(document).tokens.id_token).toBe(true);
  expect(await value.repository.authRecord(value.connection.id)).toBeUndefined();
  await expect(value.accounts.credentials(value.connection.id)).rejects.toThrow('失效');
  expect((await value.accounts.status(value.flow.flowId, value.flow.statusKey)).status).toBe(
    'error',
  );
  const reloaded = JSON.parse((await value.accounts.authJson(saved.chatgpt!.connectionId)).json);
  expect(reloaded.tokens.account_id).toBe('replacement-account');
  expect(reloaded.tokens.access_token).toBe('synthetic-replacement-access');
});
it('preserves other providers sharing the old account when replacing one connection', async () => {
  const value = await setup();
  await value.repository.saveChatGPTProvider(value.account);
  await value.repository.saveChatGPTProvider({ ...value.account, id: 'alias', name: '其他连接' });
  const snapshot = await value.accounts.authJson(value.connection.id);
  const result = await value.accounts.saveAuthJson(
    value.account,
    await replacement(value),
    snapshot.revision,
    true,
  );
  expect(result.providers).toHaveLength(2);
  expect(result.providers.find((item) => item.id === 'alias')?.chatgpt?.connectionId).toBe(
    value.connection.id,
  );
  expect(
    (await value.accounts.credentials(value.connection.id)).accessToken === value.accessToken,
  ).toBe(true);
  expect(result.providers.find((item) => item.id === value.account.id)?.name).toBe(
    value.account.name,
  );
});
it('repairs a saved connection with missing credentials by explicitly pasting a new auth.json', async () => {
  const value = await setup();
  await value.repository.saveChatGPTProvider(value.account);
  const document = await replacement(value);
  await value.accounts.disconnect(value.connection.id);
  const result = await value.accounts.saveAuthJson(value.account, document, undefined, true);
  expect(result.providers).toHaveLength(1);
  const credentials = await value.accounts.credentials(result.providers[0]!.chatgpt!.connectionId);
  expect(credentials.accountId).toBe('replacement-account');
});
it('does not recreate a provider deleted while validating replacement credentials', async () => {
  const value = await setup();
  await value.repository.saveChatGPTProvider(value.account);
  const document = await replacement(value);
  const originalImport = value.oauth.importAuthJson.bind(value.oauth);
  vi.spyOn(value.oauth, 'importAuthJson').mockImplementationOnce(async (...args) => {
    const record = await originalImport(...args);
    await value.repository.updateConfig((config) => ({
      ...config,
      providers: [],
      currentProviderId: null,
    }));
    return record;
  });
  await expect(
    value.accounts.saveAuthJson(value.account, document, undefined, true),
  ).rejects.toThrow('连接已变化');
  expect((await value.repository.config()).providers).toHaveLength(0);
  expect((await value.repository.authRecord(value.connection.id))?.accountId).toBe(
    'synthetic-account',
  );
});
it('uses explicitly pasted credentials to replace a locally invalid record without retaining its invalid flag', async () => {
  const value = await setup();
  await value.repository.saveChatGPTProvider(value.account);
  await value.repository.updateAuthRecord(value.connection.id, (record) => ({
    ...record!,
    invalid: true,
  }));
  const snapshot = await value.accounts.authJson(value.connection.id);
  const result = await value.accounts.saveAuthJson(
    value.account,
    snapshot.json,
    snapshot.revision,
    true,
  );
  const id = result.providers[0]!.chatgpt!.connectionId;
  expect(id).not.toBe(value.connection.id);
  expect((await value.accounts.authJson(id)).invalid).toBe(false);
  expect((await value.accounts.credentials(id)).accessToken === value.accessToken).toBe(true);
});
it('does not reveal raw JSON in parser errors and rejects invalid formats and oversized input', () => {
  for (const raw of [
    'sensitive-sentinel',
    'null',
    '[]',
    '{}',
    '{"tokens":[]}',
    JSON.stringify({ auth_mode: 'apikey', tokens: {} }),
    JSON.stringify({ OPENAI_API_KEY: 'sensitive-sentinel', tokens: {} }),
    JSON.stringify({
      tokens: { access_token: 'x', refresh_token: 'x', id_token: 'x', account_id: 'bad space' },
    }),
    'sensitive-sentinel'.repeat(AUTH_JSON_LIMIT),
  ]) {
    try {
      parseAuthJson(raw);
      throw new Error('Unexpected success');
    } catch (error) {
      expect((error as Error).message).not.toContain('sensitive-sentinel');
      expect((error as Error).message).not.toBe('Unexpected success');
    }
  }
});
it('rejects deleted connections and allows an explicit edit to replace invalid credentials', async () => {
  const value = await setup();
  await value.repository.saveChatGPTProvider(value.account);
  await value.repository.updateAuthRecord(value.connection.id, (record) => ({
    ...record!,
    invalid: true,
  }));
  const snapshot = await value.accounts.authJson(value.connection.id);
  expect(snapshot.invalid).toBe(true);
  await expect(
    value.accounts.saveAuthJson(value.account, snapshot.json, snapshot.revision),
  ).rejects.toThrow('刷新令牌已失效');
  const document = JSON.parse(snapshot.json);
  document.tokens.refresh_token = 'synthetic-replacement-refresh';
  await value.accounts.saveAuthJson(value.account, JSON.stringify(document), snapshot.revision);
  expect((await value.accounts.authJson(value.connection.id)).invalid).toBe(false);
  await value.accounts.disconnect(value.connection.id);
  await expect(
    value.accounts.saveAuthJson(value.account, snapshot.json, snapshot.revision),
  ).rejects.toThrow('不存在');
});
