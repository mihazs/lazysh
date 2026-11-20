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
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('zellij_action', { sessionId: 'ssh1', name: 'builds', action: { type: 'goToTab', index: 3 } }, { headers: { "X-Lazysh-Access": expect.any(String) } }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Session disappeared');
});
const headers = { headers: { "X-Lazysh-Access": expect.any(String) } };
const full: string[] = [];
const panes = [
  { id: 0, title: 'Pane #1', command: 'zsh', tab: 'Tab #1', focused: true, columns: 25, rows: 48 },
  { id: 3, title: 'logs', command: 'tail -f build.log', tab: 'Tab #1', focused: false, columns: 25, rows: 48 },
];
const actionsSent = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'zellij_action').map(([, args]) => (args as { action: unknown }).action);
function host(listed = panes) {
  vi.mocked(invoke).mockImplementation(async command => (command === 'zellij_panes' ? listed : undefined));
}
async function readPanes(props: Partial<Parameters<typeof ZellijPanel>[0]> = {}) {
  render(<ZellijPanel sessionId="ssh1" name="builds" missing={full} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read Zellij panes' }));
  await screen.findByRole('button', { name: 'Close pane 3' });
}
it('shows no pane or session action unless the version gate allows it', () => {
  host();
  for (const missing of [undefined, ['tree', 'rename', 'close', 'resize', 'launch', 'confirmedInput']]) {
    const view = render(<ZellijPanel sessionId="ssh1" name="builds" missing={missing} />);
    for (const name of ['Read Zellij panes', 'Rename Zellij session', 'Close Zellij session']) expect(screen.queryByRole('button', { name })).toBeNull();
    view.unmount();
  }
  expect(vi.mocked(invoke)).not.toHaveBeenCalled();
});
it('offers only the actions the gate lists, and never renames the session a terminal is attached to', async () => {
  host();
  await readPanes({ missing: ['rename'], attachedHere: false });
  expect(screen.queryByRole('button', { name: 'Rename Zellij session' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Rename pane 3' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Close Zellij session' })).toBeTruthy();
  cleanup();
  await readPanes({ attachedHere: true });
  expect(screen.queryByRole('button', { name: 'Rename Zellij session' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Rename pane 3' })).toBeTruthy();
});
it('lists the panes with their size and tab', async () => {
  host();
  await readPanes();
  expect(invoke).toHaveBeenCalledWith('zellij_panes', { sessionId: 'ssh1', name: 'builds' }, headers);
  expect(screen.getByText('Pane 3 · tail -f build.log')).toBeTruthy();
  expect(screen.getByText('Tab #1 · 25×48 · logs')).toBeTruthy();
});
it('cancelling a pane close sends nothing and confirming sends one action by its number', async () => {
  host();
  await readPanes();
  vi.mocked(invoke).mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Close pane 3' }));
  expect(screen.getByRole('alertdialog').textContent).toContain('Close “Pane 3 · tail -f build.log”?');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close pane 3' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm close' }));
  await waitFor(() => expect(actionsSent()).toEqual([{ type: 'closePane', target: 3 }]));
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'zellij_panes')).toHaveLength(1));
});
it('closes the session only after a confirmation that names it, then tells its owner', async () => {
  host();
  const onClosed = vi.fn();
  render(<ZellijPanel sessionId="ssh1" name="it's builds" missing={full} onClosed={onClosed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close Zellij session' }));
  expect(screen.getByRole('alertdialog').textContent).toContain('Close “it\'s builds”?');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(actionsSent()).toEqual([]);
  expect(onClosed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close Zellij session' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm close' }));
  await waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
  expect(vi.mocked(invoke)).toHaveBeenCalledExactlyOnceWith('zellij_action', { sessionId: 'ssh1', name: "it's builds", action: { type: 'closeSession' } }, headers);
});
it('keeps the session when Zellij refuses the close', async () => {
  vi.mocked(invoke).mockRejectedValue({ message: 'Session disappeared' });
  const onClosed = vi.fn();
  render(<ZellijPanel sessionId="ssh1" name="builds" missing={full} onClosed={onClosed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close Zellij session' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm close' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Session disappeared');
  expect(onClosed).not.toHaveBeenCalled();
});
it('renames a pane by its number with the typed name, literally', async () => {
  host();
  await readPanes();
  vi.mocked(invoke).mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Rename pane 3' }));
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'logs');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: "-x';$(touch nope)" } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(actionsSent()).toEqual([{ type: 'renamePane', target: 3, name: "-x';$(touch nope)" }]));
  await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
});
it('renames the session and tells its owner the new name', async () => {
  host();
  const onRenamed = vi.fn();
  render(<ZellijPanel sessionId="ssh1" name="builds" missing={full} onRenamed={onRenamed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Rename Zellij session' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'deploys' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onRenamed).toHaveBeenCalledExactlyOnceWith('deploys'));
  expect(actionsSent()).toEqual([{ type: 'renameSession', name: 'deploys' }]);
});
it('moves a divider one step in the chosen direction and reads the panes again', async () => {
  host();
  await readPanes();
  vi.mocked(invoke).mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Move the divider of pane 0 right' }));
  await waitFor(() => expect(actionsSent()).toEqual([{ type: 'resizePane', target: 0, direction: 'right', amount: 1 }]));
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'zellij_panes')).toHaveLength(1));
});
