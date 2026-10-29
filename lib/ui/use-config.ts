import { useEffect, useState } from 'react';
import type { AppConfig } from '../../types';
import { DEFAULT_CONFIG } from '../../config/defaults';
import { errorText, rpc } from '../platform/rpc';
export function useConfig() {
  const [config, setConfig] = useState<AppConfig>(structuredClone(DEFAULT_CONFIG));
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void rpc<AppConfig>({ type: 'config:get' })
      .then((value) => {
        if (alive) setConfig(value);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.config)
        setConfig((changes.config.newValue as AppConfig) || structuredClone(DEFAULT_CONFIG));
    };
    chrome.storage?.onChanged.addListener(listener);
    return () => {
      alive = false;
      chrome.storage?.onChanged.removeListener(listener);
    };
  }, []);
  return { config, setConfig, error, setError, loaded };
}
