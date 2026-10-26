// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MuxPanel } from './MultiplexerPanel';
import { invoke } from '@tauri-apps/api/core';
import {applyAccessStatus,captureAccess} from './access';
import type {DesktopMux} from './useDesktopLaunch';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
const tree = { tmuxAvailable: true, herdrAvailable: false, zellijAvailable: false, sessions: [{ id: '$3', name: 'work', windows: [{ id: '@7', name: 'agent', index: 0, active: true, panes: [{ id: '%9', index: 0, active: true, command: 'claude', path: '/project' }] }] }] };
let generation=0;
function access(locked=false) {
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'',generation:String(++generation),...(locked?{}:{nonce:'a'.repeat(64)})});
}
beforeEach(()=>{generation+=10;access();});
function request(mux:DesktopMux) {return Object.freeze({sessionId:'ssh1',lease:captureAccess(),mux});}
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
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'selectPane', target: '%9' } }, { headers: { "X-Lazysh-Access": expect.any(String) } }));
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
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'createSession', name: 'project', directory: '/work/project' } }, { headers: { "X-Lazysh-Access": expect.any(String) } }));
});
it('discloses unsupported controls and host command failures', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ...tree, herdrAvailable: true }).mockRejectedValue({ message: 'Pane no longer exists' });
  render(<MuxPanel sessionId="ssh1" onAttach={vi.fn()} />);
  expect(await screen.findByText(/Browse a Herdr session/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Select %9' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Pane no longer exists');
});
it('carries a literal selected server through discovery, pane actions and attachment',async()=>{
  vi.mocked(invoke).mockResolvedValue(tree);const attach=vi.fn().mockResolvedValue(undefined);
  render(<MuxPanel sessionId="ssh1" onAttach={attach}/>);
  await screen.findByRole('button',{name:'Attach work'});
  const server="世界 '$(touch NO);";
  fireEvent.change(screen.getByLabelText('tmux server'),{target:{value:server}});
  fireEvent.click(screen.getByRole('button',{name:'Browse server'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('multiplexer_tree',{sessionId:'ssh1',tmuxServer:server},expect.anything()));
  fireEvent.click(await screen.findByRole('button',{name:'Select %9'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('tmux_action',{sessionId:'ssh1',tmuxServer:server,action:{type:'selectPane',target:'%9'}},expect.anything()));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Attach work'})).toHaveProperty('disabled',false));
  fireEvent.click(screen.getByRole('button',{name:'Attach work'}));
  await waitFor(()=>expect(attach).toHaveBeenCalledWith('work','tmux',server));
});
it('keeps an attached terminal on its immutable server and rejects socket paths in the picker',async()=>{
  vi.mocked(invoke).mockResolvedValue(tree);
  const view=render(<MuxPanel sessionId="ssh1" attached={{kind:'tmux',name:'work',tmuxServer:'agents'}} onAttach={vi.fn()}/>);
  expect(screen.getByLabelText('tmux server')).toHaveProperty('disabled',true);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('multiplexer_tree',{sessionId:'ssh1',tmuxServer:'agents'},expect.anything()));
  view.unmount();render(<MuxPanel sessionId="ssh2" onAttach={vi.fn()}/>);
  await screen.findByRole('button',{name:'Attach work'});
  fireEvent.change(screen.getByLabelText('tmux server'),{target:{value:'/tmp/socket'}});
  expect(screen.getByRole('button',{name:'Browse server'})).toHaveProperty('disabled',true);
});

it.each(['default',"世界 '$(touch NO);"])('keeps requested tmux server %s literal and immutable until explicit attachment',async server=>{
  vi.mocked(invoke).mockResolvedValue({...tree,herdrAvailable:true,zellijAvailable:true});
  const attach=vi.fn().mockResolvedValue(undefined);
  render(<MuxPanel sessionId="ssh1" requested={request({kind:'tmux',tmuxServer:server})} onAttach={attach}/>);
  const row=await screen.findByRole('button',{name:'Attach work'});
  expect(invoke).toHaveBeenCalledExactlyOnceWith('multiplexer_tree',{sessionId:'ssh1',...(server==='default'?{}:{tmuxServer:server})},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  expect(screen.getByLabelText('tmux server')).toHaveProperty('value',server);expect(screen.getByLabelText('tmux server')).toHaveProperty('disabled',true);
  for(const name of ['Browse server','New session','List herdr sessions','List zellij sessions','Select %9'])expect(screen.queryByRole('button',{name})).toBeNull();
  expect(attach).not.toHaveBeenCalled();fireEvent.click(row);
  await waitFor(()=>expect(attach).toHaveBeenCalledWith(...(server==='default'?['work']:['work','tmux',server])));
});
it('auto-reads only requested Herdr sessions and keeps attachment explicit',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_tree'?{...tree,herdrAvailable:true,zellijAvailable:true}:[{name:'literal 世界'}]);
  const attach=vi.fn().mockResolvedValue(undefined);
  render(<MuxPanel sessionId="ssh1" requested={request({kind:'herdr'})} onAttach={attach}/>);
  const row=await screen.findByRole('button',{name:'Attach herdr literal 世界'});
  expect(invoke).toHaveBeenLastCalledWith('multiplexer_sessions',{sessionId:'ssh1',kind:'herdr'},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  expect(screen.queryByLabelText('tmux server')).toBeNull();expect(screen.queryByLabelText('Persistent session name')).toBeNull();
  expect(screen.queryByRole('button',{name:'Attach work'})).toBeNull();expect(screen.queryByRole('button',{name:/zellij/})).toBeNull();
  expect(attach).not.toHaveBeenCalled();fireEvent.click(row);await waitFor(()=>expect(attach).toHaveBeenCalledExactlyOnceWith('literal 世界','herdr'));
});
it.each(['tmux','herdr'] as const)('discloses a missing requested %s tool without creating a session',async kind=>{
  vi.mocked(invoke).mockResolvedValue({...tree,tmuxAvailable:false,sessions:[]});const attach=vi.fn();
  render(<MuxPanel sessionId="ssh1" requested={request(kind==='tmux'?{kind,tmuxServer:'default'}:{kind})} onAttach={attach}/>);
  await screen.findByText(`${kind} is not installed on this host. The SSH terminal remains available.`);
  expect(attach).not.toHaveBeenCalled();expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['multiplexer_tree']);
});
it('reports an empty requested Herdr list and preserves raw host discovery failures',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_tree'?{...tree,herdrAvailable:true}:[]);
  render(<MuxPanel sessionId="ssh1" requested={request({kind:'herdr'})} onAttach={vi.fn()}/>);
  await screen.findByText('No running herdr sessions.');
  vi.mocked(invoke).mockRejectedValueOnce('HOST_LAUNCH_INVALID');fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','HOST_LAUNCH_INVALID');
});
it.each(['success','failure'] as const)('drops requested-picker late %s on its same old mount and cannot renew the request on remount',async outcome=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));
  const requested=request({kind:'tmux',tmuxServer:'agents'}),attach=vi.fn();
  const view=render(<MuxPanel sessionId="ssh1" requested={requested} onAttach={attach}/>);
  await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  await act(async()=>{access(true);access();if(outcome==='success')finish(tree);else fail('obsolete raw host error');});
  expect(screen.queryByRole('button',{name:'Attach work'})).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
  view.unmount();render(<MuxPanel sessionId="ssh1" requested={requested} onAttach={attach}/>);
  await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  expect(invoke).toHaveBeenCalledTimes(1);expect(attach).not.toHaveBeenCalled();
});
it('refuses a requested picker routed to a different source ID',async()=>{
  render(<MuxPanel sessionId="wrong-old-active" requested={request({kind:'herdr'})} onAttach={vi.fn()}/>);
  await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Refresh'}));expect(invoke).not.toHaveBeenCalled();
});
