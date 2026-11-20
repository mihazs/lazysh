// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import HerdrPanel from './HerdrPanel';
import { uiI18n } from './i18n/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
afterEach(async () => { cleanup(); vi.resetAllMocks(); await uiI18n.changeLanguage('en'); });
function reportedTree() { return { workspaces: [{ workspace_id: 'w2', label: 'project', focused: true, agent_status: 'working' }], tabs: [{ tab_id: 'w2:t4', workspace_id: 'w2', label: 'agent', number: 1, focused: true, agent_status: 'blocked' }], panes: [{ pane_id: 'w2:p9', workspace_id: 'w2', tab_id: 'w2:t4', cwd: '/work', focused: true, agent_status: 'blocked' }] }; }
it('keeps Herdr session, workspace, tab and pane identity in each command', async () => {
  vi.mocked(invoke).mockResolvedValue(reportedTree());
  render(<HerdrPanel sessionId="ssh1" name="builds" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Focus agent w2:p9' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('herdr_action', { sessionId: 'ssh1', name: 'builds', action: { type: 'focusAgent', target: 'w2:p9' } }, { headers: { "X-Lazysh-Access": expect.any(String) } }));
  expect(screen.getByText(/w2:p9 · blocked/)).toBeTruthy();
});

it.each([null, undefined])('keeps nullable directory metadata readable and forbids splits without a known directory (%s)', async cwd => {
  const tree = reportedTree();
  vi.mocked(invoke).mockResolvedValue({...tree, panes:tree.panes.map(pane=>({...pane,cwd}))});
  render(<HerdrPanel sessionId="ssh-null-directory" name="selected-server" projectDirectory="/must-not-substitute" />);
  await screen.findByText(/w2:p9 · blocked/);
  for (const name of ['Split w2:p9 right','Split w2:p9 down']) {
    const split = screen.getByRole('button',{name});
    expect(split).toHaveProperty('disabled',true); fireEvent.click(split);
  }
  expect(screen.getByRole('button',{name:'Focus agent w2:p9'})).toHaveProperty('disabled',false);
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='herdr_action')).toBe(false);
  expect(screen.queryByText('/must-not-substitute')).toBeNull();
});
it('uses only the reported directory and exact selected server/pane when splitting', async () => {
  const tree=reportedTree(); const directory="/owned path/$literal";
  vi.mocked(invoke).mockResolvedValue({...tree,panes:tree.panes.map(pane=>({...pane,cwd:directory}))});
  render(<HerdrPanel sessionId="ssh-selected" name="selected-server" projectDirectory="/different" />);
  for (const [name,horizontal] of [['Split w2:p9 right',true],['Split w2:p9 down',false]] as const) {
    const button=await screen.findByRole('button',{name});
    await waitFor(()=>expect(button).toHaveProperty('disabled',false)); fireEvent.click(button);
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('herdr_action',{
      sessionId:'ssh-selected',name:'selected-server',action:{type:'splitPane',target:'w2:p9',horizontal,directory},
    },{headers:{'X-Lazysh-Access':expect.any(String)}}));
  }
});
it('explains a target closed on the host in the selected language instead of host text', async () => {
  await uiI18n.changeLanguage('pt-BR');
  vi.mocked(invoke).mockImplementation(async command => { if (command === 'herdr_action') throw { kind: 'herdr_target_missing', message: 'host text' }; return reportedTree(); });
  render(<HerdrPanel sessionId="ssh1" name="builds" />);
  await screen.findByText(/w2:p9 · blocked/);
  fireEvent.click(screen.getAllByRole('button', { name: /w2:p9/ })[0]);
  expect((await screen.findByRole('alert')).textContent).toBe('A conexão ou o destino selecionado mudou. Abra a navegação novamente.');
});
it('keeps navigation but hides mutating controls for a limited Herdr version', async () => {
  vi.mocked(invoke).mockResolvedValue(reportedTree());
  render(<HerdrPanel sessionId="ssh1" name="builds" navigationOnly />);
  await screen.findByRole('button',{name:'Focus agent w2:p9'});
  for(const name of ['New Herdr workspace','Rename Herdr workspace','New Herdr tab','Rename Herdr tab','Zoom w2:p9','Split w2:p9 right','Split w2:p9 down','Rename w2:p9','Close w2:p9','Move w2:p9 divider left','Close Herdr workspace w2'])
    expect(screen.queryByRole('button',{name})).toBeNull();
});

const sentActions = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'herdr_action').map(([, args]) => (args as { action: unknown }).action);
it('renames a pane through the exact id and shows the label the tree then reports', async () => {
  const label = "build 'x' $(touch nope) {{y}}";
  let renamed = false;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'herdr_action') renamed = true;
    const tree = reportedTree();
    return renamed ? { ...tree, panes: tree.panes.map(pane => ({ ...pane, label })) } : tree;
  });
  render(<HerdrPanel sessionId="ssh1" name="builds" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Rename w2:p9' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Pane label' }), { target: { value: label } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Herdr workspace' }));
  expect(await screen.findByText(new RegExp(`w2:p9 · blocked · focused · ${label.replace(/[$(){}]/g, '\\$&')}`))).toBeTruthy();
  expect(sentActions()).toEqual([{ type: 'renamePane', target: 'w2:p9', label }]);
});
it.each([['left', '←'], ['right', '→'], ['up', '↑'], ['down', '↓']])('moves the %s divider of one exact pane by five points per press', async (direction, glyph) => {
  vi.mocked(invoke).mockResolvedValue(reportedTree());
  render(<HerdrPanel sessionId="ssh1" name="builds" />);
  const button = await screen.findByRole('button', { name: `Move w2:p9 divider ${direction}` });
  expect(button.textContent).toBe(glyph);
  fireEvent.click(button);
  await waitFor(() => expect(sentActions()).toEqual([{ type: 'resizePane', target: 'w2:p9', direction, amount: 5 }]));
});
it.each([
  ['Close w2:p9', /Close pane w2:p9 · \/work\?/, { type: 'closePane', target: 'w2:p9' }],
  ['Close Herdr workspace w2', /Close workspace project \(w2\)\?/, { type: 'closeWorkspace', target: 'w2' }],
])('asks before %s, names the target, sends nothing on Cancel and exactly one action on confirmation', async (button, message, action) => {
  vi.mocked(invoke).mockResolvedValue(reportedTree());
  render(<HerdrPanel sessionId="ssh1" name="builds" />);
  fireEvent.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toMatch(message);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(sentActions()).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: button }));
  fireEvent.click(screen.getByRole('button', { name: 'Close it' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(sentActions()).toEqual([action]);
});
it('keeps the confirmation open and explains in the selected language that a workspace with linked worktrees cannot be closed', async () => {
  await uiI18n.changeLanguage('es');
  vi.mocked(invoke).mockImplementation(async command => { if (command === 'herdr_action') throw { kind: 'herdr_group_close_required', message: 'host text' }; return reportedTree(); });
  render(<HerdrPanel sessionId="ssh1" name="builds" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cerrar espacio de trabajo Herdr w2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Este espacio de trabajo Herdr tiene espacios de trabajo de worktree vinculados. Cierra esos primero; lazysh nunca cierra el grupo por ti.');
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(sentActions()).toHaveLength(1);
});
