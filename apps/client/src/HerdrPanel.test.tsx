// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import HerdrPanel from './HerdrPanel';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
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
