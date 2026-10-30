import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { browserAuthFixture } from '../tests/helpers/browser-auth';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'glintab-browser-auth-'));
// Reserve then release an ephemeral port: no callback server is ever started.
const reservation = createSocketServer();
await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const callbackUri = `http://127.0.0.1:${(reservation.address() as AddressInfo).port}/auth/callback`;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
let fixture: Awaited<ReturnType<typeof browserAuthFixture>>;
const inference: { body: any; authorization?: string; account?: string }[] = [];
let rejectFirst = true;
let rejectFirstCatalog = true;
const catalogVersions: string[] = [];
const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    console.error('MOCK SERVER ERROR', error instanceof Error ? error.message : 'unknown');
    res.writeHead(500).end();
  });
});
async function handle(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url!, issuer);
  if (url.pathname === '/oauth/authorize') {
    const callback = fixture.authorize(url.href);
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(
      `<title>模拟 OpenAI 授权</title><p>不连接真实账号</p><a href="${callback.href.replaceAll('&', '&amp;')}">确认测试授权</a>`,
    );
    return;
  }
  if (['/oauth/token', '/.well-known/openid-configuration', '/jwks'].includes(url.pathname)) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const response = await fixture.fetcher(url.href, {
      method: req.method,
      body: req.method === 'POST' ? body : undefined,
    });
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(await response.text());
    return;
  }
  if (url.pathname === '/backend-api/codex/models') {
    const version = url.searchParams.get('client_version') || '';
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: [{ loc: ['query', 'client_version'], type: 'missing' }] }));
      return;
    }
    catalogVersions.push(version);
    if (rejectFirstCatalog) {
      rejectFirstCatalog = false;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic catalog failure' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        models: [
          { slug: 'reading-test', visibility: 'list' },
          { slug: 'hidden-test', visibility: 'hidden' },
        ],
      }),
    );
    return;
  }
  if (url.pathname === '/backend-api/codex/responses') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    inference.push({
      body: JSON.parse(raw),
      authorization: req.headers.authorization,
      account: String(req.headers['chatgpt-account-id'] || ''),
    });
    if (rejectFirst) {
      rejectFirst = false;
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ChatGPT 账号阅读摘要：先识别论点，再核对证据。' })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`,
    );
    return;
  }
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  res.end(
    `<title>Reading with ChatGPT</title><article><h1>Read carefully</h1><p>${'Careful reading identifies the central claim and checks supporting evidence. '.repeat(40)}</p></article>`,
  );
}
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
fixture = await browserAuthFixture(issuer, callbackUri);
const extensionPath = path.join(temporary, 'extension');
await cp(path.join(root, 'output/chrome-mv3'), extensionPath, { recursive: true });
async function rewrite(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await rewrite(filename);
    else if (entry.name.endsWith('.js'))
      await writeFile(
        filename,
        (await readFile(filename, 'utf8'))
          .replaceAll('http://127.0.0.1:1455/auth/callback', callbackUri)
          .replaceAll('https://auth.openai.com', issuer)
          .replaceAll('https://chatgpt.com', issuer),
      );
  }
}
await rewrite(extensionPath);
const manifestFile = path.join(extensionPath, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(manifestFile, JSON.stringify(manifest));
await mkdir(path.join(root, 'artifacts/chatgpt'), { recursive: true });
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
try {
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1000, height: 900 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const errors: string[] = [];
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('crash', () => errors.push('renderer crashed'));
  });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole('button', { name: '添加供应商', exact: true }).first().click();
  await options.getByRole('button', { name: 'ChatGPT 账号登录', exact: true }).click();
  await expect(options.getByRole('textbox', { name: 'API Key', exact: true })).toHaveCount(0);
  await options.getByRole('combobox', { name: '推理强度', exact: true }).selectOption('high');
  await expect(options.locator('body')).not.toContainText('npm run auth:bridge');
  const authorization = context.waitForEvent('page');
  await options.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).click();
  const authPage = await authorization;
  await authPage.getByRole('link', { name: '确认测试授权' }).click({ noWaitAfter: true });
  await expect(authPage.getByRole('heading', { name: 'ChatGPT 授权完成' })).toBeVisible({
    timeout: 15000,
  });
  await expect(options.getByText('已授权', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(options.locator('body')).toContainText('账号授权已完成，但模型列表加载失败。');
  await expect(options.locator('body')).toContainText('HTTP 400');
  await options.getByRole('button', { name: '获取模型', exact: true }).click();
  await expect(options.getByRole('combobox', { name: '模型', exact: true })).toHaveValue(
    'reading-test',
  );
  expect(fixture.controls.exchanges).toBe(1); // Catalog failure must not repeat login.
  expect(catalogVersions).toHaveLength(2);
  await expect(options.getByRole('combobox', { name: '推理强度', exact: true })).toHaveValue(
    'high',
  );
  await options.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(options.getByText('使用中', { exact: true })).toBeVisible();
  let saved = await worker.evaluate(() => chrome.storage.local.get('config'));
  expect((saved.config as any).providers[0].reasoningEffort).toBe('high');
  expect(JSON.stringify(saved)).not.toContain(fixture.accessToken);
  expect(JSON.stringify(saved)).not.toContain(fixture.refreshToken);
  expect(JSON.stringify(saved)).not.toContain('idToken');
  const all = await worker.evaluate(() => chrome.storage.local.get(null));
  expect(JSON.stringify(all)).toContain(fixture.accessToken);
  await options.getByRole('button', { name: '编辑 ChatGPT · reader@example.test' }).click();
  const authEditor = options.getByRole('textbox', { name: '账号 auth.json', exact: true });
  await expect
    .poll(async () => (await authEditor.inputValue()).includes('access_token'))
    .toBe(true);
  const authDocument = await authEditor.inputValue();
  expect(JSON.parse(authDocument).tokens.access_token).toBe(fixture.accessToken);
  const replacement = JSON.parse(authDocument);
  replacement.tokens.access_token = 'synthetic-manually-edited-access';
  // A browser expression avoids tsx/esbuild's Node-only __name helper on nested callbacks.
  // The embedded document contains synthetic fixture credentials only.
  await options.evaluate(`
    window.__authClipboard = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__authClipboard = text; },
        readText: async () => ${JSON.stringify(JSON.stringify(replacement))},
      },
    });
  `);
  await options.getByRole('button', { name: '复制 auth.json', exact: true }).click();
  expect(await options.evaluate(() => (window as any).__authClipboard)).toBe(authDocument);
  await options.getByRole('button', { name: '粘贴 auth.json', exact: true }).click();
  await expect(authEditor).toHaveValue(JSON.stringify(replacement));
  await options.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(options.getByText('使用中', { exact: true })).toBeVisible();
  const previousConnection = (saved.config as any).providers[0].chatgpt.connectionId;
  saved = await worker.evaluate(() => chrome.storage.local.get('config'));
  expect((saved.config as any).providers[0].chatgpt.connectionId).not.toBe(previousConnection);
  const editedRecord = await worker.evaluate(
    async (id) => {
      const records = await chrome.storage.local.get('chatgpt-auth:' + id);
      return (records['chatgpt-auth:' + id] as any).accessToken;
    },
    (saved.config as any).providers[0].chatgpt.connectionId,
  );
  expect(editedRecord).toBe('synthetic-manually-edited-access');
  const article = await context.newPage();
  await article.goto(`${issuer}/article`);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    `${issuer}/article`,
  );
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}&mode=window`);
  const deniedAuthRead = await panel.evaluate(
    async (connectionId) =>
      chrome.runtime.sendMessage({
        channel: 'glintab:rpc',
        request: { type: 'chatgpt:auth:get', connectionId },
      }),
    (saved.config as any).providers[0].chatgpt.connectionId,
  );
  expect(deniedAuthRead.ok).toBe(false);
  expect(deniedAuthRead.error).toContain('仅设置页');
  const forbidden = await panel
    .evaluate(
      async (connectionId) => chrome.runtime.sendMessage({ channel: 'glintab:auth', connectionId }),
      (saved.config as any).providers[0].chatgpt.connectionId,
    )
    .catch(() => null);
  expect(JSON.stringify(forbidden ?? null)).not.toContain(fixture.accessToken);
  await panel.getByRole('button', { name: '帮我总结这篇网页' }).click();
  await expect(panel.locator('.message.assistant')).toContainText('ChatGPT 账号阅读摘要', {
    timeout: 15000,
  });
  expect(inference).toHaveLength(2);
  expect(fixture.controls.refreshes).toBe(1);
  expect(inference[1]!.authorization).toBe(`Bearer ${fixture.accessToken}-1`);
  expect(inference[1]!.account).toBe('synthetic-account');
  expect(inference[1]!.body).toMatchObject({ store: false, stream: true });
  expect(inference[0]!.body.reasoning).toEqual({ effort: 'high' });
  expect(inference[1]!.body.reasoning).toEqual({ effort: 'high' });
  expect(inference[1]!.body.reasoning_effort).toBeUndefined();
  expect(inference[1]!.body.max_output_tokens).toBeUndefined();
  expect(inference[1]!.body.instructions).toContain('Read carefully');
  await options.screenshot({
    path: path.join(root, 'artifacts/chatgpt/authorized.png'),
    fullPage: true,
  });
  options.once('dialog', (dialog) => dialog.accept());
  await options.getByRole('button', { name: '删除 ChatGPT · reader@example.test' }).click();
  await expect(options.getByRole('heading', { name: '连接第一个 AI 供应商' })).toBeVisible();
  expect(JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)))).not.toContain(
    fixture.refreshToken,
  );
  expect(errors).toEqual([]);
  await writeFile(
    path.join(root, 'artifacts/chatgpt/results.json'),
    JSON.stringify(
      {
        passed: [
          'OAuth tab and callback without local listener',
          'PKCE and signed identity validation',
          'catalog client_version and retry after 400 without reauthentication',
          'models and configuration save',
          'configured reasoning effort survives login and 401 retry',
          'tokens excluded from routine config and login status responses',
          'auth.json settings editor copies, pastes and manually saves credentials',
          'sidepanel cannot read the settings-only auth.json endpoint',
          'direct Codex Responses via Worker',
          '401 refresh and single retry',
          'account header and stateless payload',
          'local disconnect removes tokens',
          'no page errors',
        ],
        realOpenAIAccountUsed: false,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS browser-only OAuth, no callback listener, direct inference, refresh and local disconnect (synthetic identity).',
  );
} catch (error) {
  if (context)
    for (const page of context.pages())
      console.error(
        'TEST PAGE',
        new URL(page.url()).pathname,
        (
          await page
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 1500),
      );
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
}
