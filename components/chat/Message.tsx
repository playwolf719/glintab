import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Pencil, Sparkles } from 'lucide-react';
import type { ChatMessage } from '../../types';
import { IconButton } from '../ui/primitives';
export function Message({
  message,
  editable,
  pending,
  onEdit,
  onError,
}: {
  message: ChatMessage;
  editable: boolean;
  pending: boolean;
  onEdit(): void;
  onError(message: string): void;
}) {
  const [copied, setCopied] = useState(false);
  if (message.hidden) return null;
  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onError('复制失败，请选中文本后手动复制。');
    }
  }
  return (
    <article className={`message ${message.role}`}>
      {message.role === 'assistant' && (
        <div className="message-label">
          <Sparkles size={13} /> Glintab
        </div>
      )}
      <div className="message-body">
        {message.role === 'user' ? (
          <p>{message.content}</p>
        ) : message.content ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ node: _node, ...props }) => (
                <a {...props} target="_blank" rel="noopener noreferrer" />
              ),
              img: (props) => <span>[图片：{props.alt || '未加载'}]</span>,
            }}
          >
            {message.content}
          </ReactMarkdown>
        ) : (
          <span className="thinking">
            {pending ? '正在阅读与思考…' : '上次生成已中断，请重新发送问题。'}
          </span>
        )}
      </div>
      <div className="message-actions">
        <IconButton label={copied ? '已复制' : '复制回答'} onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
        {editable && (
          <IconButton label="编辑问题" onClick={onEdit}>
            <Pencil size={14} />
          </IconButton>
        )}
      </div>
    </article>
  );
}
