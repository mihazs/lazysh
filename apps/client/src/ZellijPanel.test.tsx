// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import ZellijPanel from './ZellijPanel';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('sends session-scoped actions and reports host errors', async () => {
  vi.mocked(invoke).mockRejectedValue({ message: 'Session disappeared' });
  render(<ZellijPanel sessionId="ssh1" name="builds" />);
  fireEvent.change(screen.getByLabelText('Tab number'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Select Zellij tab' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('zellij_action', { sessionId: 'ssh1', name: 'builds', action: { type: 'goToTab', index: 3 } }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Session disappeared');
});
