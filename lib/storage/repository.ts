import { DEFAULT_CONFIG } from '../../config/defaults';
import { validateSettings } from '../domain/settings';
import type {
  AppConfig,
  Conversation,
  ChatGPTAuthRecord,
  ChatGPTAuthFlow,
  Provider,
  Settings,
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
  config(): Promise<AppConfig> {
    return this.write(() => this.loadConfig());
  }
  private async loadConfig(): Promise<AppConfig> {
    const { config } = await this.driver.get('config');
    const saved = config as
      | (Omit<Partial<AppConfig>, 'schemaVersion' | 'settings'> & {
          schemaVersion: number;
          settings?: Partial<Settings>;
        })
      | undefined;
    if (saved && saved.schemaVersion !== 1 && saved.schemaVersion !== 2)
      throw new Error('此配置版本无法读取，请使用兼容版本的扩展。');
    const next: AppConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      ...saved,
      schemaVersion: 2,
      settings: { ...DEFAULT_CONFIG.settings, ...saved?.settings },
    };
    // Read migrations run under the same queue as mutations. Preserve the user's
    // webpage prompt and add the independent default video prompt exactly once.
    if (saved?.schemaVersion === 1) await this.driver.set({ config: next });
    return next;
  }
  updateConfig(transform: (config: AppConfig) => AppConfig) {
    return this.write(async () => {
      const config = transform(await this.loadConfig());
      await this.driver.set({ config });
      return config;
    });
  }
  async saveSettings(settings: Settings) {
    const validated = validateSettings(settings);
    return this.updateConfig((config) => ({ ...config, settings: validated }));
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
      const config = await this.loadConfig();
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
      const used = (await this.loadConfig()).providers.some(
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
