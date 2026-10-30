import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  BookOpen,
  ChevronDown,
  ExternalLink,
  FileText,
  Globe,
  PanelRight,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useConfig } from '../../lib/ui/use-config';
import { useChat } from '../../components/chat/use-chat';
import { Brand, ErrorBanner, IconButton } from '../../components/ui/primitives';
import { Message } from '../../components/chat/Message';
import { ContentDialog } from '../../components/chat/ContentDialog';
import { errorText, rpc } from '../../lib/platform/rpc';
import { isReadableUrl, pageKey } from '../../lib/domain/page';
import { videoTarget } from '../../lib/domain/video';
import { PAGE_ACCESS_DECLINED, PAGE_ACCESS_REQUIRED } from '../../lib/platform/permissions';

export default function App() {
  const { config, loaded, error: configError } = useConfig();
  const chat = useChat();
  const [question, setQuestion] = useState('');
  const [editId, setEditId] = useState<string>();
  const [viewContent, setViewContent] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const mode = new URLSearchParams(location.search).get('mode');
  const currentProvider = config.providers.find((p) => p.id === config.currentProviderId);
  const messages = chat.conversation?.messages || [];
  const hasMessages = messages.some((m) => !m.hidden);
  const lastUser = messages.findLast((m) => m.role === 'user' && !m.hidden)?.id;
  const source = chat.conversation?.source;
  const isVideo = !!videoTarget(chat.tab?.url || '');
  const readable = isReadableUrl(chat.tab?.url);
  useEffect(() => {
    if (stickToBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [chat.conversation, chat.phase]);
  useEffect(() => {
    setQuestion('');
    setEditId(undefined);
    setViewContent(false);
    stickToBottom.current = true;
  }, [chat.tab?.id, pageKey(chat.tab?.url || '')]);
  async function send() {
    if (!question.trim()) return;
    stickToBottom.current = true;
    if (await chat.send(question.trim(), false, false, editId)) {
      setQuestion('');
      setEditId(undefined);
    }
  }
  async function summarize(refresh = false) {
    if (
      hasMessages &&
      !confirm(
        refresh
          ? '重新提取会替换此页面的对话并生成摘要，是否继续？'
          : '重新摘要会替换此页面的对话，是否继续？',
      )
    )
      return;
    stickToBottom.current = true;
    await chat.send('', true, refresh);
  }
  const openSettings = () => void chrome.runtime.openOptionsPage();
  let domain = '当前网页';
  try {
    domain = new URL(chat.tab?.url || '').hostname;
  } catch {
    /* restricted tab */
  }
  return (
    <div className="chat-app">
      <header className="panel-header">
        <Brand small />
        <div className="header-actions">
          {mode === 'drawer' && (
            <IconButton
              label="使用浏览器侧栏"
              onClick={() => {
                if (chat.tab?.id)
                  void chrome.sidePanel
                    .open({ tabId: chat.tab.id })
                    .then(() => rpc({ type: 'drawer:close', tabId: chat.tab!.id! }))
                    .catch((e) => chat.setError(errorText(e)));
              }}
            >
              <PanelRight size={17} />
            </IconButton>
          )}
          {mode !== 'window' && (
            <IconButton
              label="在独立窗口打开"
              onClick={() => {
                if (chat.tab?.id)
                  void rpc({ type: 'window:open', tabId: chat.tab.id }).catch((e) =>
                    chat.setError(errorText(e)),
                  );
              }}
            >
              <ExternalLink size={16} />
            </IconButton>
          )}
          <IconButton label="设置" onClick={openSettings}>
            <Settings size={17} />
          </IconButton>
          {mode === 'drawer' && (
            <IconButton
              label="关闭侧栏"
              onClick={() => {
                if (chat.tab?.id) void rpc({ type: 'drawer:close', tabId: chat.tab.id });
              }}
            >
              <X size={18} />
            </IconButton>
          )}
        </div>
      </header>
      <div className="source-bar">
        <div className="source-icon">
          <Globe size={17} />
        </div>
        <div className="source-info">
          <strong title={chat.tab?.title}>
            {source?.title || chat.tab?.title || '打开一个网页，开始阅读'}
          </strong>
          <span>
            {domain}
            {source && (
              <>
                {' '}
                <span className="source-divider">/</span>{' '}
                <button
                  className="text-link"
                  disabled={!config.settings.showContent}
                  onClick={() => setViewContent(true)}
                >
                  {source.content.length.toLocaleString()} 字符
                  {source.truncated ? '（已截断）' : ''}
                </button>
              </>
            )}
          </span>
        </div>
        <IconButton
          label="重新提取并摘要"
          disabled={chat.busy || !currentProvider || !readable}
          onClick={() => void summarize(true)}
        >
          <RefreshCw size={15} />
        </IconButton>
      </div>
      <ErrorBanner message={chat.error || configError} onClose={() => chat.setError('')} />
      {[PAGE_ACCESS_REQUIRED, PAGE_ACCESS_DECLINED].includes(chat.error) ? (
        <>
          <button className="permission-action" onClick={() => void chat.authorize(true)}>
            一次授权所有网站
          </button>
          <button className="permission-action" onClick={() => void chat.authorize(false)}>
            仅授权当前网站
          </button>
        </>
      ) : null}
      <main
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          if (scroll.current)
            stickToBottom.current =
              scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight <
              60;
        }}
        aria-busy={chat.busy}
      >
        {!hasMessages && (
          <div className="welcome">
            <div className="reading-illustration" aria-hidden="true">
              <div className="paper back" />
              <div className="paper front">
                <div />
                <div />
                <div />
                <span />
                <div />
                <div />
              </div>
              <span className="illustration-spark">
                <Sparkles size={23} />
              </span>
            </div>
            <h1>每一页，都读得更深。</h1>
            <p>
              提炼重点，连接思路。
              <br />
              {isVideo ? '提取视频字幕，按时间线理解内容。' : '让 AI 和你一起理解当前网页。'}
            </p>
            {!loaded || chat.phase === 'loading' ? (
              <div className="muted">正在加载…</div>
            ) : !currentProvider ? (
              <>
                <button className="button primary" onClick={openSettings}>
                  <Plus size={17} />
                  添加 AI 供应商
                </button>
                <p className="welcome-note">连接你自己的模型，开始第一次阅读。</p>
              </>
            ) : !readable ? (
              <div className="empty-note">
                <BookOpen size={18} />
                <span>
                  此页面受浏览器保护。
                  <br />
                  打开一篇普通网页后，即可摘要和提问。
                </span>
              </div>
            ) : (
              <div className="quick-actions">
                <button
                  className="summary-action"
                  disabled={chat.busy}
                  onClick={() => void summarize()}
                >
                  <span className="quick-icon">
                    <Sparkles size={20} />
                  </span>
                  <span>
                    <strong>{isVideo ? '帮我总结这个视频' : '帮我总结这篇网页'}</strong>
                    <small>
                      {isVideo ? '依据字幕提炼重点，附上时间戳' : '抓住核心观点与关键事实'}
                    </small>
                  </span>
                  <ArrowUp size={17} className="diagonal-arrow" />
                </button>
                <button
                  className="subtle-action"
                  disabled={chat.busy}
                  onClick={() => {
                    setQuestion(
                      isVideo
                        ? '这个视频的核心观点是什么？请引用字幕时间戳。'
                        : '这篇文章的核心论点是什么？有哪些证据支持？',
                    );
                    input.current?.focus();
                  }}
                >
                  梳理论点与证据
                </button>
                <button
                  className="subtle-action"
                  disabled={chat.busy}
                  onClick={() => {
                    setQuestion(
                      isVideo
                        ? '请依据字幕解释这个视频，并说明有哪些局限，引用相关时间戳。'
                        : '请用容易理解的语言解释这篇文章，并说明有哪些局限。',
                    );
                    input.current?.focus();
                  }}
                >
                  换个角度理解
                </button>
              </div>
            )}
          </div>
        )}
        {hasMessages && (
          <div className="messages">
            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                pending={chat.busy && message.id === messages.at(-1)?.id}
                editable={message.id === lastUser && !chat.busy}
                onEdit={() => {
                  setQuestion(message.content);
                  setEditId(message.id);
                  input.current?.focus();
                }}
                onError={chat.setError}
              />
            ))}
            {chat.conversation?.notice && (
              <div className="conversation-notice" role="status">
                {chat.conversation.notice}
              </div>
            )}
          </div>
        )}
      </main>
      <div className="composer-area">
        {hasMessages && !chat.busy && (
          <div className="conversation-tools">
            <button className="text-link" onClick={() => void summarize()}>
              <RefreshCw size={12} />
              重新摘要
            </button>
            {source && config.settings.showContent && (
              <button className="text-link" onClick={() => setViewContent(true)}>
                <FileText size={12} />
                {source.video ? '查看字幕' : '查看正文'}
              </button>
            )}
          </div>
        )}
        {chat.busy && chat.phase !== 'loading' && (
          <div className="generation-status" role="status">
            <span className="status-dot" />
            {chat.phase === 'extracting'
              ? isVideo
                ? '正在提取视频字幕…'
                : '正在提取网页正文…'
              : chat.phase === 'starting'
                ? '正在启动模型…'
                : '正在生成回答，关闭面板后仍会继续'}
          </div>
        )}
        {editId && (
          <div className="editing-label">
            编辑最后一个问题
            <button
              onClick={() => {
                setEditId(undefined);
                setQuestion('');
              }}
            >
              取消
            </button>
          </div>
        )}
        <div className="composer">
          <textarea
            ref={input}
            aria-label={isVideo ? '向当前视频提问' : '向当前网页提问'}
            placeholder={
              currentProvider
                ? isVideo
                  ? '针对这个视频，问点什么…'
                  : '针对这篇网页，问点什么…'
                : '先添加 AI 供应商，再开始对话'
            }
            value={question}
            maxLength={20000}
            rows={3}
            disabled={!currentProvider || !readable || chat.busy}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-bottom">
            <div className="provider-select">
              <select
                aria-label="当前 AI 供应商"
                disabled={chat.busy || !config.providers.length}
                value={config.currentProviderId || ''}
                onChange={(e) =>
                  void rpc({ type: 'provider:select', id: e.target.value }).catch((e) =>
                    chat.setError(errorText(e)),
                  )
                }
              >
                {!config.providers.length && <option value="">选择模型</option>}
                {config.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} / {provider.model}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </div>
            {chat.phase === 'running' ? (
              <button
                className="send-button stop"
                aria-label="停止生成"
                title="停止生成"
                onClick={() => void chat.stop()}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-button"
                aria-label="发送问题"
                title="Enter 发送，Shift+Enter 换行"
                disabled={!question.trim() || chat.busy || !currentProvider || !readable}
                onClick={() => void send()}
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
        <div className="privacy-hint">
          <ShieldCheck size={11} />
          <span>历史保存在本机 · 正文仅发送至所选模型</span>
        </div>
      </div>
      {viewContent && source && (
        <ContentDialog source={source} onClose={() => setViewContent(false)} />
      )}
    </div>
  );
}
