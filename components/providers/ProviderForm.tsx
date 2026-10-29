import { useState } from 'react';
import { ArrowLeft, Check, Download, Eye, EyeOff, LoaderCircle, Save } from 'lucide-react';
import type { ApiFormat, Provider } from '../../types';
import { PRESETS } from '../../config/defaults';
import { importConfig } from '../../lib/config/import';
import { grantProvider } from '../../lib/platform/permissions';
import { errorText, rpc } from '../../lib/platform/rpc';
import { ErrorBanner, IconButton } from '../ui/primitives';

export function ProviderForm({ provider, onClose }: { provider?: Provider; onClose(): void }) {
  const [value, setValue] = useState<Provider>(
    provider || {
      id: crypto.randomUUID(),
      name: '',
      baseUrl: '',
      apiKey: '',
      model: '',
      apiFormat: 'openai_chat',
      contextLimit: 32768,
      createdAt: Date.now(),
    },
  );
  const [showKey, setShowKey] = useState(false);
  const [raw, setRaw] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(false);
  const [importApplied, setImportApplied] = useState('');
  const patch = (changes: Partial<Provider>) =>
    setValue((previous) => ({ ...previous, ...changes }));
  function applyImport() {
    try {
      patch(importConfig(raw));
      setImportApplied(raw);
      setImported(true);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      // Parse again when the user pasted a configuration and immediately saved.
      const finalValue =
        raw.trim() && raw !== importApplied ? { ...value, ...importConfig(raw) } : value;
      if (!finalValue.name.trim() || !finalValue.model.trim())
        throw new Error('请填写供应商名称和模型；也可以先点击「填入表单」检查导入结果。');
      setBusy(true);
      await grantProvider(finalValue.baseUrl);
      await rpc({ type: 'provider:save', provider: finalValue });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function getModels() {
    setError('');
    setBusy(true);
    try {
      await grantProvider(value.baseUrl);
      setModels(await rpc<string[]>({ type: 'models:list', provider: value }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="provider-form-page">
      <button className="back-link" onClick={onClose}>
        <ArrowLeft size={15} />
        返回供应商
      </button>
      <div className="page-heading">
        <h1>{provider ? '编辑供应商' : '连接你的 AI'}</h1>
        <p>使用自己的 API Key，直接连接模型服务。</p>
      </div>
      <ErrorBanner message={error} onClose={() => setError('')} />
      <form onSubmit={save} className="settings-form">
        {!provider && (
          <div className="preset-row" aria-label="服务商预设">
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className={value.name === preset.name ? 'preset active' : 'preset'}
                onClick={() => patch(preset)}
              >
                {preset.name}
              </button>
            ))}
          </div>
        )}
        <label className="field">
          供应商名称
          <input
            value={value.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="例如：我的 DeepSeek"
            maxLength={80}
          />
        </label>
        <label className="field">
          API 协议
          <select
            value={value.apiFormat}
            onChange={(e) => patch({ apiFormat: e.target.value as ApiFormat })}
          >
            <option value="openai_chat">OpenAI Chat Completions</option>
            <option value="anthropic">Anthropic Messages</option>
            <option value="openai_responses">OpenAI Responses</option>
          </select>
        </label>
        <label className="field">
          Base URL
          <input
            value={value.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder={
              value.apiFormat === 'anthropic'
                ? 'https://api.anthropic.com'
                : 'https://api.example.com/v1'
            }
            spellCheck={false}
          />
          <small>
            {value.apiFormat === 'anthropic'
              ? '自动拼接 /v1/messages；已有 /v1 时不会重复添加。'
              : '填写 API 根地址（通常包含 /v1），无需填写具体接口路径。'}
          </small>
        </label>
        <label className="field">
          API Key
          <div className="password-field">
            <input
              aria-label="API Key"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              value={value.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
              placeholder="sk-…（本机服务可留空）"
              spellCheck={false}
            />
            <IconButton
              label={showKey ? '隐藏密钥' : '显示密钥'}
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
            </IconButton>
          </div>
          <small>仅保存于本机插件存储，未加密。不会保存导入的配置原文。</small>
        </label>
        <label className="field">
          模型
          <div className="inline-field">
            <input
              aria-label="模型"
              list="model-list"
              value={value.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder="填写服务商支持的模型 ID"
              spellCheck={false}
            />
            <button
              type="button"
              className="button secondary"
              disabled={busy || !value.baseUrl}
              onClick={() => void getModels()}
            >
              <Download size={14} />
              获取模型
            </button>
          </div>
          <datalist id="model-list">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <small>获取失败时，可以直接手动填写。</small>
        </label>
        <label className="field">
          上下文上限（tokens）
          <input
            type="number"
            min={4096}
            max={2000000}
            step={1}
            value={value.contextLimit}
            onChange={(e) => patch({ contextLimit: Number(e.target.value) })}
          />
          <small>按模型实际能力填写。系统为输出预留空间，超出时缩减正文与较早的对话。</small>
        </label>
        <details className="import-section">
          <summary>从已有配置导入 JSON / TOML</summary>
          <p>
            支持 Claude Code、Codex API Key / TOML、OpenCode 和通用 JSON。粘贴内容只在此表单中解析。
          </p>
          <textarea
            aria-label="导入配置"
            rows={7}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setImported(false);
            }}
            placeholder={
              '{ "baseUrl": "https://api.example.com/v1",\n  "apiKey": "…", "model": "…" }'
            }
            spellCheck={false}
          />
          <button
            type="button"
            className="button secondary"
            onClick={applyImport}
            disabled={!raw.trim()}
          >
            {imported ? <Check size={14} /> : <Download size={14} />}
            {imported ? '已填入表单' : '填入表单'}
          </button>
        </details>
        <div className="form-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存并授权
          </button>
        </div>
      </form>
    </div>
  );
}
