import { Plus, Trash2 } from 'lucide-react';
import type { DomainPrompt } from '../../types';
import { DOMAIN_PROMPT_LIMIT, SUMMARY_PROMPT_LIMIT } from '../../lib/domain/settings';

export function DomainPromptSettings({
  rules,
  onChange,
  disabled,
}: {
  rules: DomainPrompt[];
  onChange: (rules: DomainPrompt[]) => void;
  disabled: boolean;
}) {
  const patch = (id: string, changes: Partial<DomainPrompt>) =>
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...changes } : rule)));
  return (
    <section aria-label="域名专属摘要指令">
      <div className="section-title">
        <h2>域名专属摘要</h2>
        <button
          className="text-link"
          disabled={disabled || rules.length >= DOMAIN_PROMPT_LIMIT}
          onClick={() => onChange([...rules, { id: crypto.randomUUID(), domain: '', prompt: '' }])}
        >
          <Plus size={13} />
          添加域名
        </button>
      </div>
      <p className="muted">
        匹配域名及其子域时，使用专属指令替代上方网页或视频指令；更具体的域名优先。直接提问不受影响。
      </p>
      {!rules.length && (
        <p className="muted">尚未添加域名，当前使用上方通用指令。最多可添加 50 条。</p>
      )}
      {rules.map((rule, index) => (
        <div className="domain-prompt-rule" key={rule.id}>
          <div className="section-title">
            <h3>域名指令 {index + 1}</h3>
            <button
              className="text-link"
              aria-label={`删除域名指令 ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(rules.filter((item) => item.id !== rule.id))}
            >
              <Trash2 size={13} />
              删除
            </button>
          </div>
          <label className="field">
            域名 {index + 1}
            <input
              aria-label={`域名 ${index + 1}`}
              value={rule.domain}
              onChange={(event) => patch(rule.id, { domain: event.target.value })}
              placeholder="例如 example.com 或 docs.example.com"
              maxLength={253}
              spellCheck={false}
              disabled={disabled}
            />
            <small>仅填写域名，不含 https://、路径、端口或通配符。</small>
          </label>
          <label className="field">
            专属摘要指令 {index + 1}
            <textarea
              rows={5}
              value={rule.prompt}
              onChange={(event) => patch(rule.id, { prompt: event.target.value })}
              placeholder="填写此网站的摘要要求"
              maxLength={SUMMARY_PROMPT_LIMIT}
              disabled={disabled}
            />
          </label>
        </div>
      ))}
    </section>
  );
}
