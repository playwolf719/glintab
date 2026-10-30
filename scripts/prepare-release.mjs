import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { format, resolveConfig } from 'prettier';

const root = fileURLToPath(new URL('../', import.meta.url));
const releaseDir = path.join(root, 'docs/release');
const assetDir = path.join(releaseDir, 'assets');
const productionDir = path.join(root, 'output/chrome-mv3');
const publisher = JSON.parse(await readFile(path.join(releaseDir, 'publisher.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const serveDemo = process.argv.includes('--serve-demo');

// Original demonstration content; no third-party article or real AI service is used.
const article = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>把阅读变成理解：一份实践指南</title>
<style>body{margin:0;background:#faf9f6;color:#25334a;font:17px/1.85 system-ui,-apple-system,"PingFang SC",sans-serif}
header{margin:38px 72px 0;padding-bottom:20px;width:680px;border-bottom:1px solid #d8dfe5;color:#61718a;font-size:14px}
article{width:660px;margin:32px 72px}h1{font-size:38px;line-height:1.35;letter-spacing:-1px;margin:18px 0}h2{font-size:23px;margin:26px 0 10px}
p{margin:12px 0}small{color:#61718a}aside{background:#e9effb;color:#356ce2;padding:10px 16px;border-radius:6px;font-size:13px}
</style><header>GLINTAB READING JOURNAL · 阅读手记</header><article>
<aside>功能演示 · 原创示例文章 · 模型使用固定示例响应</aside>
<h1>把阅读变成理解：<br>一份实践指南</h1><small>阅读方法 / 约 3 分钟</small>
<p>读完一篇文章，不代表已经理解它。真正有用的阅读，会留下清晰的问题、可核对的事实，以及属于自己的判断。摘要帮助我们建立结构，原文则提供判断的依据。</p>
<h2>01 / 带着问题开始</h2><p>阅读前先写下一个你想回答的问题。它可以很具体：作者希望解决什么问题？核心结论依靠哪些事实？遇到新信息时，再判断它是否改变了最初的想法。</p>
<h2>02 / 把观点和证据分开</h2><p>把作者的结论、用于支持结论的事实与尚未解释的部分分别记下来。核对重要数字和引用的原始语境；一个案例并不自动意味着普遍规律。证据不足时，保留不确定性比急于下结论更有帮助。</p>
<h2>03 / 用自己的话重述</h2><p>试着用一句话说明文章的主旨，再列出三条支撑它的理由。如果无法清晰表达，就回到对应段落查找缺失的联系。用自己的例子解释观点，可以检查理解是否停留在熟悉词语的层面。</p>
<h2>04 / 让摘要成为追问的起点</h2><p>摘要是阅读的入口。继续追问「哪些内容是事实，哪些是推断」「这个建议在什么条件下不适用」，把重要结论与原文对应起来。模型的回答可能出错，因此引用、事实与推断都需要核对。</p>
<p>阅读完成后，保留一份简短记录：一个核心结论、三条依据、一个待验证的问题。下次接触相关内容时，用新证据更新判断。</p></article></html>`;
const summary = `## 让阅读留下理解\n\n文章建议把阅读变成「提问 → 核对证据 → 重述 → 追问」的过程。\n\n- **先定问题**：明确想从文章中获得什么。\n- **区分观点与证据**：核对数字、引用与适用条件。\n- **用自己的话重述**：一句主旨、三条依据。\n- **继续追问**：保留一个尚待验证的问题。\n\n摘要帮助建立结构，重要判断仍需回到原文核对。\n\n*固定演示响应，非真实模型输出。*`;
const followUp = `可以从这三个问题开始：\n\n1. 作者的核心结论有哪些直接证据？\n2. 哪些内容是事实，哪些属于推断？\n3. 结论在什么条件下可能不适用？\n\n原文没有回答的部分，应保留为待验证问题。\n\n*固定演示响应，非真实模型输出。*`;

function demoServer() {
  return createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return response.writeHead(204).end();
    if (request.method === 'GET' && request.url === '/v1/models')
      return response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'demo-reading' }] }));
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      try {
        const pieces = [];
        let size = 0;
        for await (const piece of request) {
          size += piece.length;
          if (size > 1_000_000) return response.writeHead(413).end();
          pieces.push(piece);
        }
        const body = JSON.parse(Buffer.concat(pieces).toString('utf8'));
        const text = body.messages?.some((message) => message.role === 'assistant')
          ? followUp
          : summary;
        if (body.stream === false)
          return response
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        for (const content of text.match(/.{1,18}|\n/g) || [])
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        return response.end('data: [DONE]\n\n');
      } catch {
        return response.writeHead(400).end('Invalid demo request');
      }
    }
    if (request.method === 'GET' && ['/', '/article'].includes(request.url))
      return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(article);
    response.writeHead(404).end();
  });
}

