import { useEffect, useRef, useState } from 'react';
import { Copy, ClipboardPaste, RotateCcw } from 'lucide-react';
import type { AuthJsonSnapshot, Provider } from '../../types';
import { AUTH_JSON_LIMIT } from '../../lib/domain/auth-json';
import { errorText, rpc } from '../../lib/platform/rpc';
import { ErrorBanner } from '../ui/primitives';

export interface AuthJsonDraft {
  json: string;
  original: string;
  revision?: string;
  replace?: boolean;
}
export function ChatGPTAuthEditor({
  connection,
  value,
  onChange,
  disabled,
}: {
  connection?: Provider['chatgpt'];
  value: AuthJsonDraft;
  onChange(value: AuthJsonDraft): void;
  disabled: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [reload, setReload] = useState(0);
  const pasted = useRef(false);
  useEffect(() => {
    let alive = true;
    pasted.current = false;
    setError('');
    setFeedback('');
    onChange({ json: '', original: '' });
    if (!connection) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void rpc<AuthJsonSnapshot>({
      type: 'chatgpt:auth:get',
      connectionId: connection.connectionId,
      draftKey: connection.draftKey,
    })
      .then((snapshot) => {
        if (!alive) return;
        onChange({ json: snapshot.json, original: snapshot.json, revision: snapshot.revision });
        if (snapshot.invalid) setFeedback('当前凭证已失效，可以粘贴新的 auth.json 后保存。');
      })
      .catch((error) => {
        if (alive) setError(errorText(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connection?.connectionId, connection?.draftKey, reload]);
  async function copy() {
    setError('');
    try {
      await navigator.clipboard.writeText(value.json);
      setFeedback('auth.json 已复制');
    } catch {
      setError('无法复制，请在文本框中全选并复制。');
    }
  }
  async function paste() {
    setError('');
    try {
      const json = await navigator.clipboard.readText();
      if (json.length > AUTH_JSON_LIMIT) throw new Error();
      pasted.current = true;
      onChange({ ...value, json, replace: true });
      setFeedback('已粘贴，点击「保存连接」后覆盖当前账号凭证。');
    } catch {
      setError('无法读取剪贴板，请在文本框中使用系统粘贴快捷键；最多 128,000 个字符。');
    }
  }
  return (
    <section className="auth-json-editor" aria-label="ChatGPT auth.json">
      <div className="section-title">
        <h2>auth.json</h2>
      </div>
      <p className="muted">当前连接在本扩展中使用的账号凭证。包含完整令牌，请勿分享。</p>
      <ErrorBanner message={error} onClose={() => setError('')} />
      <label className="field">
        <span className="sr-only">账号 auth.json</span>
        <textarea
          aria-label="账号 auth.json"
          rows={12}
          value={value.json}
          onChange={(event) => {
            onChange({
              ...value,
              json: event.target.value,
              replace: pasted.current || value.replace,
            });
            setFeedback('');
          }}
          onPaste={() => {
            pasted.current = true;
            onChange({ ...value, replace: true });
          }}
          disabled={disabled || loading}
          maxLength={AUTH_JSON_LIMIT}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={
            loading
              ? '正在读取当前凭证…'
              : '可直接粘贴 ChatGPT 账号的 auth.json，填写名称和模型后保存连接。'
          }
        />
        <small>
          粘贴后点击「保存连接」将覆盖当前账号凭证，支持更换账号。重新读取会替换未保存内容。
        </small>
      </label>
      <div className="auth-json-actions">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || loading || !value.json}
          onClick={() => void copy()}
        >
          <Copy size={14} />
          复制 auth.json
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || loading}
          onClick={() => void paste()}
        >
          <ClipboardPaste size={14} />
          粘贴 auth.json
        </button>
        {connection && (
          <button
            type="button"
            className="text-link"
            disabled={disabled || loading}
            onClick={() => setReload((value) => value + 1)}
          >
            <RotateCcw size={13} />
            重新读取
          </button>
        )}
      </div>
      {feedback && (
        <p className="muted" role="status">
          {feedback}
        </p>
      )}
      {value.json !== value.original && <p className="muted">auth.json 有未保存的修改</p>}
    </section>
  );
}
