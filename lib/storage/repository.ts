import { DEFAULT_CONFIG } from '../../config/defaults';
import type { AppConfig, Conversation } from '../../types';
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
  clear() {
    return this.write(() => this.driver.clear());
  }
}
