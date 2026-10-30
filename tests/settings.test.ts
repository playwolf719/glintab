import { expect, it } from 'vitest';
import { summaryPrompt } from '../lib/domain/settings';
import { DEFAULT_CONFIG } from '../config/defaults';

it('selects the independently configured prompt for web and either video platform', () => {
  const settings = {
    ...DEFAULT_CONFIG.settings,
    webPrompt: '仅用于网页',
    videoPrompt: '仅用于视频',
  };
  expect(summaryPrompt({}, settings)).toBe('仅用于网页');
  for (const platform of ['youtube', 'bilibili'] as const)
    expect(
      summaryPrompt(
        { video: { platform, videoId: 'video', language: 'zh', automatic: false, segments: [] } },
        settings,
      ),
    ).toBe('仅用于视频');
});
