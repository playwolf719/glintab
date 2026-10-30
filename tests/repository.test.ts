import { expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, VIDEO_PROMPT } from '../config/defaults';
import { Repository, type StorageDriver } from '../lib/storage/repository';
import { conversation, provider } from './fixtures';
function driver(): StorageDriver {
  const data: Record<string, unknown> = {};
  return {
    async get(keys) {
      return structuredClone(
        keys == null
          ? data
          : Object.fromEntries(
              (typeof keys === 'string' ? [keys] : keys)
                .filter((key) => key in data)
                .map((key) => [key, data[key]]),
            ),
      );
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
    },
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}
it('serializes concurrent saves without losing other pages and evicts oldest histories', async () => {
  const storage = driver(),
    repository = new Repository(storage);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const value = conversation(`https://article.test/${i}`);
      value.updatedAt = i;
      return repository.save(value);
    }),
  );
  expect(await repository.conversation('https://article.test/0')).toBeNull();
  expect(await repository.conversation('https://article.test/1')).toBeNull();
  expect(await repository.conversation('https://article.test/11')).not.toBeNull();
  expect(Object.keys(await storage.get(null))).toHaveLength(10);
});
it('serializes config transforms and clears keys and history together', async () => {
  const repository = new Repository(driver());
  await Promise.all([
    repository.updateConfig((config) => ({ ...config, providers: [provider] })),
    repository.updateConfig((config) => ({ ...config, currentProviderId: provider.id })),
  ]);
  expect(await repository.config()).toMatchObject({
    currentProviderId: provider.id,
    providers: [provider],
  });
  await repository.clear();
  expect((await repository.config()).providers).toEqual([]);
});
it('migrates legacy prompts once without losing custom settings or concurrent changes', async () => {
  const storage = driver();
  await storage.set({
    config: {
      ...DEFAULT_CONFIG,
      schemaVersion: 1,
      providers: [provider],
      currentProviderId: provider.id,
      settings: {
        summaryLanguage: 'en',
        webPrompt: '保留原来的自定义网页指令',
        showContent: false,
      },
    },
  });
  const set = vi.spyOn(storage, 'set');
  const repository = new Repository(storage);
  const [loaded] = await Promise.all([
    repository.config(),
    repository.config(),
    repository.updateConfig((config) => ({
      ...config,
      settings: { ...config.settings, summaryLanguage: 'zh' },
    })),
  ]);
  expect(loaded).toMatchObject({
    schemaVersion: 2,
    providers: [provider],
    currentProviderId: provider.id,
    settings: {
      webPrompt: '保留原来的自定义网页指令',
      videoPrompt: VIDEO_PROMPT,
      summaryLanguage: 'en',
      showContent: false,
    },
  });
  expect((await repository.config()).settings.summaryLanguage).toBe('zh');
  expect((await storage.get('config')).config).toMatchObject({
    schemaVersion: 2,
    settings: { videoPrompt: VIDEO_PROMPT },
  });
  expect(set).toHaveBeenCalledTimes(2); // one migration and one settings change
});
it('reports migration persistence failure and can retry without discarding legacy values', async () => {
  const storage = driver();
  await storage.set({
    config: { ...DEFAULT_CONFIG, schemaVersion: 1, settings: { webPrompt: '旧指令' } },
  });
  vi.spyOn(storage, 'set').mockRejectedValueOnce(new Error('quota'));
  const repository = new Repository(storage);
  await expect(repository.config()).rejects.toThrow('quota');
  expect((await storage.get('config')).config).toMatchObject({ schemaVersion: 1 });
  expect((await repository.config()).settings).toMatchObject({
    webPrompt: '旧指令',
    videoPrompt: VIDEO_PROMPT,
  });
});
it('persists independent prompts and rejects invalid updates without overwriting settings', async () => {
  const repository = new Repository(driver());
  const settings = { ...DEFAULT_CONFIG.settings, webPrompt: '网页专用', videoPrompt: '视频专用' };
  await repository.saveSettings(settings);
  expect((await repository.config()).settings).toEqual(settings);
  for (const invalid of [
    { ...settings, webPrompt: ' ' },
    { ...settings, videoPrompt: '' },
    { ...settings, videoPrompt: '字'.repeat(12001) },
    { ...settings, webPrompt: '字'.repeat(12001) },
  ])
    await expect(repository.saveSettings(invalid)).rejects.toThrow('摘要指令');
  expect((await repository.config()).settings).toEqual(settings);
});
