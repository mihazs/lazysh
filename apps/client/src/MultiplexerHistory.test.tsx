// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import MultiplexerHistory from './MultiplexerHistory';
import { applyAccessStatus } from './access';
import type { SessionAttachment } from './workspace';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
beforeEach(() => applyAccessStatus({ initialized: true, supported: true, enabled: true, locked: false, reason: '', generation: '1', nonce: 'b'.repeat(64) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
const open = (attached: SessionAttachment, read: object | Error) => {
  vi.mocked(invoke).mockImplementation(async () => { if (read instanceof Error) throw read; return read; });
  render(<MultiplexerHistory sessionId="ssh1" attached={attached} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read history' }));
};

it('reads the attached tmux server session from the host, then filters and copies what it shows', async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true });
  open({ kind: 'tmux', name: 'work', tmuxServer: 'side' }, { text: lines(5000), lines: 5000, truncated: false });
  const text = await screen.findByLabelText('Pane history', { selector: 'pre' });
  expect(invoke).toHaveBeenCalledWith('multiplexer_history', { sessionId: 'ssh1', kind: 'tmux', name: 'work', tmuxServer: 'side' }, { headers: { 'X-Lazysh-Access': expect.any(String) } });
  expect(text.textContent).toMatch(/^line 1\n/);
  expect(text.textContent).toMatch(/\nline 5000$/);
  expect(screen.getByRole('status', { name: '' }).textContent).toBe('Lines shown: 5,000 of 5,000');
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.change(screen.getByLabelText('Search history'), { target: { value: 'LINE 49' } });
  expect(text.textContent).toBe(['line 49', ...Array.from({ length: 10 }, (_, i) => `line ${490 + i}`), ...Array.from({ length: 100 }, (_, i) => `line ${4900 + i}`)].join('\n'));
  expect(screen.getByRole('status', { name: '' }).textContent).toBe('Lines shown: 111 of 5,000');
  fireEvent.click(screen.getByRole('button', { name: 'Copy these lines' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(text.textContent));
  fireEvent.change(screen.getByLabelText('Search history'), { target: { value: 'absent' } });
  expect(screen.getByText('No line matches.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Copy these lines' })).toBeNull();
});

it.each([
  ['zellij', 'Older output is not shown: this view keeps the newest 20,000 lines or 2 MiB.'],
  ['herdr', 'Herdr serves at most the newest 1,000 lines of a pane, so older output is not shown.'],
] as const)('says when %s history was cut to its bound', async (kind, note) => {
  open({ kind, name: 'work' }, { text: lines(3), lines: 3, truncated: true });
  expect((await screen.findByRole('note')).textContent).toBe(note);
  expect(invoke).toHaveBeenCalledWith('multiplexer_history', { sessionId: 'ssh1', kind, name: 'work' }, expect.anything());
});

it('reports an empty pane and a host failure without showing stale text', async () => {
  open({ kind: 'zellij', name: 'work' }, { text: '', lines: 0, truncated: false });
  expect(await screen.findByText('The pane has no history yet.')).toBeTruthy();
  vi.mocked(invoke).mockRejectedValue(new Error('zellij: no such session'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect((await screen.findByRole('alert')).textContent).toBe('zellij: no such session');
});