if (serveDemo) {
  const server = demoServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4318, '127.0.0.1', resolve);
  });
  console.log('固定响应演示（不调用真实模型）：http://127.0.0.1:4318/article');
  console.log('Base URL: http://127.0.0.1:4318/v1 · API Key: demo-only · model: demo-reading');
  process.once('SIGINT', () => server.close(() => process.exit(0)));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
} else {
  await mkdir(assetDir, { recursive: true });
  const policy = await readFile(path.join(root, 'docs/PRIVACY.md'), 'utf8');
  if (!policy.includes(publisher.email) || !policy.includes(publisher.name))
    throw new Error('Privacy policy and publisher.json must use the same publisher/contact.');
  const rendered = renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: policy }),
  );
  await writeFile(
    path.join(releaseDir, 'privacy-policy.html'),
    await format(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Glintab 隐私政策</title><style>body{max-width:960px;margin:48px auto;padding:0 24px;color:#25334a;background:#fff;font:16px/1.85 system-ui,-apple-system,"PingFang SC",sans-serif}h1{font-size:30px}h2{font-size:22px;margin-top:36px}a{color:#275ac4;overflow-wrap:anywhere}p,li{overflow-wrap:anywhere}table{display:block;overflow:auto;border-collapse:collapse}td,th{border:1px solid #dce2eb;padding:8px;text-align:left}code{font-size:14px;background:#f4f6fa}</style></head><body><main>${rendered}</main></body></html>\n`,
      { ...(await resolveConfig(path.join(releaseDir, 'privacy-policy.html'))), parser: 'html' },
    ),
  );
  if (!process.argv.includes('--documents-only') && !process.argv.includes('--archive-only'))
    await captureAssets();
  if (!process.argv.includes('--documents-only')) {
    const archive = path.join(root, `output/glintab-${pkg.version}-store-materials.zip`);
    await rm(archive, { force: true });
    const result = spawnSync('zip', ['-qr', archive, 'release', 'PRIVACY.md', 'ACCEPTANCE.md'], {
      cwd: path.join(root, 'docs'),
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) throw new Error('Material archive creation failed.');
    console.log(`发布材料已生成：${path.relative(root, archive)}`);
  }
}

async function captureAssets() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'glintab-store-'));
  const extensionDir = path.join(temporary, 'extension');
  const server = demoServer();
  let context;
  try {
    await cp(productionDir, extensionDir, { recursive: true });
    const manifestPath = path.join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version !== pkg.version) throw new Error('Build the current version first.');
    if (manifest.host_permissions?.length || manifest.content_scripts?.length)
      throw new Error('Production must retain on-demand host permissions and extraction.');
    const productionHash = createHash('sha256')
      .update(await readFile(path.join(productionDir, 'manifest.json')))
      .digest('hex');
    // Only the disposable screenshot copy receives loopback permission.
    manifest.host_permissions = ['http://127.0.0.1/*'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    // WHATWG URL.origin is "null" for chrome-extension in Node; use its host.
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    const options = await context.newPage();
    await options.goto(`${extensionOrigin}/options.html`);
    await options.getByRole('button', { name: '添加供应商', exact: true }).first().click();
    await options.getByLabel('供应商名称').fill('演示模型（固定示例）');
    await options.getByLabel('Base URL').fill(`${base}/v1`);
    await options.getByLabel('API Key', { exact: true }).fill('demo-only');
    await options.getByLabel('模型', { exact: true }).fill('demo-reading');
    await options.getByRole('button', { name: '保存并授权' }).click();
    await expect(options.getByText('使用中', { exact: true })).toBeVisible();
    const source = await context.newPage();
    await source.goto(`${base}/article`);
    const tabId = await worker.evaluate(
      async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
      `${base}/article`,
    );
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        files: ['content-scripts/drawer.js'],
      });
      await chrome.tabs.sendMessage(id, { channel: 'glintab:drawer', open: true });
    }, tabId);
    await expect
      .poll(() => source.frames().some((frame) => frame.url().includes('mode=drawer')))
      .toBe(true);
    const drawer = source.frames().find((frame) => frame.url().includes('mode=drawer'));
    await source.bringToFront();
    const embedded = await drawer.frameElement();
    await expect
      .poll(() => embedded.evaluate((node) => Math.round(node.getBoundingClientRect().right)))
      .toBe(1280);
    await expect(drawer.getByRole('button', { name: '帮我总结这篇网页' })).toBeEnabled();
    await drawer.getByRole('button', { name: '帮我总结这篇网页' }).click();
    await expect(drawer.getByText('固定演示响应，非真实模型输出。', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '发送问题' })).toBeVisible();
    await capture(source, '01-reading-summary.png');
    await drawer.getByRole('textbox', { name: '向当前网页提问' }).fill('我该如何核对文章的结论？');
    await drawer.getByRole('button', { name: '发送问题' }).click();
    await expect(drawer.getByText('可以从这三个问题开始：')).toBeVisible();
    await expect(drawer.getByRole('button', { name: '发送问题' })).toBeVisible();
    await capture(source, '02-follow-up.png');
    await drawer.getByRole('button', { name: '查看正文', exact: true }).click();
    await expect(drawer.getByRole('dialog')).toBeVisible();
    await capture(source, '03-source-inspection.png');
    await options.bringToFront();
    await options.getByRole('button', { name: '摘要指令', exact: true }).click();
    await expect(options.getByRole('heading', { name: '摘要指令', exact: true })).toBeVisible();
    await capture(options, '04-summary-prompts.png');
    await cp(path.join(root, 'public/icon/128.png'), path.join(assetDir, 'icon-128.png'));

    // Extend the existing original icon into code-drawn promotional compositions.
    const icon = (await readFile(path.join(root, 'public/icon/128.png'))).toString('base64');
    const promo = await context.newPage();
    await promo.route('**/*', (route) => route.abort());
    for (const [width, height, filename] of [
      [440, 280, 'promo-small-440x280.png'],
      [1400, 560, 'promo-marquee-1400x560.png'],
    ]) {
      const scale = width / 440;
      const unit = Math.min(scale, height / 280);
      await promo.setViewportSize({ width, height });
      await promo.setContent(
        `<style>*{box-sizing:border-box}body{margin:0;background:#2453bd;overflow:hidden;font-family:system-ui,sans-serif}.brand{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:${22 * unit}px;color:white}.brand img{width:${100 * unit}px;height:${100 * unit}px}.brand span{font-size:${44 * unit}px;letter-spacing:-2px;font-weight:650}.page{position:absolute;width:${220 * unit}px;height:${270 * unit}px;border:1px solid #ffffff22;border-radius:18px;transform:rotate(-18deg);left:-7%;top:22%;background:linear-gradient(125deg,#ffffff16,transparent)}.page:after{content:'';position:absolute;inset:36px 30px;background:repeating-linear-gradient(transparent 0px,transparent 17px,#ffffff1c 18px,#ffffff1c 20px,transparent 21px,transparent 35px)}.second{left:auto;right:-6%;top:-20%;transform:rotate(20deg)}</style><div class="page"></div><div class="page second"></div><div class="brand"><img src="data:image/png;base64,${icon}" alt=""><span>Glintab</span></div>`,
      );
      await promo.locator('img').evaluate((img) => img.decode());
      await capture(promo, filename);
    }
    const files = [];
    for (const name of [
      'icon-128.png',
      '01-reading-summary.png',
      '02-follow-up.png',
      '03-source-inspection.png',
      '04-summary-prompts.png',
      'promo-small-440x280.png',
      'promo-marquee-1400x560.png',
    ]) {
      const bytes = await readFile(path.join(assetDir, name));
      files.push({
        file: name,
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    await writeFile(
      path.join(assetDir, 'manifest.json'),
      JSON.stringify(
        {
          version: pkg.version,
          browserVersion: context.browser().version(),
          publisher,
          productionManifestSha256: productionHash,
          screenshotSource:
            'Production extension UI; original article; fixed local demo responses.',
          isolation: 'Temporary browser profile and extension copy; loopback host permission only.',
          realModelOrVideoPlatformVerified: false,
          files,
        },
        null,
        2,
      ) + '\n',
    );
    if (
      createHash('sha256')
        .update(await readFile(path.join(productionDir, 'manifest.json')))
        .digest('hex') !== productionHash
    )
      throw new Error('Production manifest changed during capture.');
    console.log(`已生成并核对 ${files.length} 张图片；生产 Manifest 保持不变。`);
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
}

async function capture(page, name) {
  await page.bringToFront();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(assetDir, name), animations: 'disabled' });
}
