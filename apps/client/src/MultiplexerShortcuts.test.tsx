// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MultiplexerShortcuts from './MultiplexerShortcuts';
import { api } from './bridge';
vi.mock('./bridge', () => ({ api: { write: vi.fn().mockResolvedValue(undefined) }, native: true }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
it('sends a validated custom prefix and action only to the attached PTY', async () => {
  render(<MultiplexerShortcuts sessionId="attached-tmux" kind="tmux" />);
  fireEvent.change(screen.getByLabelText('Multiplexer prefix key'), { target: { value: 'Ctrl+a' } });
  fireEvent.click(screen.getByRole('button', { name: 'New window' }));
  await waitFor(() => expect(api.write).toHaveBeenCalledWith('attached-tmux', '\x01c'));
});
it('disables multi-step prefixes before any terminal write', () => {
  render(<MultiplexerShortcuts sessionId="attached-herdr" kind="herdr" />);
  fireEvent.change(screen.getByLabelText('Multiplexer prefix key'), { target: { value: 'Ctrl+b\tn' } });
  expect(screen.getByRole('button', { name: 'New tab' }).hasAttribute('disabled')).toBe(true);
  expect(api.write).not.toHaveBeenCalled();
});
