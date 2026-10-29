import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, LogIn } from 'lucide-react';
import type { Provider } from '../../types';
import {
  CHATGPT_PERMISSION_ORIGINS,
  CHATGPT_PROVIDER_URL,
  type ChatGPTFlow,
  type ChatGPTLoginStatus,
} from '../../config/chatgpt';
import { errorText, rpc } from '../../lib/platform/rpc';
import { ErrorBanner } from '../ui/primitives';

export function ChatGPTConnection({
  provider,
  onConnected,
}: {
  provider?: Provider;
  onConnected(provider: Provider): void;
}) {
  const [flow, setFlow] = useState<ChatGPTFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(provider?.authType === 'chatgpt');
  const done = useRef(false);
  const initial = useRef(provider);
  useEffect(() => {
    if (!flow) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 5 * 60 * 1000;
    async function poll() {
      try {
        if (Date.now() > deadline) throw new Error('登录等待超时，请重新登录。');
        const result = await rpc<ChatGPTLoginStatus>({
          type: 'chatgpt:login:status',
          flowId: flow!.flowId,
          statusKey: flow!.statusKey,
        });
        if (!alive) return;
        if (result.status === 'connected' && result.connection) {
          done.current = true;
          setConnected(true);
          setBusy(false);
          setFlow(null);
          const connection = result.connection;
          onConnected({
            id: initial.current?.id || crypto.randomUUID(),
            name: initial.current?.name || `ChatGPT · ${connection.email}`,
            createdAt: initial.current?.createdAt || Date.now(),
            model: initial.current?.model || '',
            contextLimit: initial.current?.contextLimit || 32768,
            apiFormat: 'openai_responses',
            baseUrl: CHATGPT_PROVIDER_URL,
            apiKey: '',
            authType: 'chatgpt',
            chatgpt: {
              connectionId: connection.id,
              email: connection.email,
              draftKey: connection.draftKey,
            },
          });
          return;
        }
        if (result.status === 'error' || result.status === 'cancelled')
          throw new Error(result.error || '登录已取消，请重试。');
        timer = setTimeout(() => void poll(), 800);
      } catch (e) {
        if (alive) {
          setError(errorText(e));
          setBusy(false);
          setFlow(null);
        }
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      if (!done.current)
        void rpc({
          type: 'chatgpt:login:cancel',
          flowId: flow.flowId,
          statusKey: flow.statusKey,
        }).catch(() => {});
    };
  }, [flow]);
  async function login() {
    setError('');
    setBusy(true);
    done.current = false;
    try {
      if (!(await chrome.permissions.request({ origins: CHATGPT_PERMISSION_ORIGINS })))
        throw new Error('需要允许访问 OpenAI 授权与 ChatGPT 模型服务。');
      setFlow(await rpc<ChatGPTFlow>({ type: 'chatgpt:login:start', providerId: provider?.id }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  async function cancel() {
    if (!flow) return;
    try {
      await rpc({ type: 'chatgpt:login:cancel', flowId: flow.flowId, statusKey: flow.statusKey });
      setFlow(null);
      setBusy(false);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="chatgpt-connection">
      <div className="section-title">
        <h2>连接 ChatGPT 账号</h2>
        {connected && (
          <span className="active-badge">
            <CheckCircle2 size={12} />
            已授权
          </span>
        )}
      </div>
      <p>
        在当前浏览器打开 OpenAI 授权页。已有登录会话可以继续使用，按页面提示确认账号与授权范围。
      </p>
      <ErrorBanner message={error} onClose={() => setError('')} />
      <button
        type="button"
        className="button primary"
        onClick={() => void login()}
        disabled={busy || (connected && !provider)}
      >
        {busy ? <LoaderCircle size={16} className="spin" /> : <LogIn size={16} />}{' '}
        {busy ? '等待浏览器授权…' : connected ? '重新连接 ChatGPT' : '使用 ChatGPT 登录'}
      </button>
      {busy && (
        <button type="button" className="button secondary" onClick={() => void cancel()}>
          取消等待
        </button>
      )}
      <p className="login-help">
        无需本机服务。授权后自动保存到此浏览器，并在使用时刷新登录凭证。 此为 Codex
        兼容接入，账号资格与模型权限以 OpenAI 实际返回为准。
      </p>
    </section>
  );
}
