import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'glintab-e2e-'));
const extensionPath = path.join(temporary, 'extension');
await cp(path.join(root, 'output/chrome-mv3'), extensionPath, { recursive: true });
// Only this disposable test copy grants loopback access at install time.
// Production retains optional host permissions and the real user consent flow.
const manifestPath = path.join(extensionPath, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(manifestPath, JSON.stringify(manifest));
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const requests = [];
const timers = new Set();
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'reading-test' }] }));
    return;
  }
  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const question = body.messages?.at(-1)?.content || body.input?.at(-1)?.content || '';
    if (question.includes('ERROR_429')) {
      res.writeHead(429).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunks = question.includes('SLOW')
      ? ['正在', '逐步', '分析', '网页', '中的', '关键', '证据', '。']
      : [
          '## 阅读摘要\n\n',
          '这篇文章强调以证据为基础的阅读。\n\n',
          '- 先识别核心论点\n',
          '- 再检查原始证据\n\n',
          '保留独立思考。',
        ];
    let index = 0;
    const timer = setInterval(
      () => {
        if (index < chunks.length) {
          const delta = chunks[index++];
          if (req.url === '/v1/messages')
            res.write(
              `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta } })}\n\n`,
            );
          else if (req.url === '/v1/responses')
            res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
          else
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
        } else {
          const end =
            req.url === '/v1/messages'
              ? JSON.stringify({ type: 'message_stop' })
              : req.url === '/v1/responses'
                ? JSON.stringify({ type: 'response.completed' })
                : '[DONE]';
          res.end(`data: ${end}\n\n`);
          clearInterval(timer);
          timers.delete(timer);
        }
      },
      question.includes('SLOW') ? 350 : 80,
    );
    timers.add(timer);
    res.on('close', () => {
      clearInterval(timer);
      timers.delete(timer);
    });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    `<!doctype html><html><head><title>Evidence and thoughtful reading</title></head><body style="font:18px/1.9 system-ui;max-width:780px;margin:70px auto;padding:25px"><nav>Reading journal</nav><article><h1>Evidence and thoughtful reading</h1><p>A reading practice starts with a question, checks the evidence, and keeps room for uncertainty.</p>${Array.from({ length: 10 }, (_, i) => `<h2>Reading principle ${i + 1}</h2><p>Readers should examine a claim carefully and compare it to its original evidence. A summary helps organize the information, but it must preserve the facts and limitations. Distinguish what the author observed from what they inferred.</p>`).join('')}<a href="/reference">Original reference</a></article></body></html>`,
  );
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let context;
const failures = [];
const passed = [];
async function step(name, run) {
  console.log(`CHECK ${name}`);
  await run();
  passed.push(name);
  console.log(`PASS ${name}`);
}
async function capture(page, filename, fullPage = false) {
  await page.bringToFront();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.screenshot({ path: path.join(root, 'artifacts', filename), fullPage });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
try {
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    // Chromium can misroute OOPIF input after per-tab viewport overrides in the
    // same persistent window. Keep dimensions identical until drawer tests end.
    viewport: { width: 420, height: 820 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const extensionUrl = `chrome-extension://${extensionId}`;
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const options = await context.newPage();
  await options.goto(`${extensionUrl}/options.html`);
  await step('settings empty state and real provider form', async () => {
    await expect(options.getByRole('heading', { name: '连接第一个 AI 供应商' })).toBeVisible();
    await capture(options, 'settings-empty.png', true);
    await options.getByRole('button', { name: '添加供应商', exact: true }).first().click();
    await options.getByLabel('供应商名称').fill('本地验收模型');
    await options.getByLabel('Base URL').fill(`${baseUrl}/v1`);
    await options.getByLabel('API Key', { exact: true }).fill('test-only-not-a-real-secret');
    await options.getByLabel('模型', { exact: true }).fill('reading-test');
    await options.getByRole('button', { name: '保存并授权' }).click();
    await expect(options.getByText('使用中', { exact: true })).toBeVisible();
    await capture(options, 'settings-configured.png', true);
  });
  const article = await context.newPage();
  await article.goto(`${baseUrl}/article`);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    `${baseUrl}/article`,
  );
  async function openPanel(sourceTabId = tabId) {
    const page = await context.newPage();
    await page.goto(`${extensionUrl}/sidepanel.html?tabId=${sourceTabId}&mode=window`);
    return page;
  }
  let panel = await openPanel();
  await step('sidepanel cold start and summary via real offscreen worker', async () => {
    await expect(panel.getByRole('button', { name: '帮我总结这篇网页' })).toBeEnabled();
    await capture(panel, 'panel-empty.png');
    await panel.getByRole('button', { name: '帮我总结这篇网页' }).click();
    await expect(panel.getByText('保留独立思考。', { exact: false })).toBeVisible({
      timeout: 15000,
    });
    await expect(panel.getByRole('button', { name: '发送问题' })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].messages[0].content).toContain('Reading principle');
    await capture(panel, 'panel-answer.png');
  });
  await step('content dialog exposes real extraction and closes with Escape', async () => {
    await panel.getByRole('button', { name: '查看正文' }).click();
    await expect(panel.getByRole('dialog')).toContainText('Reading principle');
    await panel.keyboard.press('Escape');
    await expect(panel.getByRole('dialog')).toHaveCount(0);
  });
  await step('follow-up reuses source and editing replaces its previous answer', async () => {
    await panel
      .getByRole('textbox', { name: '向当前网页提问' })
      .fill('What evidence supports the argument?');
    await panel.getByRole('button', { name: '发送问题' }).click();
    await expect(panel.locator('.message.assistant')).toHaveCount(2);
    await expect(panel.getByRole('button', { name: '编辑问题' })).toBeVisible();
    expect(requests.at(-1).messages).toHaveLength(4);
    await panel.getByRole('button', { name: '编辑问题' }).click();
    await panel
      .getByRole('textbox', { name: '向当前网页提问' })
      .fill('Please revise the question.');
    await panel.getByRole('button', { name: '发送问题' }).click();
    await expect(panel.getByRole('button', { name: '编辑问题' })).toBeVisible();
    await expect(panel.locator('.message.user')).toHaveCount(1);
    await expect(panel.locator('.message.user')).toContainText('Please revise');
  });
  await step('close UI during generation and reopen using live task snapshot', async () => {
    await panel.getByRole('textbox', { name: '向当前网页提问' }).fill('SLOW recovery test');
    await panel.getByRole('button', { name: '发送问题' }).click();
    await expect(panel.getByRole('button', { name: '停止生成' })).toBeVisible();
    await panel.close();
    panel = await openPanel();
    await expect(panel.getByRole('button', { name: '停止生成' })).toBeVisible();
    await expect(panel.getByText('正在逐步分析网页中的关键证据。', { exact: false })).toBeVisible({
      timeout: 10000,
    });
    await expect(panel.getByRole('button', { name: '编辑问题' })).toBeVisible();
  });
  await step(
    'two tabs at the same URL run independently and stop preserves partial text',
    async () => {
      const secondArticle = await context.newPage();
      await secondArticle.goto(`${baseUrl}/article`);
      const secondTabId = await worker.evaluate(
        async (first) =>
          (await chrome.tabs.query({})).find(
            (tab) => tab.url?.endsWith('/article') && tab.id !== first,
          ).id,
        tabId,
      );
      const secondPanel = await openPanel(secondTabId);
      await expect(secondPanel.getByRole('textbox', { name: '向当前网页提问' })).toBeEnabled();
      for (const page of [panel, secondPanel]) {
        await page.getByRole('textbox', { name: '向当前网页提问' }).fill('SLOW independent tabs');
        await page.getByRole('button', { name: '发送问题' }).click();
        await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
      }
      await expect(panel.locator('.message.assistant').last()).toContainText('正在');
      await panel.getByRole('button', { name: '停止生成' }).click();
      await expect(panel.getByText('已停止，生成内容已保留。')).toBeVisible();
      await expect(secondPanel.getByRole('button', { name: '停止生成' })).toBeVisible();
      await expect(secondPanel.locator('.message.assistant').last()).toContainText(
        '正在逐步分析网页中的关键证据。',
        { timeout: 10000 },
      );
      await secondPanel.close();
      await secondArticle.close();
    },
  );
  await step('drawer injects once, embeds the right tab and closes from its iframe', async () => {
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        files: ['content-scripts/drawer.js'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: id },
        files: ['content-scripts/drawer.js'],
      });
      await chrome.tabs.sendMessage(id, { channel: 'glintab:drawer', open: true });
    }, tabId);
    await expect(article.locator('#glintab-drawer-host')).toHaveCount(1);
    await expect
      .poll(() =>
        article.frames().some((frame) => frame.url().includes(`tabId=${tabId}&mode=drawer`)),
      )
      .toBe(true);
    const frame = article.frames().find((frame) => frame.url().includes('&mode=drawer'));
    await expect(frame.getByRole('button', { name: '关闭侧栏' })).toBeVisible();
    const embeddedElement = await frame.frameElement();
    await expect
      .poll(() =>
        embeddedElement.evaluate(
          (element) => Math.abs(element.getBoundingClientRect().right - innerWidth) < 1,
        ),
      )
      .toBe(true);
    await capture(article, 'drawer-open.png');
    await frame.getByRole('button', { name: '复制回答', exact: true }).first().click();
    await expect(frame.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
    await frame.getByRole('button', { name: '关闭侧栏' }).click();
    await expect
      .poll(() =>
        embeddedElement.evaluate((element) => element.getBoundingClientRect().left >= innerWidth),
      )
      .toBe(true);
    await article.screenshot({ path: path.join(root, 'artifacts/drawer-closed.png') });
  });
  await step('HTTP errors are visible and do not leave generation stuck', async () => {
    await panel.getByRole('textbox', { name: '向当前网页提问' }).fill('ERROR_429');
    await panel.getByRole('button', { name: '发送问题' }).click();
    await expect(panel.getByRole('alert')).toContainText('429');
    await expect(panel.getByRole('textbox', { name: '向当前网页提问' })).toBeEnabled();
  });
  await step('direct first question makes exactly one request without a summary turn', async () => {
    await article.goto(`${baseUrl}/direct-question`);
    await expect(panel.getByRole('button', { name: '帮我总结这篇网页' })).toBeEnabled();
    const before = requests.length;
    await panel
      .getByRole('textbox', { name: '向当前网页提问' })
      .fill('Explain the argument directly.');
    await panel.getByRole('button', { name: '发送问题' }).click();
    await expect(panel.getByRole('button', { name: '编辑问题' })).toBeVisible();
    expect(requests.length - before).toBe(1);
    expect(requests.at(-1).messages).toHaveLength(2);
    expect(requests.at(-1).messages.at(-1).content).toBe('Explain the argument directly.');
  });
  await step('settings synchronize to open panels and model list remains usable', async () => {
    await options.getByRole('button', { name: '摘要指令', exact: true }).click();
    await options
      .getByRole('textbox', { name: '网页摘要指令' })
      .fill('请用三点总结网页，只依据原文。');
    await options.getByRole('button', { name: '保存指令' }).click();
    await expect(options.getByRole('status')).toContainText('设置已保存');
    await article.goto(`${baseUrl}/custom-summary`);
    await expect(panel.getByRole('button', { name: '帮我总结这篇网页' })).toBeEnabled();
    await panel.getByRole('button', { name: '帮我总结这篇网页' }).click();
    await expect(panel.getByRole('button', { name: '重新摘要' })).toBeVisible();
    expect(requests.at(-1).messages.at(-1).content).toBe('请用三点总结网页，只依据原文。');
    await options.getByRole('button', { name: 'AI 供应商', exact: true }).click();
    await options.getByRole('button', { name: '编辑 本地验收模型' }).click();
    await options.getByRole('button', { name: '获取模型', exact: true }).click();
    await expect(options.locator('#model-list option')).toHaveAttribute('value', 'reading-test');
    await options.getByRole('button', { name: '取消', exact: true }).click();
  });
  for (const [format, label] of [
    ['openai_responses', 'Responses 验收'],
    ['anthropic', 'Anthropic 验收'],
  ]) {
    await step(
      `${format} completes the real background/offscreen/worker request path`,
      async () => {
        await options.getByRole('button', { name: '添加供应商', exact: true }).first().click();
        await options.getByLabel('供应商名称').fill(label);
        await options.getByLabel('API 协议').selectOption(format);
        await options.getByLabel('Base URL').fill(`${baseUrl}/v1`);
        await options.getByLabel('API Key', { exact: true }).fill('test-only');
        await options.getByLabel('模型', { exact: true }).fill('reading-test');
        await options.getByRole('button', { name: '保存并授权' }).click();
        const row = options
          .locator('.provider-row')
          .filter({ has: options.getByText(label, { exact: true }) });
        await row.getByRole('button', { name: '使用', exact: true }).click();
        await expect(row.getByText('使用中', { exact: true })).toBeVisible();
        await expect(panel.locator('.provider-select select')).toContainText(label);
        await article.goto(`${baseUrl}/protocol-${format}`);
        await expect(panel.getByRole('button', { name: '帮我总结这篇网页' })).toBeEnabled();
        await panel.getByRole('button', { name: '帮我总结这篇网页' }).click();
        await expect(panel.getByRole('button', { name: '重新摘要' })).toBeVisible();
        await expect(panel.locator('.message.assistant')).toContainText('保留独立思考。');
      },
    );
  }
  await step(
    'deleting current provider falls back and clearing data updates every panel',
    async () => {
      options.once('dialog', (dialog) => dialog.accept());
      await options.getByRole('button', { name: '删除 Anthropic 验收' }).click();
      await expect(
        options
          .locator('.provider-row')
          .filter({ has: options.getByText('本地验收模型', { exact: true }) })
          .getByText('使用中', { exact: true }),
      ).toBeVisible();
      await options.getByRole('button', { name: '通用设置', exact: true }).click();
      options.once('dialog', (dialog) => dialog.accept());
      await options.getByRole('button', { name: '清除全部本地数据' }).click();
      await expect(options.getByRole('status')).toContainText('所有本地数据已清除');
      await expect(panel.locator('.provider-select select')).toContainText('选择模型');
      await expect(panel.locator('.message')).toHaveCount(0);
      const stored = await worker.evaluate(() => chrome.storage.local.get(null));
      expect(stored).toEqual({});
    },
  );
  await step('narrow layouts have no horizontal page overflow', async () => {
    await panel.setViewportSize({ width: 280, height: 700 });
    await options.setViewportSize({ width: 360, height: 780 });
    for (const page of [panel, options])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    await capture(panel, 'panel-narrow.png');
    await capture(options, 'settings-narrow.png', true);
  });
  await step('no page JavaScript exceptions', async () => {
    expect(errors).toEqual([]);
  });
  await writeFile(
    path.join(root, 'artifacts/e2e-results.json'),
    JSON.stringify(
      {
        browser: context.browser()?.version(),
        passed,
        requests: requests.length,
        failures,
        testPermissionOverride: 'loopback host permission in disposable copy only',
      },
      null,
      2,
    ),
  );
  console.log(`Validated ${passed.length} browser scenarios.`);
} catch (error) {
  failures.push(String(error));
  await writeFile(
    path.join(root, 'artifacts/e2e-results.json'),
    JSON.stringify({ passed, failures }, null, 2),
  );
  if (context)
    for (const [index, page] of context.pages().entries()) {
      await page
        .screenshot({ path: path.join(root, `artifacts/failure-${index}.png`) })
        .catch(() => {});
      console.error(
        'PAGE',
        page.url(),
        (
          await page
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(-4000),
      );
    }
  throw error;
} finally {
  await context?.close();
  for (const timer of timers) clearInterval(timer);
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
