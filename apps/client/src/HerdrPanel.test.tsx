// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import HerdrPanel from './HerdrPanel';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('keeps Herdr session, workspace, tab and pane identity in each command', async () => {
  const tree = { workspaces: [{ workspace_id: 'w2', label: 'project', focused: true, agent_status: 'working' }], tabs: [{ tab_id: 'w2:t4', workspace_id: 'w2', label: 'agent', number: 1, focused: true, agent_status: 'blocked' }], panes: [{ pane_id: 'w2:p9', workspace_id: 'w2', tab_id: 'w2:t4', cwd: '/work', focused: true, agent_status: 'blocked' }] };
  vi.mocked(invoke).mockResolvedValue(tree);
  render(<HerdrPanel sessionId="ssh1" name="builds" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Focus agent w2:p9' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('herdr_action', { sessionId: 'ssh1', name: 'builds', action: { type: 'focusAgent', target: 'w2:p9' } }));
  expect(screen.getByText(/w2:p9 · blocked/)).toBeTruthy();
});
