import { expect, it } from 'vitest';
import { browserAuthFixture } from './helpers/browser-auth';
import { ChatGPTAccounts } from '../lib/auth/accounts';
import { provider } from './fixtures';
import { CHATGPT_PROVIDER_URL } from '../config/chatgpt';

async function connected(value: Awaited<ReturnType<typeof browserAuthFixture>>) {
  const flow = await value.accounts.start();
  const [tabId, url] = [...value.tabs].at(-1)!;
  const callback = value.authorize(url);
  await value.accounts.observe(tabId, callback.href);
  const result = await value.accounts.status(flow.flowId, flow.statusKey);
  expect(result.status).toBe('connected');
  return { flow, tabId, callback, connection: result.connection! };
}
it('uses PKCE and signed identity without exposing tokens in status/config', async () => {
  const value = await browserAuthFixture();
  const { flow, connection, tabId, callback } = await connected(value);
  expect((await value.repository.authRecord(connection.id))?.accountId).toBe('synthetic-account');
  expect(JSON.stringify(await value.accounts.status(flow.flowId, flow.statusKey))).not.toContain(
    value.accessToken,
  );
  await value.repository.saveChatGPTProvider({
    ...provider,
    authType: 'chatgpt',
    baseUrl: CHATGPT_PROVIDER_URL,
    chatgpt: { connectionId: connection.id, email: '', draftKey: connection.draftKey },
  });
  expect(JSON.stringify(await value.repository.config())).not.toContain(value.accessToken);
  expect(JSON.stringify(await value.repository.config())).not.toContain(connection.draftKey);
  await value.accounts.observe(tabId, callback.href);
  expect(value.controls.exchanges).toBe(1);
});
it('pins callbacks to the login tab, origin, port, path and state', async () => {
  const value = await browserAuthFixture(),
    flow = await value.accounts.start();
  const [id, url] = [...value.tabs].at(-1)!,
    callback = value.authorize(url);
  await value.accounts.observe(id + 1, callback.href);
  for (const raw of [
    callback.href.replace('127.0.0.1', 'evil.example'),
    callback.href.replace(':1455', ':1456'),
    callback.href.replace('/auth/callback', '/wrong'),
  ])
    await value.accounts.observe(id, raw);
  expect(value.controls.exchanges).toBe(0);
  callback.searchParams.set('state', 'wrong');
  await value.accounts.observe(id, callback.href);
  expect((await value.accounts.status(flow.flowId, flow.statusKey)).status).toBe('error');
  expect(value.controls.exchanges).toBe(0);
});
it.each(['nonce', 'audience', 'account'] as const)(
  'rejects invalid %s and never saves a credential',
  async (field) => {
    const value = await browserAuthFixture(),
      flow = await value.accounts.start();
    const [id, url] = [...value.tabs].at(-1)!;
    if (field === 'nonce') value.controls.nonce = 'wrong';
    if (field === 'audience') value.controls.audience = 'wrong';
    if (field === 'account') value.controls.accountId = '';
    await value.accounts.observe(id, value.authorize(url).href);
    expect((await value.accounts.status(flow.flowId, flow.statusKey)).status).toBe('error');
    expect(JSON.stringify(value.local.data)).not.toContain(value.accessToken);
  },
);
it('recovers pending login across background restarts and can poll a failed navigation URL', async () => {
  const value = await browserAuthFixture(),
    flow = await value.accounts.start();
  const [id, url] = [...value.tabs].at(-1)!;
  value.tabs.set(id, value.authorize(url).href);
  const restarted = new ChatGPTAccounts(
    value.repository,
    value.sessionRepository,
    value.browser,
    value.oauth,
  );
  await restarted.recover();
  expect((await restarted.status(flow.flowId, flow.statusKey)).status).toBe('connected');
});
it('serializes refresh and 401 retries and persists a rotated refresh token', async () => {
  const value = await browserAuthFixture(),
    { connection } = await connected(value);
  await value.repository.updateAuthRecord(connection.id, (record) => ({
    ...record!,
    expiresAt: 0,
  }));
  const credentials = await Promise.all(
    Array.from({ length: 5 }, () => value.accounts.credentials(connection.id)),
  );
  expect(value.controls.refreshes).toBe(1);
  await Promise.all(
    credentials.map((credential) => value.accounts.credentials(connection.id, credential.revision)),
  );
  expect(value.controls.refreshes).toBe(2);
  expect((await value.repository.authRecord(connection.id))?.refreshToken).toBe(
    value.refreshToken + '-2',
  );
});
it('does not consume a refresh token if the durable refresh marker cannot be saved', async () => {
  const value = await browserAuthFixture(),
    { connection } = await connected(value);
  await value.repository.updateAuthRecord(connection.id, (record) => ({
    ...record!,
    expiresAt: 0,
  }));
  value.local.fail = true;
  await expect(value.accounts.credentials(connection.id)).rejects.toThrow();
  expect(value.controls.refreshes).toBe(0);
});
it('requires reauthorization after rotated credentials fail to persist, including after restart', async () => {
  const value = await browserAuthFixture(),
    { connection } = await connected(value);
  await value.repository.updateAuthRecord(connection.id, (record) => ({
    ...record!,
    expiresAt: 0,
  }));
  value.controls.afterRefresh = () => {
    value.local.fail = true;
  };
  await expect(value.accounts.credentials(connection.id)).rejects.toThrow('保存失败');
  value.local.fail = false;
  const restarted = new ChatGPTAccounts(
    value.repository,
    value.sessionRepository,
    value.browser,
    value.oauth,
  );
  await expect(restarted.credentials(connection.id)).rejects.toThrow('失效');
  expect(value.controls.refreshes).toBe(1);
});
it('cancels login without exchanging, and discards an unsaved connected account', async () => {
  const value = await browserAuthFixture(),
    flow = await value.accounts.start();
  const [id, url] = [...value.tabs].at(-1)!;
  await value.accounts.cancel(flow.flowId, flow.statusKey);
  await value.accounts.observe(id, value.authorize(url).href);
  expect(value.controls.exchanges).toBe(0);
  const { connection } = await connected(value);
  await value.accounts.discard(connection.id, 'wrong');
  expect(await value.repository.authRecord(connection.id)).toBeDefined();
  await value.accounts.discard(connection.id, connection.draftKey);
  expect(await value.repository.authRecord(connection.id)).toBeUndefined();
});
it('does not resurrect an account when cancel races with code exchange', async () => {
  const value = await browserAuthFixture(),
    flow = await value.accounts.start();
  const [id, url] = [...value.tabs].at(-1)!;
  let release!: () => void, entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  value.controls.afterExchange = () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const exchange = value.accounts.observe(id, value.authorize(url).href);
  await entering;
  const cancel = value.accounts.cancel(flow.flowId, flow.statusKey);
  release();
  await Promise.all([exchange, cancel]);
  expect(JSON.stringify(value.local.data)).not.toContain(value.accessToken);
  expect((await value.accounts.status(flow.flowId, flow.statusKey)).status).toBe('cancelled');
});
it('keeps the original identity when reconnect selects another account', async () => {
  const value = await browserAuthFixture(),
    { connection } = await connected(value);
  const original = await value.repository.authRecord(connection.id);
  const flow = await value.accounts.start({
    ...provider,
    authType: 'chatgpt',
    chatgpt: { connectionId: connection.id, email: '' },
  });
  const [id, url] = [...value.tabs].at(-1)!;
  value.controls.accountId = 'different-account';
  await value.accounts.observe(id, value.authorize(url).href);
  expect((await value.accounts.status(flow.flowId, flow.statusKey)).status).toBe('error');
  expect(await value.repository.authRecord(connection.id)).toEqual(original);
});

