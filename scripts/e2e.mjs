import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const development = process.argv.includes('--dev');
const artifactPath = path.join(root, 'artifacts', ...(development ? ['development'] : []));
const temporary = await mkdtemp(path.join(tmpdir(), 'glintab-e2e-'));
const extensionPath = path.join(temporary, 'extension');
await cp(
  process.env.GLINTAB_E2E_EXTENSION_DIR ||
    path.join(root, development ? 'output/chrome-mv3-dev' : 'output/chrome-mv3'),
  extensionPath,
  { recursive: true },
);
// Only this disposable test copy grants loopback and mocked video origins at install time.
// Production retains optional host permissions and the real user consent flow.
const manifestPath = path.join(extensionPath, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [
  ...new Set([
    ...(manifest.host_permissions || []),
    'http://127.0.0.1/*',
    'https://www.youtube.com/*',
    'https://www.bilibili.com/*',
  ]),
];
await writeFile(manifestPath, JSON.stringify(manifest));
await mkdir(artifactPath, { recursive: true });
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
    const failure = /ERROR_(400|429|503)/.exec(question);
    if (failure) {
      res.writeHead(Number(failure[1]), { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          error: { param: 'stream', message: 'unsupported stream; private-provider-diagnostics' },
        }),
      );
      return;
    }
    const chunks = question.includes('SLOW')
      ? ['正在', '逐步', '分析', '网页', '中的', '关键', '证据', '。']
      : [
          '## 阅读摘要\n\n',
          '这篇文章强调以证据为基础的阅读。\n\n',
          '- 先识别核心论点\n',
          '- 再检查原始证据\n\n',
          '保留独立思考。',
        ];
    if (body.stream === false) {
      const text = chunks.join('');
      const result =
        req.url === '/v1/responses'
          ? {
              output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
              ],
            }
          : req.url === '/v1/messages'
            ? { content: [{ type: 'text', text }] }
            : { choices: [{ message: { content: text } }] };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
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
const errors = [];
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
      await page.screenshot({ path: path.join(artifactPath, filename), fullPage });
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
  context.on('page', (page) =>
    page
      .on('crash', () => errors.push('页面渲染进程崩溃'))
      .on('pageerror', (error) => {
        errors.push(error.message);
        console.error('BROWSER ERROR', error.message);
      }),
  );
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
    await expect(options.getByRole('combobox', { name: '推理强度', exact: true })).toHaveValue('');
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
    expect(requests[0]).not.toHaveProperty('reasoning_effort');
    expect(requests[0]).not.toHaveProperty('reasoning');
    await capture(panel, 'panel-answer.png');
  });
  await step('content dialog exposes real extraction and closes with Escape', async () => {
    await panel.getByRole('button', { name: '查看正文' }).click();
    await expect(panel.getByRole('dialog')).toContainText('Reading principle');
    await panel.keyboard.press('Escape');
    await expect(panel.getByRole('dialog')).toHaveCount(0);
  });
  await step(
    'YouTube captions cross MAIN world, background and worker with timestamp citations',
    async () => {
      const videoUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
      let delayCaption = false;
      let releaseCaption;
      await context.route('https://www.youtube.com/**', async (route) => {
        if (route.request().url().includes('/api/timedtext')) {
          if (delayCaption)
            await new Promise((resolve) => {
              releaseCaption = resolve;
            });
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              events: [
                { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: '视频字幕中的独立证据。' }] },
                { tStartMs: 65000, dDurationMs: 3000, segs: [{ utf8: '一分钟后的关键结论。' }] },
              ],
            }),
          });
        } else
          await route.fulfill({
            contentType: 'text/html',
            body: `<html><title>Video fixture</title><body><nav>Do not summarize this navigation</nav><div id="movie_player"></div><script>
        const player = document.getElementById('movie_player');
        player.getPlayerResponse = () => ({ videoDetails: { videoId: new URL(location.href).searchParams.get('v'), title: '视频字幕验收' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: new URL(location.href).searchParams.get('v') === 'nocaption12' ? [] : [{ languageCode: 'zh-Hans', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-Hans' }] } } });
        </script></body></html>`,
          });
      });
      const video = await context.newPage();
      await video.goto(videoUrl);
      const videoTabId = await worker.evaluate(
        async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
        videoUrl,
      );
      const videoPanel = await openPanel(videoTabId);
      try {
        await videoPanel.getByRole('button', { name: '帮我总结这个视频' }).click();
        await expect(videoPanel.getByRole('button', { name: '查看字幕' })).toBeVisible();
        const system = requests.at(-1).messages[0].content;
        expect(system).toContain('视频字幕中的独立证据');
        expect(system).toContain('[01:05](https://www.youtube.com/watch?v=abcdefghijk&t=65s)');
        expect(system).toContain('do not claim to have watched visuals');
        expect(system).not.toContain('Do not summarize this navigation');
        await videoPanel.getByRole('button', { name: '查看字幕' }).click();
        await expect(videoPanel.getByRole('dialog')).toContainText('自动字幕，可能有误');
        await expect(videoPanel.getByRole('link', { name: '01:05' })).toHaveAttribute(
          'href',
          videoUrl + '&t=65s',
        );
        await videoPanel.keyboard.press('Escape');
        const before = requests.length;
        await videoPanel
          .getByRole('textbox', { name: '向当前视频提问' })
          .fill('请解释字幕中的结论');
        await videoPanel.getByRole('button', { name: '发送问题' }).click();
        await expect.poll(() => requests.length).toBe(before + 1);
        await expect(videoPanel.locator('.message.assistant').last()).toContainText(
          '保留独立思考。',
        );
        await expect(videoPanel.getByRole('button', { name: '查看字幕' })).toBeVisible();
        await videoPanel.reload();
        await expect(videoPanel.getByRole('button', { name: '查看字幕' })).toBeVisible();
        // The old result must not satisfy another extraction after an SPA switch.
        delayCaption = true;
        const pending = videoPanel.evaluate(
          async ({ tabId, url }) =>
            chrome.runtime.sendMessage({
              channel: 'glintab:rpc',
              request: { type: 'page:extract', tabId, expectedPageKey: url },
            }),
          { tabId: videoTabId, url: videoUrl },
        );
        await expect.poll(() => !!releaseCaption).toBe(true);
        const duplicate = await videoPanel.evaluate(
          async ({ tabId, url }) =>
            chrome.runtime.sendMessage({
              channel: 'glintab:rpc',
              request: { type: 'page:extract', tabId, expectedPageKey: url },
            }),
          { tabId: videoTabId, url: videoUrl },
        );
        expect(duplicate.error).toContain('正在提取内容');
        await video.evaluate(() => history.pushState({}, '', '?v=nocaption12'));
        delayCaption = false;
        releaseCaption();
        expect((await pending).error).toContain('视频已变化');
        await expect(videoPanel.getByRole('button', { name: '帮我总结这个视频' })).toBeEnabled();
        const previous = requests.length;
        await videoPanel.getByRole('button', { name: '帮我总结这个视频' }).click();
        await expect(videoPanel.getByRole('alert')).toContainText('没有可读取的字幕');
        expect(requests.length).toBe(previous);
        await capture(videoPanel, 'video-no-captions.png');
      } finally {
        await videoPanel.close();
        await video.close();
      }
    },
  );
  await step('Bilibili current part captions and login errors use page credentials', async () => {
    const videoUrl = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2';
    await context.route('https://www.bilibili.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><title>Bilibili fixture</title><body>Video navigation only</body></html>',
      }),
    );
    let loginRequired = false;
    await context.route('https://api.bilibili.com/**', async (route) => {
      const origin = 'https://www.bilibili.com';
      const headers = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
      };
      const url = new URL(route.request().url());
      const data = url.pathname.endsWith('/view')
        ? {
            bvid: 'BV1xx411c7mD',
            title: '分 P 字幕验收',
            pages: [
              { page: 1, cid: 111, part: '第一部分' },
              { page: 2, cid: 222, part: '第二部分' },
            ],
          }
        : loginRequired
          ? { need_login_subtitle: true }
          : {
              cid: Number(url.searchParams.get('cid')),
              subtitle: {
                subtitles: [
                  { lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/test.json' },
                ],
              },
            };
      await route.fulfill({
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data }),
      });
    });
    await context.route('https://aisubtitle.hdslb.com/**', (route) =>
      route.fulfill({
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ body: [{ from: 12, to: 16, content: '第二分 P 的字幕证据' }] }),
      }),
    );
    const video = await context.newPage();
    await video.goto(videoUrl);
    const videoTabId = await worker.evaluate(
      async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
      videoUrl,
    );
    const videoPanel = await openPanel(videoTabId);
    try {
      await videoPanel.getByRole('button', { name: '帮我总结这个视频' }).click();
      await expect(videoPanel.getByRole('button', { name: '查看字幕' })).toBeVisible();
      expect(requests.at(-1).messages[0].content).toContain('?p=2&t=12');
      await videoPanel.getByRole('button', { name: '查看字幕' }).click();
      await expect(videoPanel.getByRole('dialog')).toContainText('第二分 P 的字幕证据');
      await capture(videoPanel, 'video-captions.png');
      await videoPanel.keyboard.press('Escape');
      loginRequired = true;
      await video.goto(videoUrl.replace('p=2', 'p=1'));
      await expect(videoPanel.getByRole('button', { name: '帮我总结这个视频' })).toBeEnabled();
      const before = requests.length;
      await videoPanel.getByRole('button', { name: '帮我总结这个视频' }).click();
      await expect(videoPanel.getByRole('alert')).toContainText('需要登录 B 站');
      expect(requests.length).toBe(before);
    } finally {
      await videoPanel.close();
      await video.close();
    }
  });
  await step(
    'ungranted sites offer one-time all-sites access and preserve the question',
    async () => {
      const url = 'http://ungranted.test/article';
      await context.route(url, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html><title>Permission test</title><body><article>Permission test</article></body></html>',
        }),
      );
      const ungranted = await context.newPage();
      await ungranted.goto(url);
      const sourceTabId = await worker.evaluate(
        async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
        url,
      );
      const deniedPanel = await openPanel(sourceTabId);
      await expect(deniedPanel.getByRole('button', { name: '帮我总结这篇网页' })).toBeEnabled();
      await deniedPanel.getByRole('textbox', { name: '向当前网页提问' }).fill('Keep my question');
      for (let attempt = 0; attempt < 2; attempt++) {
        await deniedPanel.getByRole('button', { name: '发送问题' }).click();
        await expect(deniedPanel.getByRole('alert')).toContainText('尚未获得此网站的读取权限');
        await expect(
          deniedPanel.getByRole('button', { name: '一次授权所有网站', exact: true }),
        ).toBeVisible();
        await expect(
          deniedPanel.getByRole('button', { name: '仅授权当前网站', exact: true }),
        ).toBeVisible();
        await expect(deniedPanel.getByRole('textbox', { name: '向当前网页提问' })).toHaveValue(
          'Keep my question',
        );
        await expect(deniedPanel.getByRole('button', { name: '发送问题' })).toBeEnabled();
      }
      await deniedPanel.close();
      await ungranted.close();
      await context.unroute(url);
      await panel.bringToFront();
    },
  );
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
    await article.screenshot({ path: path.join(artifactPath, 'drawer-closed.png') });
  });
  await step('HTTP errors are visible and do not leave generation stuck', async () => {
    for (const status of [429, 400, 503]) {
      await panel.getByRole('textbox', { name: '向当前网页提问' }).fill(`ERROR_${status}`);
      await panel.getByRole('button', { name: '发送问题' }).click();
      await expect(panel.getByRole('alert')).toContainText(String(status));
      await expect(panel.getByRole('alert')).not.toContainText('private-provider-diagnostics');
      if (status === 400) await expect(panel.getByRole('alert')).toContainText('参数：stream');
      await expect(panel.getByRole('textbox', { name: '向当前网页提问' })).toBeEnabled();
    }
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
    const videoPrompt = '请按时间线总结视频字幕，引用关键时间戳。';
    await options.getByRole('textbox', { name: '视频摘要指令' }).fill(videoPrompt);
    await options.getByRole('button', { name: '保存指令' }).click();
    await expect(options.getByRole('status')).toContainText('设置已保存');
    await article.goto(`${baseUrl}/custom-summary`);
    await expect(panel.getByRole('button', { name: '帮我总结这篇网页' })).toBeEnabled();
    await panel.getByRole('button', { name: '帮我总结这篇网页' }).click();
    await expect(panel.getByRole('button', { name: '重新摘要' })).toBeVisible();
    expect(requests.at(-1).messages.at(-1).content).toBe('请用三点总结网页，只依据原文。');
    // Both prompts persist independently; a video task uses the current saved
    // video instruction while a direct question preserves the typed question.
    await options.reload();
    await options.getByRole('button', { name: '摘要指令', exact: true }).click();
    await expect(options.getByRole('textbox', { name: '网页摘要指令' })).toHaveValue(
      '请用三点总结网页，只依据原文。',
    );
    await expect(options.getByRole('textbox', { name: '视频摘要指令' })).toHaveValue(videoPrompt);
    await capture(options, 'settings-prompts.png', true);
    const video = await context.newPage();
    await video.goto('https://www.youtube.com/watch?v=abcdefghijk&prompt_test=1');
    const videoTabId = await worker.evaluate(
      async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
      video.url(),
    );
    const videoPanel = await openPanel(videoTabId);
    try {
      await videoPanel.getByRole('button', { name: '帮我总结这个视频' }).click();
      await expect(videoPanel.getByRole('button', { name: '查看字幕' })).toBeVisible();
      expect(requests.at(-1).messages.at(-1).content).toBe(videoPrompt);
      await videoPanel.getByRole('textbox', { name: '向当前视频提问' }).fill('只解释第二个观点');
      await videoPanel.getByRole('button', { name: '发送问题' }).click();
      await expect.poll(() => requests.at(-1).messages.at(-1).content).toBe('只解释第二个观点');
      await expect(videoPanel.getByRole('button', { name: '查看字幕' })).toBeVisible();
    } finally {
      await videoPanel.close();
      await video.close();
    }
    await options.getByRole('button', { name: '恢复默认网页指令' }).click();
    const defaultWeb = await options.getByRole('textbox', { name: '网页摘要指令' }).inputValue();
    expect(defaultWeb).not.toBe('请用三点总结网页，只依据原文。');
    await expect(options.getByRole('textbox', { name: '视频摘要指令' })).toHaveValue(videoPrompt);
    await options.getByRole('button', { name: '保存指令' }).click();
    await expect(options.getByRole('status')).toContainText('设置已保存');
    await options.reload();
    await options.getByRole('button', { name: '摘要指令', exact: true }).click();
    await expect(options.getByRole('textbox', { name: '网页摘要指令' })).toHaveValue(defaultWeb);
    await expect(options.getByRole('textbox', { name: '视频摘要指令' })).toHaveValue(videoPrompt);
    await options.getByRole('textbox', { name: '视频摘要指令' }).fill('');
    await expect(options.getByRole('button', { name: '保存指令' })).toBeDisabled();
    await options.getByRole('button', { name: '恢复默认视频指令' }).click();
    await expect(options.getByRole('button', { name: '保存指令' })).toBeEnabled();
    await expect(options.getByRole('textbox', { name: '网页摘要指令' })).toHaveValue(defaultWeb);
    await options.getByRole('button', { name: '保存指令' }).click();
    await expect(options.getByRole('status')).toContainText('设置已保存');
    await options.getByRole('button', { name: 'AI 供应商', exact: true }).click();
    await options.getByRole('button', { name: '编辑 本地验收模型' }).click();
    await options.getByRole('button', { name: '获取模型', exact: true }).click();
    await expect(options.locator('#model-list option')).toHaveAttribute('value', 'reading-test');
    await options.getByRole('button', { name: '取消', exact: true }).click();
  });
  await step(
    'reasoning effort persists, reaches the Worker, resets, and rejects invalid RPC values',
    async () => {
      const select = options.getByRole('combobox', { name: '推理强度', exact: true });
      await options.getByRole('button', { name: '编辑 本地验收模型' }).click();
      await select.selectOption('high');
      await options.getByRole('button', { name: '保存并授权' }).click();
      await expect(options.getByRole('button', { name: '编辑 本地验收模型' })).toBeVisible();
      await options.reload();
      await options.getByRole('button', { name: '编辑 本地验收模型' }).click();
      await expect(select).toHaveValue('high');
      await capture(options, 'provider-reasoning.png', true);
      const invalid = await options.evaluate(async () => {
        const response = await chrome.runtime.sendMessage({
          channel: 'glintab:rpc',
          request: { type: 'config:get' },
        });
        const provider = response.data.providers[0];
        const result = await chrome.runtime.sendMessage({
          channel: 'glintab:rpc',
          request: { type: 'provider:save', provider: { ...provider, reasoningEffort: 'invalid' } },
        });
        const after = await chrome.runtime.sendMessage({
          channel: 'glintab:rpc',
          request: { type: 'config:get' },
        });
        return { result, effort: after.data.providers[0].reasoningEffort };
      });
      expect(invalid.result.ok).toBe(false);
      expect(invalid.result.error).toContain('推理强度设置无效');
      expect(invalid.effort).toBe('high');
      await options.getByRole('button', { name: '取消', exact: true }).click();
      await article.goto(`${baseUrl}/reasoning-high`);
      await panel.getByRole('button', { name: '帮我总结这篇网页' }).click();
      await expect(panel.getByRole('button', { name: '重新摘要' })).toBeVisible();
      expect(requests.at(-1).reasoning_effort).toBe('high');
      expect(requests.at(-1)).not.toHaveProperty('reasoning');
      await options.getByRole('button', { name: '编辑 本地验收模型' }).click();
      await select.selectOption('');
      await options.getByRole('button', { name: '保存并授权' }).click();
      await expect(options.getByRole('button', { name: '编辑 本地验收模型' })).toBeVisible();
      await article.goto(`${baseUrl}/reasoning-default`);
      await panel.getByRole('button', { name: '帮我总结这篇网页' }).click();
      await expect(panel.getByRole('button', { name: '重新摘要' })).toBeVisible();
      expect(requests.at(-1)).not.toHaveProperty('reasoning_effort');
      expect(requests.at(-1)).not.toHaveProperty('reasoning');
    },
  );
  for (const [format, label] of [
    ['openai_responses', 'Responses 验收'],
    ['anthropic', 'Anthropic 验收'],
  ]) {
    await step(
      `${format} completes the real background/offscreen/worker request path`,
      async () => {
        await options.getByRole('button', { name: '添加供应商', exact: true }).first().click();
        await options.getByLabel('供应商名称').fill(label);
        await options
          .getByRole('combobox', { name: '推理强度', exact: true })
          .selectOption('xhigh');
        await options.getByLabel('API 协议').selectOption(format);
        if (format === 'anthropic')
          await expect(
            options.getByRole('combobox', { name: '推理强度', exact: true }),
          ).toHaveCount(0);
        if (format === 'openai_responses')
          await options.getByRole('checkbox', { name: '流式输出' }).uncheck();
        await options.getByLabel('Base URL').fill(`${baseUrl}/v1`);
        await options.getByLabel('API Key', { exact: true }).fill('test-only');
        await options.getByLabel('模型', { exact: true }).fill('reading-test');
        await options.getByRole('button', { name: '保存并授权' }).click();
        if (format === 'openai_responses') {
          await options.getByRole('button', { name: `编辑 ${label}` }).click();
          await expect(options.getByRole('checkbox', { name: '流式输出' })).not.toBeChecked();
          await expect(
            options.getByRole('combobox', { name: '推理强度', exact: true }),
          ).toHaveValue('xhigh');
          await capture(options, 'provider-nonstream.png', true);
          await options.getByRole('button', { name: '取消', exact: true }).click();
        }
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
        expect(requests.at(-1).stream).toBe(format !== 'openai_responses');
        expect(requests.at(-1)).not.toHaveProperty('reasoning_effort');
        if (format === 'openai_responses')
          expect(requests.at(-1).reasoning).toEqual({ effort: 'xhigh' });
        else expect(requests.at(-1)).not.toHaveProperty('reasoning');
      },
    );
  }
  await step('missing extraction scripts do not incorrectly ask for site permission', async () => {
    const scriptPath = path.join(extensionPath, 'content-scripts/extract.js');
    const script = await readFile(scriptPath);
    const source = await context.newPage();
    let brokenPanel;
    try {
      await source.goto(`${baseUrl}/broken-extraction`);
      const sourceTabId = await worker.evaluate(
        async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
        source.url(),
      );
      brokenPanel = await openPanel(sourceTabId);
      await expect(brokenPanel.getByRole('button', { name: '帮我总结这篇网页' })).toBeEnabled();
      await rm(scriptPath);
      await brokenPanel.getByRole('button', { name: '帮我总结这篇网页' }).click();
      await expect(brokenPanel.getByRole('alert')).toContainText('正文脚本注入失败');
      await expect(
        brokenPanel.getByRole('button', { name: '一次授权所有网站', exact: true }),
      ).toHaveCount(0);
    } finally {
      await writeFile(scriptPath, script);
      await brokenPanel?.close();
      await source.close();
    }
  });
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
  await step('worker startup failures show an error without crashing the panel', async () => {
    // The clear-data scenario above closed the previous engine. Break only this
    // disposable extension copy, then verify the actual offscreen error path.
    await rm(path.join(extensionPath, 'engine-worker.js'));
    const brokenPanel = await openPanel();
    await expect(brokenPanel.getByRole('alert')).toContainText('任务引擎', { timeout: 10000 });
    await expect(brokenPanel.getByRole('heading', { name: '每一页，都读得更深。' })).toBeVisible();
    await expect(brokenPanel.getByRole('button', { name: '停止生成' })).toHaveCount(0);
    await brokenPanel.close();
  });
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
    path.join(artifactPath, 'e2e-results.json'),
    JSON.stringify(
      {
        browser: context.browser()?.version(),
        mode: development ? 'development' : 'production',
        passed,
        requests: requests.length,
        failures,
        testPermissionOverride:
          'loopback and mocked video origin permissions in disposable copy only',
      },
      null,
      2,
    ),
  );
  console.log(`Validated ${passed.length} browser scenarios.`);
} catch (error) {
  console.error('PAGE ERRORS', errors);
  failures.push(String(error));
  await writeFile(
    path.join(artifactPath, 'e2e-results.json'),
    JSON.stringify({ passed, failures }, null, 2),
  );
  if (context)
    for (const [index, page] of context.pages().entries()) {
      await page
        .screenshot({ path: path.join(artifactPath, `failure-${index}.png`) })
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
