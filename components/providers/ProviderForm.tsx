import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Download, Eye, EyeOff, LoaderCircle, Save } from 'lucide-react';
import type { ApiFormat, Provider } from '../../types';
import { DEFAULT_CONTEXT_LIMIT, PRESETS } from '../../config/defaults';
import { importConfig } from '../../lib/config/import';
import { REASONING_EFFORT_OPTIONS } from '../../lib/domain/reasoning';
import { grantProvider } from '../../lib/platform/permissions';
import { errorText, rpc } from '../../lib/platform/rpc';
import { ErrorBanner, IconButton } from '../ui/primitives';
import { ChatGPTConnection } from './ChatGPTConnection';

export function ProviderForm({ provider, onClose }: { provider?: Provider; onClose(): void }) {
  const [value, setValue] = useState<Provider>(
    provider || {
      id: crypto.randomUUID(),
      name: '',
      baseUrl: '',
      apiKey: '',
      model: '',
      apiFormat: 'openai_chat',
      contextLimit: DEFAULT_CONTEXT_LIMIT,
      createdAt: Date.now(),
    },
  );
  const [showKey, setShowKey] = useState(false);
  const [authMode, setAuthMode] = useState<'api_key' | 'chatgpt'>(provider?.authType || 'api_key');
  const apiDraft = useRef(value);
  const uncommitted = useRef<Provider | null>(null);
  useEffect(
    () => () => {
      const draft = uncommitted.current;
      if (draft?.chatgpt)
        void rpc({
          type: 'chatgpt:connection:discard',
          connectionId: draft.chatgpt.connectionId,
          draftKey: draft.chatgpt.draftKey || '',
        }).catch(() => {});
    },
    [],
  );
  async function discardDraft() {
    const draft = uncommitted.current;
    if (draft?.chatgpt)
      await rpc({
        type: 'chatgpt:connection:discard',
        connectionId: draft.chatgpt.connectionId,
        draftKey: draft.chatgpt.draftKey || '',
      });
    uncommitted.current = null;
  }
  async function close() {
    try {
      setBusy(true);
      await discardDraft();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function changeMode(mode: 'api_key' | 'chatgpt') {
    if (mode === authMode || busy) return;
    try {
      await discardDraft();
      if (mode === 'chatgpt') {
        apiDraft.current = value;
        setValue({
          ...value,
          name: '',
          model: '',
          baseUrl: '',
          apiKey: '',
          authType: 'chatgpt',
          chatgpt: undefined,
        });
      } else setValue(apiDraft.current);
      setRaw('');
      setModels([]);
      setError('');
      setAuthMode(mode);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const [raw, setRaw] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(false);
  const [importApplied, setImportApplied] = useState('');
  const patch = (changes: Partial<Provider>) =>
    setValue((previous) => ({
      ...previous,
      ...changes,
      ...(changes.apiFormat === 'anthropic' ? { reasoningEffort: undefined } : {}),
    }));
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
      uncommitted.current = null;
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
      const available = await rpc<string[]>({ type: 'models:list', provider: value });
      setModels(available);
      if (authMode === 'chatgpt')
        setValue((previous) => ({ ...previous, model: previous.model || available[0] || '' }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function connected(connection: Provider) {
    if (!provider) uncommitted.current = connection;
    setValue((previous) => ({ ...connection, reasoningEffort: previous.reasoningEffort }));
    setError('');
    setBusy(true);
    try {
      const available = await rpc<string[]>({ type: 'models:list', provider: connection });
      setModels(available);
      setValue((previous) => ({ ...previous, model: previous.model || available[0] || '' }));
    } catch (e) {
      setError(`账号授权已完成，但模型列表加载失败。${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="provider-form-page">
      <button className="back-link" disabled={busy} onClick={() => void close()}>
        <ArrowLeft size={15} />
        返回供应商
      </button>
      <div className="page-heading">
        <h1>{provider ? '编辑供应商' : '连接你的 AI'}</h1>
        <p>选择 API Key 或使用 ChatGPT 账号授权接入。</p>
      </div>
      <ErrorBanner message={error} onClose={() => setError('')} />
      {!provider && (
        <div className="connection-modes" role="group" aria-label="接入方式">
          <button
            type="button"
            className={authMode === 'api_key' ? 'active' : ''}
            disabled={busy}
            onClick={() => void changeMode('api_key')}
          >
            API Key / 自定义服务
          </button>
          <button
            type="button"
            className={authMode === 'chatgpt' ? 'active' : ''}
            disabled={busy}
            onClick={() => void changeMode('chatgpt')}
          >
            ChatGPT 账号登录
          </button>
        </div>
      )}
      {authMode === 'chatgpt' && (
        <ChatGPTConnection
          provider={provider}
          onConnected={(connection) => void connected(connection)}
        />
      )}
      <form onSubmit={save} className="settings-form">
        {!provider && authMode === 'api_key' && (
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
        {authMode === 'api_key' && (
          <>
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
            <div className="settings-section">
              <div>
                <h2>流式输出</h2>
                <p>开启后逐步显示回答。模型不支持流式时关闭，等待完整回答。</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="流式输出"
                  checked={value.stream !== false}
                  onChange={(e) => patch({ stream: e.target.checked })}
                  disabled={busy}
                />
                <span />
              </label>
            </div>
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
          </>
        )}
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
        {(authMode === 'chatgpt' || value.apiFormat !== 'anthropic') && (
          <label className="field">
            推理强度（Reasoning effort）
            <select
              aria-label="推理强度"
              value={value.reasoningEffort || ''}
              onChange={(e) =>
                patch({
                  reasoningEffort: (e.target.value || undefined) as Provider['reasoningEffort'],
                })
              }
              disabled={busy}
            >
              <option value="">跟随服务端（默认）</option>
              {REASONING_EFFORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>仅选择模型支持的档位。更高强度可能增加等待时间和用量。</small>
          </label>
        )}
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
        {authMode === 'api_key' && (
          <details className="import-section">
            <summary>从已有配置导入 JSON / TOML</summary>
            <p>
              支持 Claude Code、Codex API Key / TOML、OpenCode 和通用
              JSON。粘贴内容只在此表单中解析。
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
        )}
        <div className="form-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void close()}
          >
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || (authMode === 'chatgpt' && !value.chatgpt)}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
            {authMode === 'chatgpt' ? '保存连接' : '保存并授权'}
          </button>
        </div>
      </form>
    </div>
  );
}
