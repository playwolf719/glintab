import type { ChatGPTAuthFlow, ChatGPTCredentials, Provider } from '../../types';
import type { ChatGPTFlow, ChatGPTLoginStatus } from '../../config/chatgpt';
import { Repository } from '../storage/repository';
import { ChatGPTOAuth, authorization, authRandom, callbackParameters } from './oauth';

export interface AuthBrowser {
  create(): Promise<number>;
  open(tabId: number, url: string): Promise<void>;
  urls(tabId: number): Promise<string[]>;
  close(tabId: number): Promise<void>;
  complete(tabId: number): Promise<void>;
}
export class ChatGPTAccounts {
  private operations = new Map<string, Promise<unknown>>();
  private blocked = new Set<string>();
  constructor(
    private repository: Repository,
    private session: Repository,
    private browser: AuthBrowser,
    private oauth = new ChatGPTOAuth(),
  ) {}
  private exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(key) || Promise.resolve()).catch(() => {}).then(action);
    this.operations.set(key, result);
    return result.finally(() => {
      if (this.operations.get(key) === result) this.operations.delete(key);
    });
  }
  private async flow(id: string, key?: string) {
    const flow = (await this.session.authFlows())[id];
    if (!flow || (key !== undefined && flow.statusKey !== key))
      throw new Error('登录尝试不存在，请重新登录。');
    return flow;
  }
  private async patch(id: string, changes: Partial<ChatGPTAuthFlow>) {
    await this.session.updateAuthFlows((flows) => {
      if (!flows[id]) throw new Error('登录尝试已过期，请重新登录。');
      return { ...flows, [id]: { ...flows[id], ...changes } };
    });
  }
  async start(provider?: Provider): Promise<ChatGPTFlow> {
    return this.exclusive('start', async () => {
      await this.cleanup();
      const flows = await this.session.authFlows();
      if (
        Object.values(flows).some(
          (flow) => flow.status === 'pending' || flow.status === 'exchanging',
        )
      )
        throw new Error('已有登录正在进行，请完成或取消后重试。');
      const existingId = provider?.chatgpt?.connectionId;
      if (existingId && !(await this.repository.authRecord(existingId)))
        throw new Error('此连接来自旧版本，请删除后重新登录。');
      const flow: ChatGPTAuthFlow = {
        id: crypto.randomUUID(),
        statusKey: authRandom(),
        state: authRandom(),
        nonce: authRandom(),
        verifier: authRandom(),
        tabId: await this.browser.create(),
        expiresAt: Date.now() + 5 * 60 * 1000,
        existingId,
        status: 'pending',
      };
      try {
        await this.session.updateAuthFlows((current) => ({ ...current, [flow.id]: flow }));
        await this.browser.open(flow.tabId, await authorization(flow));
      } catch (error) {
        await this.session
          .updateAuthFlows((current) => {
            delete current[flow.id];
            return current;
          })
          .catch(() => {});
        await this.browser.close(flow.tabId).catch(() => {});
        throw error;
      }
      return { flowId: flow.id, statusKey: flow.statusKey };
    });
  }
  async observe(tabId: number, raw: string) {
    const flow = Object.values(await this.session.authFlows()).find(
      (candidate) => candidate.tabId === tabId && candidate.status === 'pending',
    );
    if (!flow) return;
    await this.exclusive('flow:' + flow.id, async () => {
      const current = await this.flow(flow.id);
      if (current.status !== 'pending') return;
      try {
        const params = callbackParameters(raw);
        if (!params) return;
        if (current.expiresAt <= Date.now()) throw new Error('登录等待超时，请重新登录。');
        if (params.get('state') !== current.state)
          throw new Error('登录回调校验失败，请重新登录。');
        if (params.has('error')) throw new Error('登录已取消或未获授权，请重新登录。');
        const code = params.get('code');
        if (!code) throw new Error('登录回调缺少授权码，请重新登录。');
        // Claim before exchanging so duplicate URL events cannot reuse the code.
        await this.patch(current.id, { status: 'exchanging', verifier: '', nonce: '' });
        await this.exclusive('account:' + (current.existingId || current.id), async () => {
          const previous = current.existingId
            ? await this.repository.authRecord(current.existingId)
            : undefined;
          if (current.existingId && !previous) throw new Error('ChatGPT 连接已删除，请重新登录。');
          const record = await this.oauth.exchange(code, current, previous);
          await this.repository.updateAuthRecord(record.id, () => record);
          try {
            await this.patch(current.id, { status: 'connected', connectionId: record.id });
          } catch (error) {
            if (!previous)
              await this.repository.updateAuthRecord(record.id, () => undefined).catch(() => {});
            throw error;
          }
          this.blocked.delete(record.id);
        });
        await this.browser.complete(tabId).catch(() => {});
      } catch (error) {
        // JWT/network errors can include sensitive third-party details.
        const message =
          error instanceof Error && /^(登录|ChatGPT|OpenAI|无法)/.test(error.message)
            ? error.message
            : '账号验证或本地保存失败，请重新登录。';
        await this.patch(current.id, { status: 'error', verifier: '', nonce: '', error: message });
      }
    });
  }
  async status(id: string, key: string): Promise<ChatGPTLoginStatus> {
    let flow = await this.flow(id, key);
    if (flow.status === 'pending') {
      try {
        for (const url of await this.browser.urls(flow.tabId)) await this.observe(flow.tabId, url);
      } catch {
        await this.cancel(id, key);
      }
      flow = await this.flow(id, key);
    }
    if (flow.expiresAt <= Date.now() && flow.status !== 'exchanging') {
      await this.cancel(id, key);
      throw new Error('登录等待超时，请重新登录。');
    }
    const record =
      flow.status === 'connected' && flow.connectionId
        ? await this.repository.authRecord(flow.connectionId)
        : undefined;
    return {
      status: flow.status,
      error: flow.error,
      ...(record ? { connection: { id: record.id, email: record.email, draftKey: key } } : {}),
    };
  }
  async cancel(id: string, key: string) {
    await this.exclusive('flow:' + id, async () => {
      const flow = await this.flow(id, key);
      if (!flow.existingId && flow.connectionId) await this.discard(flow.connectionId, key);
      await this.patch(id, { status: 'cancelled', verifier: '', nonce: '' });
      await this.browser.close(flow.tabId).catch(() => {});
    });
  }
  async closed(tabId: number) {
    for (const flow of Object.values(await this.session.authFlows()))
      if (flow.tabId === tabId && (flow.status === 'pending' || flow.status === 'exchanging'))
        await this.cancel(flow.id, flow.statusKey);
  }
  async discard(id: string, draftKey: string) {
    await this.exclusive('account:' + id, async () => {
      const owner = Object.values(await this.session.authFlows()).find(
        (flow) => flow.connectionId === id && flow.statusKey === draftKey && !flow.existingId,
      );
      if (!owner) return;
      await this.repository.removeDraftAuthRecord(id);
    });
  }
  async disconnect(id: string) {
    await this.exclusive('account:' + id, async () => {
      await this.repository.updateAuthRecord(id, () => undefined);
      this.blocked.delete(id);
    });
  }
  async credentials(id: string, rejectedRevision?: string): Promise<ChatGPTCredentials> {
    return this.exclusive('account:' + id, async () => {
      let record = await this.repository.authRecord(id);
      if (!record || record.version !== 1 || record.invalid || this.blocked.has(id))
        throw new Error('ChatGPT 连接已失效，请重新登录。');
      const force = rejectedRevision !== undefined && rejectedRevision === record.revision;
      if (force || record.expiresAt < Date.now() + 60000) {
        // Persist an in-progress marker before consuming a rotating refresh
        // token. A crashed/restarted worker must require reauthorization.
        await this.repository.updateAuthRecord(id, () => ({ ...record!, invalid: true }));
        let next;
        try {
          next = await this.oauth.refresh(record);
        } catch (error) {
          this.blocked.add(id);
          throw error;
        }
        try {
          await this.repository.updateAuthRecord(id, () => next);
        } catch {
          this.blocked.add(id);
          // A rotated refresh token must never be retried after a failed write.
          await this.repository
            .updateAuthRecord(id, (old) =>
              old ? { ...old, invalid: true, refreshToken: '' } : undefined,
            )
            .catch(() => {});
          throw new Error('ChatGPT 凭证刷新后保存失败，请重新登录。');
        }
        record = next;
      }
      return {
        accessToken: record.accessToken,
        accountId: record.accountId,
        revision: record.revision,
      };
    });
  }
  async recover() {
    for (const flow of Object.values(await this.session.authFlows())) {
      if (flow.status === 'exchanging')
        await this.patch(flow.id, {
          status: 'error',
          verifier: '',
          nonce: '',
          error: '登录已中断，请重新登录。',
        });
    }
    await this.cleanup();
    const retained = [
      ...(await this.repository.config()).providers.flatMap((provider) =>
        provider.chatgpt ? [provider.chatgpt.connectionId] : [],
      ),
      ...Object.values(await this.session.authFlows()).flatMap((flow) =>
        flow.connectionId ? [flow.connectionId] : [],
      ),
    ];
    await this.repository.pruneAuthRecords(retained);
  }
  async clear() {
    return this.exclusive('start', async () => {
      for (const flow of Object.values(await this.session.authFlows()))
        await this.cancel(flow.id, flow.statusKey);
      for (const provider of (await this.repository.config()).providers)
        if (provider.chatgpt) await this.disconnect(provider.chatgpt.connectionId);
      await this.session.clear();
      await this.repository.clear();
    });
  }
  async cleanup() {
    return this.exclusive('cleanup', async () => {
      for (const flow of Object.values(await this.session.authFlows())) {
        if (flow.expiresAt > Date.now()) continue;
        // Serialize against a callback still in flight; never delete its flow
        // while it is saving a newly issued credential.
        await this.cancel(flow.id, flow.statusKey);
        await this.session.updateAuthFlows((current) => {
          delete current[flow.id];
          return current;
        });
      }
    });
  }
}
