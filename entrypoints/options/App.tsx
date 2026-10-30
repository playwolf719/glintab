import { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  CircleHelp,
  KeyRound,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  FileAudio,
} from 'lucide-react';
import { Brand, ErrorBanner, IconButton } from '../../components/ui/primitives';
import { ProviderForm } from '../../components/providers/ProviderForm';
import { TranscriptionSettings } from '../../components/providers/TranscriptionSettings';
import { useConfig } from '../../lib/ui/use-config';
import { VIDEO_PROMPT, WEB_PROMPT } from '../../config/defaults';
import { SUMMARY_PROMPT_LIMIT } from '../../lib/domain/settings';
import type { Provider, Settings } from '../../types';
import { errorText, rpc } from '../../lib/platform/rpc';
import { grantProvider } from '../../lib/platform/permissions';

export default function App() {
  const { config, error, setError, loaded } = useConfig();
  const [section, setSection] = useState<'providers' | 'prompts' | 'general' | 'transcription'>(
    'providers',
  );
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [settings, setSettings] = useState<Settings>(config.settings);
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSettings(config.settings);
  }, [config.settings]);
  useEffect(() => {
    if (!loaded) return;
    const params = new URLSearchParams(location.search);
    if (params.has('add')) setEditing('new');
    else if (params.has('edit'))
      setEditing(config.providers.find((p) => p.id === params.get('edit')) || null);
  }, [loaded]);
  async function action(operation: () => Promise<unknown>, success = '') {
    setError('');
    setFeedback('');
    try {
      await operation();
      if (success) setFeedback(success);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function saveSettings() {
    setSaving(true);
    await action(() => rpc({ type: 'settings:save', settings }), '设置已保存');
    setSaving(false);
  }
  function closeForm() {
    setEditing(null);
    history.replaceState(null, '', location.pathname);
  }
  const nav = [
    { id: 'providers', label: 'AI 供应商', icon: KeyRound },
    { id: 'prompts', label: '摘要指令', icon: Sparkles },
    { id: 'transcription', label: '语音转写', icon: FileAudio },
    { id: 'general', label: '通用设置', icon: SlidersHorizontal },
  ] as const;
  return (
    <div className="settings-shell">
      <aside className="settings-nav">
        <Brand />
        <div className="nav-caption">阅读，从理解开始</div>
        <nav aria-label="设置导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? 'active' : ''}
              onClick={() => {
                setSection(item.id);
                closeForm();
                setError('');
                setFeedback('');
              }}
            >
              <item.icon size={17} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="nav-bottom">
          <div>
            <ShieldCheck size={15} />
            <span>本地优先 · 自备密钥</span>
          </div>
          <span>Glintab v0.1.0</span>
        </div>
      </aside>
      <main className="settings-main">
        <header className="settings-topbar">
          <span>工作空间 / 设置</span>
          <button
            className="help-link"
            onClick={() => {
              setSection('general');
              closeForm();
            }}
            aria-label="数据与隐私说明"
          >
            <CircleHelp size={16} />
            <span>数据与隐私</span>
          </button>
        </header>
        <div className="settings-content">
          <ErrorBanner message={error} onClose={() => setError('')} />
          {feedback && (
            <div className="success-banner" role="status">
              <CheckCircle2 size={16} />
              {feedback}
            </div>
          )}
          {section === 'providers' &&
            (editing ? (
              <ProviderForm
                provider={editing === 'new' ? undefined : editing}
                onClose={closeForm}
              />
            ) : (
              <>
                <div className="page-heading heading-with-action">
                  <div>
                    <h1>AI 供应商</h1>
                    <p>用你熟悉的模型，读懂每一个网页。</p>
                  </div>
                  <button className="button primary" onClick={() => setEditing('new')}>
                    <Plus size={16} />
                    添加供应商
                  </button>
                </div>
                <div className="privacy-callout">
                  <span className="callout-icon">
                    <ShieldCheck size={22} />
                  </span>
                  <div>
                    <strong>你的模型，你的数据。</strong>
                    <p>
                      Glintab
                      直接连接所选服务商。密钥与阅读历史保存在当前设备，网页内容仅在你发起请求时发送。
                    </p>
                  </div>
                </div>
                {!loaded ? (
                  <p className="muted">正在加载配置…</p>
                ) : !config.providers.length ? (
                  <div className="providers-empty">
                    <span className="empty-provider-icon">
                      <KeyRound size={28} />
                    </span>
                    <h2>连接第一个 AI 供应商</h2>
                    <p>
                      支持 ChatGPT 账号、OpenAI 兼容服务与本地模型。
                      <br />
                      几项配置，就能拥有你的网页阅读助手。
                    </p>
                    <button className="button primary" onClick={() => setEditing('new')}>
                      <Plus size={16} />
                      添加供应商
                    </button>
                    <span className="muted">也可导入 Claude Code、Codex 或 OpenCode 配置</span>
                  </div>
                ) : (
                  <div className="provider-list">
                    {config.providers.map((provider) => (
                      <div className="provider-row" key={provider.id}>
                        <span className="provider-avatar">
                          {provider.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="provider-details">
                          <div>
                            <strong>{provider.name}</strong>
                            {config.currentProviderId === provider.id && (
                              <span className="active-badge">
                                <Check size={11} />
                                使用中
                              </span>
                            )}
                          </div>
                          <span>{provider.model}</span>
                          <small>
                            {provider.authType === 'chatgpt'
                              ? `ChatGPT 账号 · ${provider.chatgpt?.email || '已授权'}`
                              : provider.baseUrl}
                          </small>
                        </div>
                        <div className="provider-row-actions">
                          {config.currentProviderId !== provider.id && (
                            <button
                              className="button secondary compact"
                              onClick={() =>
                                void action(() => rpc({ type: 'provider:select', id: provider.id }))
                              }
                            >
                              使用
                            </button>
                          )}
                          <IconButton
                            label={`编辑 ${provider.name}`}
                            onClick={() => setEditing(provider)}
                          >
                            <Pencil size={16} />
                          </IconButton>
                          <IconButton
                            label={`删除 ${provider.name}`}
                            onClick={() => {
                              if (
                                confirm(
                                  provider.authType === 'chatgpt'
                                    ? `断开「${provider.name}」并删除此浏览器保存的登录凭证？远程授权需在 OpenAI 账号设置中管理。`
                                    : `删除「${provider.name}」及其本地 API Key？`,
                                )
                              )
                                void action(
                                  () => rpc({ type: 'provider:delete', id: provider.id }),
                                  '供应商已删除',
                                );
                            }}
                          >
                            <Trash2 size={16} />
                          </IconButton>
                          <IconButton
                            label={`补充授权 ${provider.name}`}
                            onClick={() =>
                              void action(() => grantProvider(provider.baseUrl), '域名权限已就绪')
                            }
                          >
                            <ShieldCheck size={16} />
                          </IconButton>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="settings-section">
                  <div>
                    <h2>提取内容</h2>
                    <p>在对话中查看、复制或下载发送给模型的网页正文。</p>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label="显示提取内容入口"
                      checked={config.settings.showContent}
                      onChange={(e) =>
                        void action(() =>
                          rpc({
                            type: 'settings:save',
                            settings: { ...config.settings, showContent: e.target.checked },
                          }),
                        )
                      }
                    />
                    <span />
                  </label>
                </div>
                <div className="settings-footnote">
                  <Settings2 size={14} />
                  <span>添加后，回到网页点击工具栏中的 Glintab 图标即可开始。</span>
                </div>
              </>
            ))}
          {section === 'transcription' && <TranscriptionSettings config={config.transcription} />}
          {section === 'prompts' && (
            <>
              <div className="page-heading">
                <h1>摘要指令</h1>
                <p>分别自定义网页和视频总结的提示词，让摘要更贴近你的阅读习惯。</p>
              </div>
              <div className="section-title">
                <h2>网页摘要</h2>
                <button
                  className="text-link"
                  aria-label="恢复默认网页指令"
                  onClick={() => setSettings({ ...settings, webPrompt: WEB_PROMPT })}
                >
                  <RotateCcw size={13} />
                  恢复默认
                </button>
              </div>
              <label className="field">
                <span className="sr-only">网页摘要指令</span>
                <textarea
                  rows={8}
                  value={settings.webPrompt}
                  onChange={(e) => setSettings({ ...settings, webPrompt: e.target.value })}
                  maxLength={SUMMARY_PROMPT_LIMIT}
                />
                <small>这段指令用于「帮我总结这篇网页」。直接提问时使用你输入的问题。</small>
              </label>
              <div className="section-title">
                <h2>视频摘要</h2>
                <button
                  className="text-link"
                  aria-label="恢复默认视频指令"
                  onClick={() => setSettings({ ...settings, videoPrompt: VIDEO_PROMPT })}
                >
                  <RotateCcw size={13} />
                  恢复默认
                </button>
              </div>
              <label className="field">
                <span className="sr-only">视频摘要指令</span>
                <textarea
                  rows={8}
                  value={settings.videoPrompt}
                  onChange={(e) => setSettings({ ...settings, videoPrompt: e.target.value })}
                  maxLength={SUMMARY_PROMPT_LIMIT}
                />
                <small>
                  这段指令用于 YouTube 和 B 站的「帮我总结这个视频」。直接提问时使用你输入的问题。
                </small>
              </label>
              <div className="form-footer">
                <button
                  className="button primary"
                  disabled={saving || !settings.webPrompt.trim() || !settings.videoPrompt.trim()}
                  onClick={() => void saveSettings()}
                >
                  保存指令
                </button>
              </div>
            </>
          )}
          {section === 'general' && (
            <>
              <div className="page-heading">
                <h1>通用设置</h1>
                <p>保持简单，让注意力留在内容上。</p>
              </div>
              <div className="settings-section">
                <div>
                  <h2>回答语言</h2>
                  <p>应用于网页、视频摘要和后续提问。</p>
                </div>
                <select
                  aria-label="回答语言"
                  value={settings.summaryLanguage}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      summaryLanguage: e.target.value as Settings['summaryLanguage'],
                    })
                  }
                >
                  <option value="zh">简体中文</option>
                  <option value="en">English</option>
                  <option value="auto">跟随正文语言</option>
                </select>
              </div>
              <div className="settings-section">
                <div>
                  <h2>界面语言</h2>
                  <p>当前版本使用简体中文。</p>
                </div>
                <span className="muted">简体中文</span>
              </div>
              <div className="form-footer">
                <button
                  className="button primary"
                  disabled={saving}
                  onClick={() => void saveSettings()}
                >
                  保存设置
                </button>
              </div>
              <section className="data-section">
                <h2>本地数据与隐私</h2>
                <p>
                  最近 10
                  个网页的会话保存在本机；同一网址共享已保存的历史，生成任务按标签页独立运行。不同标签页同时写入相同网址时，最近保存的结果作为历史。
                </p>
                <p>
                  模型请求包含网页正文、标题、网址、问题及必要的历史。Glintab
                  没有远程自建服务端、遥测或云同步。API Key 保存在插件本地；ChatGPT
                  登录凭证由后台保存在此浏览器的扩展本地存储中，未加密。
                </p>
                <button
                  className="button danger"
                  onClick={() => {
                    if (
                      confirm(
                        '清除所有供应商、API Key、ChatGPT 登录凭证、会话历史和设置？远程授权不会自动撤销。此操作无法撤销。',
                      )
                    )
                      void action(() => rpc({ type: 'data:clear' }), '所有本地数据已清除');
                  }}
                >
                  <Trash2 size={15} />
                  清除全部本地数据
                </button>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
