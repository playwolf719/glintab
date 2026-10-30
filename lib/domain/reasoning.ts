import type { ReasoningEffort } from '../../types';

export const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'none', label: '关闭（none）' },
  { value: 'minimal', label: '最少（minimal）' },
  { value: 'low', label: '低（low）' },
  { value: 'medium', label: '中（medium）' },
  { value: 'high', label: '高（high）' },
  { value: 'xhigh', label: '更高（xhigh）' },
  { value: 'max', label: '最高（max）' },
];

export function validateReasoningEffort(
  value: unknown,
): asserts value is ReasoningEffort | undefined {
  if (value !== undefined && !REASONING_EFFORT_OPTIONS.some((option) => option.value === value))
    throw new Error('推理强度设置无效，请重新选择。');
}
