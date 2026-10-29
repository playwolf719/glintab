import { expect, it } from 'vitest';
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