it('keeps committed credentials when draft cleanup races with saving the provider', async () => {
  const value = await browserAuthFixture(),
    { connection } = await connected(value);
  await Promise.all([
    value.repository.saveChatGPTProvider({
      ...provider,
      authType: 'chatgpt',
      chatgpt: { connectionId: connection.id, email: '' },
    }),
    value.accounts.discard(connection.id, connection.draftKey),
  ]);
  expect(await value.repository.authRecord(connection.id)).toBeDefined();
});
it('cleans expired unsaved credentials while preserving committed connections', async () => {
  const value = await browserAuthFixture(),
    first = await connected(value),
    second = await connected(value);
  await value.repository.saveChatGPTProvider({
    ...provider,
    authType: 'chatgpt',
    chatgpt: { connectionId: first.connection.id, email: '' },
  });
  await value.sessionRepository.updateAuthFlows((flows) =>
    Object.fromEntries(Object.entries(flows).map(([id, flow]) => [id, { ...flow, expiresAt: 0 }])),
  );
  await value.accounts.cleanup();
  expect(await value.repository.authRecord(first.connection.id)).toBeDefined();
  expect(await value.repository.authRecord(second.connection.id)).toBeUndefined();
  expect(await value.sessionRepository.authFlows()).toEqual({});
});
it('interrupts a claimed callback on restart instead of consuming its code again', async () => {
  const value = await browserAuthFixture(),
    flow = await value.accounts.start();
  await value.sessionRepository.updateAuthFlows((flows) => ({
    ...flows,
    [flow.flowId]: { ...flows[flow.flowId]!, status: 'exchanging' },
  }));
  const restarted = new ChatGPTAccounts(
    value.repository,
    value.sessionRepository,
    value.browser,
    value.oauth,
  );
  await restarted.recover();
  expect((await restarted.status(flow.flowId, flow.statusKey)).status).toBe('error');
  expect(value.controls.exchanges).toBe(0);
});
