// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {AgentPanel, parseSnapshot} from './AgentPanel';
import {applyAccessStatus} from './access';
import {readNames, saveName} from './agentSessionNames';

vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(), Channel: class {onmessage?: unknown;}}));
vi.mock('./ApprovalPanel', () => ({default: () => null}));

const report = (sessionId: string, extra: object = {}) => ({sessionId, agent: 'Claude Code', project: '/work/app', state: 'working', updatedAt: '2026-10-24T19:30:00Z', summary: 'Bash', paneId: null, eventCount: 1, ...extra});
let board: object[] = [];
let access = 0;
beforeEach(async () => {
  localStorage.clear();
  applyAccessStatus({initialized: true, supported: true, reason: '', enabled: true, locked: false, generation: String(++access), nonce: 'a'.repeat(64)});
  const {invoke} = await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockImplementation(async command => command === 'agent_snapshot' ? {schemaVersion: 1, sessions: board} : {});
});
afterEach(() => {cleanup(); vi.clearAllMocks();});

it('keeps a clean one-line title from the snapshot and drops one that is unusable', () => {
  const rows = parseSnapshot({schemaVersion: 1, sessions: [
    report('a', {title: '  Fix the\n\tlogin \u0007bug '}), report('b'), report('c', {title: 42}), report('d', {title: '\u001b\u0007'}), report('e', {title: 'x'.repeat(500)}),
  ]});
  expect(rows.map(row => row.title)).toEqual(['Fix the login bug', undefined, undefined, undefined, `${'x'.repeat(79)}…`]);
  expect(rows.map(row => 'title' in row)).toEqual([true, false, false, false, true]);
});

it('stores a name per host and session, and an empty name brings the reported title back', () => {
  const row = {agent: 'Claude Code', sessionId: 'a'};
  saveName('host-1', row, ' My \u0007 name\n');
  saveName('host-2', row, 'Elsewhere');
  expect(readNames('host-1')).toEqual({[JSON.stringify(['Claude Code', 'a'])]: 'My name'});
  expect(readNames('host-2')).not.toEqual(readNames('host-1'));
  saveName('host-1', row, '   ');
  expect(readNames('host-1')).toEqual({});
  for (let index = 0; index < 120; index++) saveName('host-1', {agent: 'Claude Code', sessionId: `s${index}`}, `Name ${index}`);
  const kept = Object.values(readNames('host-1'));
  expect(kept).toHaveLength(100);
  expect(kept[99]).toBe('Name 119');
});

it('tells two sessions of one folder apart by name, and a rename survives a new snapshot and a reload', async () => {
  board = [report('a', {title: 'Migrate the billing tables'}), report('b', {title: 'Write the release notes', summary: 'Edit'}), report('c')];
  const view = render(<AgentPanel sessionId="ssh-one" hostKey="host-1"/>);
  const rows = await screen.findAllByRole('button', {name: /^View /});
  expect(rows.map(row => row.querySelector('.agent-row-summary')?.textContent)).toEqual(['Migrate the billing tables', 'Write the release notes', 'Bash']);
  const named = rows[1];
  expect(within(named).getByText('Edit').className).toBe('agent-row-detail');
  expect(within(named).getByText('app')).toBeTruthy();
  expect(within(named).getByText('Claude Code')).toBeTruthy();
  expect(named.getAttribute('aria-label')).toBe('View Write the release notes (Claude Code) report for /work/app');

  fireEvent.change(screen.getByRole('searchbox'), {target: {value: 'billing'}});
  expect(screen.getAllByRole('button', {name: /^View /})).toHaveLength(1);
  fireEvent.change(screen.getByRole('searchbox'), {target: {value: ''}});

  fireEvent.click(screen.getAllByRole('button', {name: /^View /})[0]);
  const detail = screen.getByRole('region', {name: 'Selected report'});
  fireEvent.click(within(detail).getByRole('button', {name: 'Rename'}));
  const field = within(detail).getByLabelText('Session name') as HTMLInputElement;
  expect(field.value).toBe('Migrate the billing tables');
  fireEvent.change(field, {target: {value: 'Billing, mine'}});
  fireEvent.click(within(detail).getByRole('button', {name: 'Save name'}));
  expect(screen.getAllByRole('button', {name: /^View /})[0].querySelector('.agent-row-summary')?.textContent).toBe('Billing, mine');

  // The companion keeps reporting its own title: the user's name stays.
  board = [report('a', {title: 'Another reported title', eventCount: 3}), report('b'), report('c')];
  fireEvent.click(screen.getByRole('button', {name: 'Refresh'}));
  await waitFor(() => expect(screen.getAllByRole('button', {name: /^View /})[1].querySelector('.agent-row-summary')?.textContent).toBe('Bash'));
  expect(screen.getAllByRole('button', {name: /^View /})[0].querySelector('.agent-row-summary')?.textContent).toBe('Billing, mine');

  view.unmount();
  render(<AgentPanel sessionId="ssh-one" hostKey="host-1"/>);
  expect((await screen.findAllByRole('button', {name: /^View /}))[0].querySelector('.agent-row-summary')?.textContent).toBe('Billing, mine');

  // Saving it empty gives the reported title back.
  fireEvent.click(screen.getAllByRole('button', {name: /^View /})[0]);
  const again = screen.getByRole('region', {name: 'Selected report'});
  fireEvent.click(within(again).getByRole('button', {name: 'Rename'}));
  fireEvent.change(within(again).getByLabelText('Session name'), {target: {value: ''}});
  await act(async () => {fireEvent.click(within(again).getByRole('button', {name: 'Save name'}));});
  expect(screen.getAllByRole('button', {name: /^View /})[0].querySelector('.agent-row-summary')?.textContent).toBe('Another reported title');
  expect(readNames('host-1')).toEqual({});
});

it('shows today\'s row for a session that has no title and no name', async () => {
  board = [report('a')];
  render(<AgentPanel sessionId="ssh-one" hostKey="host-1"/>);
  const row = await screen.findByRole('button', {name: 'View Claude Code report for /work/app'});
  expect(row.querySelector('.agent-row-detail')).toBeNull();
  expect(row.querySelector('.agent-row-summary')?.textContent).toBe('Bash');
});
