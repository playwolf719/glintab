import { DEFAULT_CONFIG } from '../../config/defaults';
import type {
  AppConfig,
  Conversation,
  ChatGPTAuthRecord,
  ChatGPTAuthFlow,
  Provider,
} from '../../types';
export interface StorageDriver {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}
const PREFIX = 'conversation:';
export class Repository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private driver: StorageDriver) {}
  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async config(): Promise<AppConfig> {
    const { config } = await this.driver.get('config');
    const saved = config as AppConfig | undefined;
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...saved,
      settings: { ...DEFAULT_CONFIG.settings, ...saved?.settings },
    };
  }
  updateConfig(transform: (config: AppConfig) => AppConfig) {
    return this.write(async () => {
      const config = transform(await this.config());
      await this.driver.set({ config });
      return config;
    });
  }
  async conversation(key: string): Promise<Conversation | null> {
    const result = await this.driver.get(PREFIX + key);
    return (result[PREFIX + key] as Conversation) || null;
  }
  save(conversation: Conversation) {
    return this.write(async () => {
      await this.driver.set({ [PREFIX + conversation.source.pageKey]: conversation });
      const all = await this.driver.get(null);
      const records = Object.entries(all)
        .filter(([key]) => key.startsWith(PREFIX))
        .sort((a, b) => (b[1] as Conversation).updatedAt - (a[1] as Conversation).updatedAt);
      const stale = records.slice(10).map(([key]) => key);
      if (stale.length) await this.driver.remove(stale);
    });
  }
  saveChatGPTProvider(provider: Provider) {
    return this.write(async () => {
      const record = await this.authRecord(provider.chatgpt!.connectionId);
      if (!record || record.invalid) throw new Error('ChatGPT 连接不可用，请重新登录。');
      const saved = {
        ...provider,
        apiKey: '',
        chatgpt: { connectionId: record.id, email: record.email },
      };
      const config = await this.config();
      const next = {
        ...config,
        providers: [...config.providers.filter((item) => item.id !== saved.id), saved].sort(
          (a, b) => a.createdAt - b.createdAt,
        ),
        currentProviderId: config.currentProviderId || saved.id,
      };
      await this.driver.set({ config: next });
      return next;
    });
  }
  removeDraftAuthRecord(id: string) {
    return this.write(async () => {
      const used = (await this.config()).providers.some(
        (provider) => provider.chatgpt?.connectionId === id,
      );
      if (!used) await this.driver.remove('chatgpt-auth:' + id);
    });
  }
  pruneAuthRecords(keep: string[]) {
    return this.write(async () => {
      const all = await this.driver.get(null);
      const stale = Object.keys(all).filter(
        (key) =>
          key.startsWith('chatgpt-auth:') && !keep.includes(key.slice('chatgpt-auth:'.length)),
      );
      if (stale.length) await this.driver.remove(stale);
    });
  }
  async authRecord(id: string): Promise<ChatGPTAuthRecord | undefined> {
    const data = await this.driver.get('chatgpt-auth:' + id);
    return data['chatgpt-auth:' + id] as ChatGPTAuthRecord | undefined;
  }
  updateAuthRecord(
    id: string,
    transform: (record: ChatGPTAuthRecord | undefined) => ChatGPTAuthRecord | undefined,
  ) {
    return this.write(async () => {
      const record = transform(await this.authRecord(id));
      if (record) await this.driver.set({ ['chatgpt-auth:' + id]: record });
      else await this.driver.remove('chatgpt-auth:' + id);
      return record;
    });
  }
  async authFlows(): Promise<Record<string, ChatGPTAuthFlow>> {
    return (
      ((await this.driver.get('chatgpt-flows'))['chatgpt-flows'] as Record<
        string,
        ChatGPTAuthFlow
      >) || {}
    );
  }
  updateAuthFlows(
    transform: (flows: Record<string, ChatGPTAuthFlow>) => Record<string, ChatGPTAuthFlow>,
  ) {
    return this.write(async () => {
      await this.driver.set({ 'chatgpt-flows': transform(await this.authFlows()) });
    });
  }
  clear() {
    return this.write(() => this.driver.clear());
  }
}
