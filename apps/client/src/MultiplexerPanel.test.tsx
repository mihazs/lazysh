// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MuxPanel } from './MultiplexerPanel';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
const tree = { tmuxAvailable: true, herdrAvailable: false, zellijAvailable: false, sessions: [{ id: '$3', name: 'work', windows: [{ id: '@7', name: 'agent', index: 0, active: true, panes: [{ id: '%9', index: 0, active: true, command: 'claude', path: '/project' }] }] }] };
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
it('remembers the selected workspace tree layout across mounts', async () => {
  vi.mocked(invoke).mockResolvedValue(tree);
  const first = render(<MuxPanel sessionId="ssh1" onAttach={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Workspace layout'), { target: { value: 'grid' } });
  first.unmount();
  render(<MuxPanel sessionId="ssh2" onAttach={vi.fn()} />);
  expect(screen.getByLabelText('Workspace layout')).toHaveProperty('value', 'grid');
  await screen.findByRole('button', { name: 'Attach work' });
});
it('offers actual recent host projects in the workspace launcher', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'agent_snapshot' ? { schemaVersion: 1, sessions: [{ sessionId: 'agent1', agent: 'Claude Code', project: '/recent/project', state: 'done', updatedAt: '2026-10-24T10:00:00Z', summary: 'Stopped', paneId: null, eventCount: 1 }] } : tree);
  render(<MuxPanel sessionId="ssh1" onAttach={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load recent projects' }));
  fireEvent.change(await screen.findByLabelText('Recent project directory'), { target: { value: '/recent/project' } });
  expect(screen.getByLabelText('Project directory')).toHaveProperty('value', '/recent/project');
  expect(screen.queryByRole('region', { name: /prefix shortcuts/ })).toBeNull();
});
it('attaches the selected named Herdr server through the generic terminal contract', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'multiplexer_tree' ? { ...tree, herdrAvailable: true } : [{ name: 'builds' }]);
  const attach = vi.fn().mockResolvedValue(undefined);
  render(<MuxPanel sessionId="ssh1" onAttach={attach} />);
  fireEvent.click(await screen.findByRole('button', { name: 'List herdr sessions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Attach herdr builds' }));
  await waitFor(() => expect(attach).toHaveBeenCalledWith('builds', 'herdr'));
});
it('targets the stable pane ID and leaves attachment on its own terminal', async () => {
  vi.mocked(invoke).mockResolvedValue(tree);
  const attach = vi.fn().mockResolvedValue(undefined);
  render(<MuxPanel sessionId="ssh1" onAttach={attach} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Select %9' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'selectPane', target: '%9' } }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach work' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Attach work' }));
  await waitFor(() => expect(attach).toHaveBeenCalledWith('work'));
});
it('creates a named workspace in the explicit project directory', async () => {
  vi.mocked(invoke).mockResolvedValue(tree);
  render(<MuxPanel sessionId="ssh1" onAttach={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'project' } });
  fireEvent.change(screen.getByLabelText('Project directory'), { target: { value: '/work/project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'createSession', name: 'project', directory: '/work/project' } }));
});
it('discloses unsupported controls and host command failures', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ...tree, herdrAvailable: true }).mockRejectedValue({ message: 'Pane no longer exists' });
  render(<MuxPanel sessionId="ssh1" onAttach={vi.fn()} />);
  expect(await screen.findByText(/Browse a Herdr session/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Select %9' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Pane no longer exists');
});
