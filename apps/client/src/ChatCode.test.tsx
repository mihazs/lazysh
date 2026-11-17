// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ChatRich} from './ChatRich';

const written: string[] = [];
beforeEach(() => {
  written.length = 0;
  vi.stubGlobal('navigator', {...navigator, clipboard: {writeText: async (text: string) => { written.push(text); }}});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const fence = (language: string, body: string) => `\`\`\`${language}\n${body}\n\`\`\``;

it('shows a fenced block with its language and copies exactly the code', async () => {
  const body = 'const a = "<b>x</b>";\n\tif (a) { run(); }';
  const {container} = render(<ChatRich text={fence('ts', body)} copy/>);
  expect(screen.getByRole('figure', {name: 'Code: ts'})).toBeTruthy();
  expect(container.querySelector('.chat-code-language')?.textContent).toBe('ts');
  fireEvent.click(screen.getByRole('button', {name: 'Copy code'}));
  await waitFor(() => expect(screen.getByRole('button', {name: 'Copied'})).toBeTruthy());
  expect(written).toEqual([body]);
});

it('colours a known language without changing its text and never turns code into markup', async () => {
  const body = 'const text = "<img src=x onerror=alert(1)>";';
  const {container} = render(<ChatRich text={fence('typescript', body)} copy/>);
  await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull());
  expect(container.querySelector('code')?.textContent).toBe(body);
  expect(container.querySelector('img, script')).toBeNull();
});

it('leaves a block without a known language plain, and a long line scrolls inside the block', () => {
  const {container} = render(<ChatRich text={fence('', 'x'.repeat(400))} copy/>);
  expect(container.querySelector('.chat-code-language')?.textContent).toBe('');
  expect(container.querySelector('[class^=hljs]')).toBeNull();
  expect(screen.getByRole('figure', {name: 'Code'})).toBeTruthy();
  expect(container.querySelector('pre')?.tabIndex).toBe(0);
});

it('draws a Markdown table as a table in a scroll region, with strikethrough and task lists', () => {
  const {container} = render(<ChatRich text={'| Step | Time |\n| --- | --- |\n| Build | 3 min |\n\n~~old~~\n\n- [x] done\n- [ ] todo'}/>);
  expect(screen.getByRole('region', {name: 'Table'}).tabIndex).toBe(0);
  expect(screen.getByRole('columnheader', {name: 'Step'})).toBeTruthy();
  expect(screen.getByRole('cell', {name: '3 min'})).toBeTruthy();
  expect(container.querySelector('del')?.textContent).toBe('old');
  expect([...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].map(box => box.checked)).toEqual([true, false]);
});
