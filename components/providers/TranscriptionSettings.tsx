import { useEffect, useState } from 'react';
import type { TranscriptionConfig } from '../../types';
import { AUDIO_ORIGINS, validateTranscription } from '../../lib/domain/transcription';
import { providerOrigin } from '../../lib/platform/permissions';
import { errorText, rpc } from '../../lib/platform/rpc';
import { ErrorBanner } from '../ui/primitives';

export function TranscriptionSettings({ config }: { config?: TranscriptionConfig }) {
  const [value, setValue] = useState<TranscriptionConfig>(
    config || { enabled: false, baseUrl: '', apiKey: '', model: '', responseFormat: 'json' },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (config) setValue(config);
  }, [config]);
  const patch = (changes: Partial<TranscriptionConfig>) => {
    setValue((previous) => ({ ...previous, ...changes }));
    setSaved(false);
  };
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      const next = validateTranscription(value);
      if (
        next.enabled &&
        !(await chrome.permissions.request({
          origins: [providerOrigin(next.baseUrl), ...AUDIO_ORIGINS],
        }))
      )
        throw new Error('未获得转写服务或 B 站音轨域名权限。');
      await rpc({ type: 'transcription:save', config: next });
      setSaved(true);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>语音转写</h1>
        <p>B 站没有字幕时，下载当前分 P 的音轨并转成文字，再交给所选 AI 总结。</p>
      </div>
      <ErrorBanner message={error} onClose={() => setError('')} />
      <form className="settings-form" onSubmit={save}>
        <div className="settings-section">
          <div>
            <h2>启用 B 站音轨转写</h2>
            <p>优先读取字幕；无字幕时才上传音频，可能产生转写服务费用。</p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              aria-label="启用 B 站音轨转写"
              checked={value.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
              disabled={busy}
            />
            <span />
          </label>
        </div>
        <label className="field">
          转写 Base URL
          <input
            value={value.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
            disabled={busy}
            spellCheck={false}
          />
          <small>支持 OpenAI 兼容的文件转写服务，自动追加 /audio/transcriptions。</small>
        </label>
        <label className="field">
          转写 API Key
          <input
            type="password"
            value={value.apiKey}
            onChange={(event) => patch({ apiKey: event.target.value })}
            autoComplete="off"
            disabled={busy}
            spellCheck={false}
          />
          <small>仅保存在本机，未加密；本地转写服务可留空。</small>
        </label>
        <label className="field">
          转写模型 ID
          <input
            value={value.model}
            onChange={(event) => patch({ model: event.target.value })}
            disabled={busy}
            placeholder="填写服务商支持的语音转写模型"
            spellCheck={false}
          />
        </label>
        <label className="field">
          转写响应格式
          <select
            value={value.responseFormat}
            onChange={(event) =>
              patch({ responseFormat: event.target.value as TranscriptionConfig['responseFormat'] })
            }
            disabled={busy}
          >
            <option value="json">JSON（通用文字转写）</option>
            <option value="verbose_json">Verbose JSON（支持时返回分段时间戳）</option>
          </select>
          <small>按服务商和模型要求选择；没有时间戳时只展示文字，不生成视频定位链接。</small>
        </label>
        <p className="muted">
          首版支持 60 分钟以内、音轨不超过 64 MB
          的普通投稿视频。音频分段上传，原音频仅在内存中处理；转写文字随会话保存在本机。关闭面板后任务仍继续，可点击停止。失败后手动重试可能重复计费。
        </p>
        {saved && (
          <div className="success-banner" role="status">
            转写设置已保存
          </div>
        )}
        <div className="form-footer">
          <button className="button primary" disabled={busy} type="submit">
            保存转写设置并授权
          </button>
        </div>
      </form>
    </>
  );
}
