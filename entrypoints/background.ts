import { defineBackground } from 'wxt/utils/define-background';
import { Repository } from '../lib/storage/repository';
import { errorText } from '../lib/platform/rpc';
import { extractionInjectionError, providerOrigin } from '../lib/platform/permissions';
import { isReadableUrl, pageKey } from '../lib/domain/page';
import { summaryPrompt } from '../lib/domain/settings';
import { validateReasoningEffort } from '../lib/domain/reasoning';
import { extractorFor } from '../lib/extraction/registry';
import { readVideoPage } from '../lib/extraction/video-page';
import { videoSource } from '../lib/extraction/video';
import { listModels } from '../lib/llm/client';
import { browserAccounts } from '../lib/auth/chatgpt';
import { CHATGPT_PROVIDER_URL, CHATGPT_REDIRECT_URI } from '../config/chatgpt';
import type {
  EngineEvent,
  EngineRequest,
  PageSource,
  Provider,
  Request,
  RpcResponse,
  TaskSnapshot,
} from '../types';

export default defineBackground(() => {
  const repository = new Repository(chrome.storage.local);
  const authSession = new Repository(chrome.storage.session);
  const accounts = browserAccounts(repository, authSession);
  const authReady = accounts.recover();
  void authReady.catch(() => {});
  const observeAuth = (tabId: number, url: string) => {
    if (url !== CHATGPT_REDIRECT_URI && !url.startsWith(CHATGPT_REDIRECT_URI + '?')) return;
    void authReady.then(() => accounts.observe(tabId, url)).catch(() => {});
  };
  // Navigation events include failed loopback redirects; tabs polling is a fallback.
  chrome.webNavigation.onBeforeNavigate.addListener(
    (event) => {
      if (event.frameId === 0) observeAuth(event.tabId, event.url);
    },
    { url: [{ hostEquals: '127.0.0.1', pathEquals: '/auth/callback' }] },
  );
  chrome.webNavigation.onErrorOccurred.addListener(
    (event) => {
      if (event.frameId === 0) observeAuth(event.tabId, event.url);
    },
    { url: [{ hostEquals: '127.0.0.1', pathEquals: '/auth/callback' }] },
  );
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    for (const url of [change.url, tab.pendingUrl, tab.url]) if (url) observeAuth(tabId, url);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void authReady.then(() => accounts.closed(tabId)).catch(() => {});
  });
  let creating: Promise<void> | undefined;
  let engineQueue: Promise<unknown> = Promise.resolve();
  function serializeEngine<T>(operation: () => Promise<T>): Promise<T> {
    const result = engineQueue.then(operation);
    engineQueue = result.catch(() => {});
    return result;
  }
  const pendingExtractions = new Map<
    number,
    {
      expected: string;
      resolve(value: PageSource): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const pendingVideos = new Map<number, symbol>();
  const extensionPage = (sender: chrome.runtime.MessageSender, paths: string[]) => {
    if (sender.id !== chrome.runtime.id || !sender.url) return false;
    try {
      const url = new URL(sender.url);
      return sender.url.startsWith(chrome.runtime.getURL('/')) && paths.includes(url.pathname);
    } catch {
      return false;
    }
  };
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

  async function ensureEngine() {
    if (creating) return creating;
    creating = (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (!contexts.length)
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification:
            'Host the reading task engine and its worker independently of the visible panel lifecycle.',
        });
    })();
    try {
      await creating;
    } finally {
      creating = undefined;
    }
  }
  async function dispatchEngine<T>(request: EngineRequest): Promise<T> {
    await ensureEngine();
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const response: RpcResponse<T> = await chrome.runtime.sendMessage(request);
        if (response) {
          if (!response.ok) throw new Error(response.error || '任务引擎请求失败。');
          return response.data as T;
        }
      } catch (error) {
        if (!/Receiving end does not exist|Could not establish connection/.test(errorText(error)))
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('任务引擎未能启动，请重新打开插件后重试。');
  }
  function engine<T>(request: EngineRequest): Promise<T> {
    return serializeEngine(() => dispatchEngine<T>(request));
  }
  async function validateProvider(provider: Provider) {
    validateReasoningEffort(provider.reasoningEffort);
    if (
      provider.authType === 'chatgpt' &&
      (provider.baseUrl !== CHATGPT_PROVIDER_URL ||
        provider.apiFormat !== 'openai_responses' ||
        !provider.chatgpt?.connectionId ||
        provider.apiKey !== '')
    )
      throw new Error('ChatGPT 连接配置不完整，请重新登录。');
    if (!provider.name.trim() || !provider.model.trim())
      throw new Error('请填写供应商名称和模型。');
    if (!['openai_chat', 'anthropic', 'openai_responses'].includes(provider.apiFormat))
      throw new Error('请选择受支持的 API 协议。');
    if (provider.stream !== undefined && typeof provider.stream !== 'boolean')
      throw new Error('流式输出设置无效，请重新保存供应商。');
    if (
      !Number.isInteger(provider.contextLimit) ||
      provider.contextLimit < 4096 ||
      provider.contextLimit > 2000000
    )
      throw new Error('上下文上限应为 4096 至 2000000 的整数。');
    const origin = providerOrigin(provider.baseUrl);
    if (!(await chrome.permissions.contains({ origins: [origin] })))
      throw new Error('缺少模型域名权限，请在设置中重新保存该供应商并授权。');
  }
  async function extract(tabId: number, expected: string) {
    const tab = await chrome.tabs.get(tabId);
    if (!isReadableUrl(tab.url))
      throw new Error('当前页面受浏览器限制，无法读取。请打开普通网页。');
    if (pageKey(tab.url!) !== expected) throw new Error('来源页面已变化，请重新提取。');
    const adapter = extractorFor(tab.url!);
    if (pendingExtractions.has(tabId) || pendingVideos.has(tabId))
      throw new Error('此标签页正在提取内容，请稍候。');
    if ('video' in adapter) {
      const token = Symbol();
      pendingVideos.set(tabId, token);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          chrome.scripting
            .executeScript({
              target: { tabId },
              world: 'MAIN',
              func: readVideoPage,
              args: [
                adapter.video.platform,
                tab.url!,
                adapter.video.videoId,
                adapter.video.part ?? 1,
              ],
            })
            .catch((error) => {
              throw new Error(extractionInjectionError(error));
            }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('字幕提取超时，请刷新视频后重试。')), 15000);
          }),
        ]);
        const result = results.find((item) => item.frameId === 0)?.result;
        if (!result?.ok || !result.data)
          throw new Error(result?.error || '字幕提取失败，请刷新后重试。');
        // Read tabs again: SPA navigation can finish while a caption fetch awaits.
        const current = await chrome.tabs.get(tabId);
        if (current.url !== tab.url || (current.pendingUrl && current.pendingUrl !== tab.url))
          throw new Error('提取过程中视频已变化，请重新提取。');
        return videoSource(result.data, tab.url!);
      } finally {
        clearTimeout(timer);
        if (pendingVideos.get(tabId) === token) pendingVideos.delete(tabId);
      }
    }
    return new Promise<PageSource>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingExtractions.delete(tabId);
        reject(new Error('提取超时，请等待网页加载后重试。'));
      }, 15000);
      pendingExtractions.set(tabId, { expected, resolve, reject, timer });
      void chrome.scripting
        .executeScript({ target: { tabId }, files: [adapter.script.replace(/^\//, '')] })
        .catch((error) => {
          const pending = pendingExtractions.get(tabId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingExtractions.delete(tabId);
            reject(new Error(extractionInjectionError(error)));
          }
        });
    });
  }
  async function handle(request: Request): Promise<unknown> {
    await authReady;
    switch (request.type) {
      case 'chatgpt:login:start': {
        const config = await repository.config();
        const provider = request.providerId
          ? config.providers.find((item) => item.id === request.providerId)
          : undefined;
        if (request.providerId && provider?.authType !== 'chatgpt')
          throw new Error('ChatGPT 连接不存在。');
        return accounts.start(provider);
      }
      case 'chatgpt:login:status':
        return accounts.status(request.flowId, request.statusKey);
      case 'chatgpt:login:cancel':
        return accounts.cancel(request.flowId, request.statusKey);
      case 'chatgpt:connection:discard':
        return accounts.discard(request.connectionId, request.draftKey);
      case 'config:get':
        return repository.config();
      case 'provider:save': {
        const provider = {
          ...request.provider,
          name: request.provider.name.trim(),
          model: request.provider.model.trim(),
          baseUrl: request.provider.baseUrl.trim().replace(/\/+$/, ''),
        };
        await validateProvider(provider);
        if (provider.authType === 'chatgpt') return repository.saveChatGPTProvider(provider);
        return repository.updateConfig((config) => ({
          ...config,
          providers: [...config.providers.filter((p) => p.id !== provider.id), provider].sort(
            (a, b) => a.createdAt - b.createdAt,
          ),
          currentProviderId: config.currentProviderId || provider.id,
        }));
      }
      case 'provider:delete': {
        const provider = (await repository.config()).providers.find(
          (item) => item.id === request.id,
        );
        if (provider?.authType === 'chatgpt')
          await accounts.disconnect(provider.chatgpt!.connectionId);
        return repository.updateConfig((config) => {
          const providers = config.providers.filter((p) => p.id !== request.id);
          return {
            ...config,
            providers,
            currentProviderId:
              config.currentProviderId === request.id
                ? providers[0]?.id || null
                : config.currentProviderId,
          };
        });
      }
      case 'provider:select':
        return repository.updateConfig((config) => {
          if (!config.providers.some((p) => p.id === request.id))
            throw new Error('供应商不存在，请重新选择。');
          return { ...config, currentProviderId: request.id };
        });
      case 'settings:save':
        return repository.saveSettings(request.settings);
      case 'models:list': {
        const origin = providerOrigin(request.provider.baseUrl);
        if (!(await chrome.permissions.contains({ origins: [origin] })))
          throw new Error('请先允许模型域名访问。');
        if (request.provider.authType === 'chatgpt') {
          if (
            request.provider.baseUrl !== CHATGPT_PROVIDER_URL ||
            !request.provider.chatgpt?.connectionId
          )
            throw new Error('ChatGPT 连接配置无效，请重新登录。');
          return listModels(request.provider, fetch, (rejectedRevision) =>
            accounts.credentials(request.provider.chatgpt!.connectionId, rejectedRevision),
          );
        }
        return listModels(request.provider);
      }
      case 'conversation:get':
        return repository.conversation(request.pageKey);
      case 'page:extract':
        return extract(request.tabId, request.expectedPageKey);
      case 'task:start':
        return serializeEngine(async () => {
          const tab = await chrome.tabs.get(request.tabId);
          if (pageKey(tab.url || '') !== request.conversation.source.pageKey)
            throw new Error('来源页面已变化，请在当前页面重新发送。');
          const config = await repository.config();
          const provider = config.providers.find((p) => p.id === config.currentProviderId);
          if (!provider) throw new Error('请先添加并选择 AI 供应商。');
          await validateProvider(provider);
          const question = request.summary
            ? summaryPrompt(request.conversation.source, config.settings)
            : request.question;
          if (!question.trim()) throw new Error('请输入问题或在设置中填写摘要指令。');
          if (!request.conversation.source.content.trim())
            throw new Error('没有可用正文，请重新提取。');
          return dispatchEngine({
            target: 'engine',
            type: 'start',
            task: { ...request, question, provider, settings: config.settings },
          });
        });
      case 'task:snapshot':
        return engine({
          target: 'engine',
          type: 'snapshot',
          tabId: request.tabId,
          pageKey: request.pageKey,
        });
      case 'task:cancel':
        return engine({
          target: 'engine',
          type: 'cancel',
          tabId: request.tabId,
          streamId: request.streamId,
        });
      case 'window:open': {
        await chrome.windows.create({
          url: chrome.runtime.getURL('/sidepanel.html') + `?tabId=${request.tabId}&mode=window`,
          type: 'popup',
          width: 440,
          height: 720,
        });
        await chrome.tabs
          .sendMessage(request.tabId, { channel: 'glintab:drawer', open: false })
          .catch(() => {});
        return;
      }
      case 'drawer:close':
        return chrome.tabs
          .sendMessage(request.tabId, { channel: 'glintab:drawer', open: false })
          .catch(() => {});
      case 'data:clear':
        return serializeEngine(async () => {
          const tasks = await dispatchEngine<TaskSnapshot[]>({ target: 'engine', type: 'active' });
          if (tasks.length) throw new Error('请先停止所有页面的生成任务，再清除数据。');
          await chrome.offscreen.closeDocument();
          return accounts.clear();
        });
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target === 'engine') return;
    const send = (promise: Promise<unknown>) => {
      void promise
        .then((data) => respond({ ok: true, data }))
        .catch((error) => respond({ ok: false, error: errorText(error) }));
      return true;
    };
    if (message?.channel === 'glintab:auth') {
      if (
        !extensionPage(sender, ['/offscreen.html']) ||
        typeof message.connectionId !== 'string' ||
        (message.rejectedRevision !== undefined && typeof message.rejectedRevision !== 'string')
      ) {
        respond({ ok: false, error: '无权请求账号凭证。' });
        return;
      }
      return send(
        authReady.then(async () => {
          const config = await repository.config();
          if (
            !config.providers.some(
              (provider) =>
                provider.authType === 'chatgpt' &&
                provider.chatgpt?.connectionId === message.connectionId,
            )
          )
            throw new Error('ChatGPT 连接未保存或已删除。');
          return accounts.credentials(message.connectionId, message.rejectedRevision);
        }),
      );
    }
    if (message?.channel === 'glintab:rpc') {
      if (!extensionPage(sender, ['/sidepanel.html', '/options.html'])) {
        respond({ ok: false, error: '无权调用此接口。' });
        return;
      }
      return send(handle(message.request));
    }
    if (message?.channel === 'glintab:event') {
      if (!extensionPage(sender, ['/offscreen.html'])) return;
      const event = message as EngineEvent;
      return send(event.persist ? repository.save(event.snapshot.conversation) : Promise.resolve());
    }
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId !== 0)
      return;
    const tabId = sender.tab.id;
    if (message?.channel === 'glintab:drawer-source') {
      return send(
        chrome.storage.local
          .get('drawerWidth')
          .then((data) => ({ tabId, width: data.drawerWidth || 420 })),
      );
    }
    if (message?.channel === 'glintab:drawer-width') {
      if (typeof message.width !== 'number' || !Number.isFinite(message.width)) return;
      return send(
        chrome.storage.local.set({ drawerWidth: Math.max(280, Math.min(760, message.width)) }),
      );
    }
    if (message?.channel === 'glintab:extracted') {
      const pending = pendingExtractions.get(tabId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingExtractions.delete(tabId);
      const result = message.result as RpcResponse<PageSource>;
      if (!result.ok || !result.data) pending.reject(new Error(result.error || '正文提取失败。'));
      else if (
        pageKey(sender.url || '') !== pending.expected ||
        result.data.pageKey !== pending.expected
      )
        pending.reject(new Error('提取过程中页面已变化，请重新尝试。'));
      else pending.resolve(result.data);
      respond({ ok: true });
    }
  });

  chrome.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    const tabId = tab.id;
    if (!isReadableUrl(tab.url)) {
      void chrome.sidePanel.open({ tabId });
      return;
    }
    void (async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content-scripts/drawer.js'],
        });
        await chrome.tabs.sendMessage(tabId, { channel: 'glintab:drawer' });
      } catch {
        await chrome.windows.create({
          url: chrome.runtime.getURL('/sidepanel.html') + `?tabId=${tabId}&mode=window`,
          type: 'popup',
          width: 440,
          height: 720,
        });
      }
    })();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const pending = pendingExtractions.get(tabId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('来源标签页已关闭。'));
      pendingExtractions.delete(tabId);
    }
    // Tasks already started keep running and persist their results even if their source closes.
  });
  // Alarms survive service-worker suspension. Only close an idle engine, never a running task.
  chrome.alarms.create('glintab:idle', { periodInMinutes: 2 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'glintab:idle') return;
    void authReady.then(() => accounts.cleanup()).catch(() => {});
    if (creating) return;
    void serializeEngine(async () => {
      if (!(await chrome.offscreen.hasDocument())) return;
      const active = await dispatchEngine<TaskSnapshot[]>({ target: 'engine', type: 'active' });
      if (!active.length) await chrome.offscreen.closeDocument();
    }).catch(() => {});
  });
});
