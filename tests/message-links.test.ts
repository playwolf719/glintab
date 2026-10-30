// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Message } from '../components/chat/Message';

it('renders complete signed link destinations without exposing the Markdown AST node as an HTML attribute', () => {
  const url =
    'https://www.xiaohongshu.com/explore/note-test?xsec_token=synthetic%2Btoken%3D&xsec_source=';
  const markup = renderToStaticMarkup(
    createElement(Message, {
      message: { id: 'answer', role: 'assistant', content: `[原笔记](${url})` },
      pending: false,
      editable: false,
      onEdit() {},
      onError() {},
    }),
  );
  const container = document.createElement('div');
  container.innerHTML = markup;
  const link = container.querySelector('a')!;
  expect(link.href).toBe(url);
  expect(link.hasAttribute('node')).toBe(false);
  expect(link.target).toBe('_blank');
  expect(link.rel).toBe('noopener noreferrer');
});
