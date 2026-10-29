import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import type { PageSource } from '../../types';
import { Modal } from '../ui/primitives';
export function ContentDialog({ source, onClose }: { source: PageSource; onClose(): void }) {
  const [feedback, setFeedback] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(source.content);
      setFeedback('已复制');
    } catch {
      setFeedback('复制失败，请手动选择文本复制。');
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([`# ${source.title}\n\n来源：${source.url}\n\n${source.content}`], {
        type: 'text/markdown;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${source.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 70) || 'glintab'}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Modal title="提取的网页内容" onClose={onClose} wide>
      <div className="content-meta">
        <strong>{source.title}</strong>
        <span>
          {source.content.length.toLocaleString()} 字符{source.truncated ? ' · 已截断' : ''}
          {source.fallback ? ' · 整页提取' : ' · 正文提取'}
        </span>
        <span>{new Date(source.extractedAt).toLocaleString()}</span>
      </div>
      <pre className="source-text">{source.content}</pre>
      <footer>
        <span className="feedback" role="status">
          {feedback}
        </span>
        <button className="button secondary" onClick={copy}>
          <Copy size={15} />
          复制
        </button>
        <button className="button primary" onClick={download}>
          <Download size={15} />
          下载 Markdown
        </button>
      </footer>
    </Modal>
  );
}
