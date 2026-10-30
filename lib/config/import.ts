import { parse } from 'smol-toml';
import type { Provider, ApiFormat } from '../../types';
import { validateReasoningEffort } from '../domain/reasoning';
type Imported = Partial<
  Pick<
    Provider,
    'name' | 'baseUrl' | 'apiKey' | 'model' | 'apiFormat' | 'contextLimit' | 'reasoningEffort'
  >
>;
export function importConfig(raw: string): Imported {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    try {
      data = parse(raw);
    } catch {
      throw new Error('无法解析配置，请粘贴有效的 JSON 或 TOML。');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('配置必须是 JSON 对象或 TOML 表。');
  let result: Imported;
  if (data.env) {
    const env = data.env;
    result = {
      name: 'Claude Code',
      apiFormat: 'anthropic',
      baseUrl: env.ANTHROPIC_BASE_URL,
      apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    };
  } else if (data.model_providers) {
    const provider =
      data.model_providers[data.model_provider] || Object.values(data.model_providers)[0] || {};
    result = {
      name: provider.name || data.model_provider || 'Codex',
      model: data.model,
      baseUrl: provider.base_url,
      apiKey: provider.experimental_bearer_token || provider.api_key,
      apiFormat: provider.wire_api === 'responses' ? 'openai_responses' : 'openai_chat',
      contextLimit: data.model_context_window,
      reasoningEffort: data.model_reasoning_effort,
    };
  } else if (data.provider && typeof data.provider === 'object') {
    const [name, ...model] = String(data.model || '').split('/');
    const provider: any = data.provider[name!] || Object.values(data.provider)[0] || {};
    const format: ApiFormat = String(provider.npm).includes('anthropic')
      ? 'anthropic'
      : /openai$/.test(String(provider.npm))
        ? 'openai_responses'
        : 'openai_chat';
    result = {
      name: provider.name || name,
      baseUrl: provider.options?.baseURL,
      apiKey: provider.options?.apiKey,
      model: model.join('/'),
      apiFormat: format,
      contextLimit: provider.models?.[model.join('/')]?.limit?.context,
    };
  } else {
    const format = data.apiFormat || data.api_format;
    if (format && !['openai_chat', 'anthropic', 'openai_responses'].includes(format))
      throw new Error('不支持的 apiFormat，请选择三种受支持的协议。');
    result = {
      name: data.name,
      baseUrl: data.baseUrl || data.baseURL || data.base_url,
      apiKey: data.apiKey || data.api_key || data.OPENAI_API_KEY,
      model: data.model,
      apiFormat: format,
      contextLimit: data.contextLimit,
      reasoningEffort: data.reasoningEffort ?? data.reasoning_effort ?? data.reasoning?.effort,
    };
  }
  const clean: Imported = {};
  validateReasoningEffort(result.reasoningEffort);
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || value === '') continue;
    if (key === 'contextLimit') {
      if (typeof value === 'number' && Number.isFinite(value)) clean.contextLimit = value;
    } else if (typeof value === 'string') Object.assign(clean, { [key]: value });
  }
  if (!Object.keys(clean).length)
    throw new Error('没有找到可导入的模型字段；OAuth 令牌导入暂不支持。');
  return clean;
}
