// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import TmuxJumpPanel from './TmuxJumpPanel';
import type { TmuxJumpSnapshot } from './bridge';
import { accessSnapshot, applyAccessStatus } from './access';
import {tmuxJumpSnapshot as snapshot} from './test/tmuxJumpData';

vi.mock('@tauri-apps/api/core', () => ({invoke:vi.fn(),isTauri:()=>true}));
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
function access(locked: boolean) {
  const generation = String(BigInt(accessSnapshot().status?.generation ?? '0') + 1n);
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'',generation,...(!locked ? {nonce:'a'.repeat(64)} : {})});
}
for (const stage of ['snapshot', 'jump'] as const) {
  it.each(['success', 'error'] as const)(`ignores same-mounted ${stage} late %s across lock and unlock`, async outcome => {
    access(false);
    let finish!: () => void;
    const deferred = () => new Promise((resolve,reject) => { finish = () => outcome === 'success' ? resolve(snapshot) : reject(new Error('Late native failure')); });
    if (stage === 'jump') vi.mocked(invoke).mockResolvedValueOnce(snapshot).mockImplementationOnce(deferred);
    else vi.mocked(invoke).mockImplementationOnce(deferred);
    const close=vi.fn(), jumped=vi.fn();
    const {container}=render(<TmuxJumpPanel sessionId="display" onClose={close} onJump={jumped}/>);
    if (stage === 'jump') fireEvent.click(await screen.findByRole('button',{name:'1: build'}));
    const before = container.innerHTML;
    await act(async () => { access(true); access(false); });
    await act(async () => finish());
    expect(container.innerHTML).toBe(before);
    expect(close).not.toHaveBeenCalled();expect(jumped).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(stage === 'jump' ? 2 : 1);
  });
}
it('rejects same-mounted stale clicks including Current and layout persistence after unlock', async () => {
  access(false);vi.mocked(invoke).mockResolvedValue(snapshot);
  const close=vi.fn(),jumped=vi.fn();
  const {container}=render(<TmuxJumpPanel sessionId="display" onClose={close} onJump={jumped}/>);
  const current=await screen.findByRole('button',{name:'0: agent · Current'});
  const before=container.innerHTML, saved=localStorage.getItem('lazysh.multiplexer.layout');
  await act(async()=>{access(true);access(false);});
  fireEvent.click(current);
  fireEvent.click(screen.getByRole('button',{name:'1: build'}));
  fireEvent.change(screen.getByLabelText('Jump To layout'),{target:{value:'grid'}});
  await act(async()=>{});
  expect(container.innerHTML).toBe(before);
  expect(localStorage.getItem('lazysh.multiplexer.layout')).toBe(saved);
  expect(close).not.toHaveBeenCalled();expect(jumped).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledOnce();
});
it('marks only the exact displayed window Current and closes it without native mutation', async () => {
  vi.mocked(invoke).mockResolvedValue(snapshot);
  const close=vi.fn(), jumped=vi.fn();
  render(<TmuxJumpPanel sessionId="display" onClose={close} onJump={jumped}/>);
  const current=await screen.findByRole('button',{name:'0: agent · Current'});
  expect(current.getAttribute('aria-current')).toBe('location');
  expect(screen.getByRole('button',{name:'1: build'}).hasAttribute('aria-current')).toBe(false);
  fireEvent.click(current);
  expect(close).toHaveBeenCalledOnce();expect(jumped).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('sends the native actor generation and exact IDs, accepting only the returned snapshot', async () => {
  const result={...snapshot,current:{sessionId:'$2',windowId:'@4'}};
  vi.mocked(invoke).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(result);
  const close=vi.fn(),jumped=vi.fn();
  render(<TmuxJumpPanel sessionId="display" onClose={close} onJump={jumped}/>);
  fireEvent.click(await screen.findByRole('button',{name:'1: build'}));
  await act(async()=>{});
  expect(invoke).toHaveBeenLastCalledWith('tmux_jump',{sessionId:'display',generation:'actor-one',targetSessionId:'$2',windowId:'@4'},expect.anything());
  expect(jumped).toHaveBeenCalledWith(result);expect(close).toHaveBeenCalledOnce();
});
it('drops a previous display snapshot after switching sessions', async () => {
  let finish!:(value:TmuxJumpSnapshot)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({...snapshot,sessions:[]});
  const view=render(<TmuxJumpPanel sessionId="old" onClose={vi.fn()} onJump={vi.fn()}/>);
  view.rerender(<TmuxJumpPanel sessionId="new" onClose={vi.fn()} onJump={vi.fn()}/>);
  await act(async()=>finish(snapshot));
  expect(screen.queryByRole('button',{name:'1: build'})).toBeNull();
});
it('drops late navigation results from an unmounted view', async () => {
  let finish!:(value:TmuxJumpSnapshot)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(snapshot).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const close=vi.fn(), jumped=vi.fn();
  const view=render(<TmuxJumpPanel sessionId="old" onClose={close} onJump={jumped}/>);
  fireEvent.click(await screen.findByRole('button',{name:'1: build'}));
  view.unmount();await act(async()=>finish(snapshot));
  expect(close).not.toHaveBeenCalled();expect(jumped).not.toHaveBeenCalled();
});
it('discards targets after a failed binding and discloses unavailable navigation', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(snapshot).mockRejectedValueOnce({message:'Control connection closed'});
  render(<TmuxJumpPanel sessionId="display" onClose={vi.fn()} onJump={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'1: build'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Jump To unavailable: Control connection closed');
  expect(screen.queryByRole('button',{name:'0: agent · Current'})).toBeNull();
});
it('shares the three-layout preference and treats host labels as text', async () => {
  localStorage.setItem('lazysh.multiplexer.layout','grid');
  vi.mocked(invoke).mockResolvedValue({...snapshot,sessions:[{...snapshot.sessions[0],name:'<img src=x onerror=alert(1)>'}]});
  const {container}=render(<TmuxJumpPanel sessionId="display" onClose={vi.fn()} onJump={vi.fn()}/>);
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByLabelText('Jump To layout')).toHaveProperty('value','grid');
  fireEvent.change(screen.getByLabelText('Jump To layout'),{target:{value:'accordion'}});
  expect(localStorage.getItem('lazysh.multiplexer.layout')).toBe('accordion');
});
it('keeps a persistent picker on the returned generation for the next exact jump',async()=>{
  access(false);
  const second={...snapshot,generation:'actor-two',current:{sessionId:'$2',windowId:'@4'}};
  const third={...snapshot,generation:'actor-three'};
  vi.mocked(invoke).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(second).mockResolvedValueOnce(third);
  const busy=vi.fn();render(<TmuxJumpPanel sessionId="persistent-display" onClose={()=>{}} onJump={vi.fn()} onBusyChange={busy}/>);
  fireEvent.click(await screen.findByRole('button',{name:'1: build'}));
  await screen.findByRole('button',{name:'1: build · Current'});
  fireEvent.click(screen.getByRole('button',{name:'0: agent'}));
  await screen.findByRole('button',{name:'0: agent · Current'});
  expect(invoke).toHaveBeenNthCalledWith(3,'tmux_jump',{sessionId:'persistent-display',generation:'actor-two',targetSessionId:'$1',windowId:'@3'},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  expect(busy.mock.calls.map(([value])=>value)).toEqual([true,false,true,false,true,false]);
});
it('retries a retired picker only through an explicit fresh snapshot read',async()=>{
  access(false);
  vi.mocked(invoke).mockResolvedValueOnce(snapshot).mockRejectedValueOnce('retired binding').mockResolvedValueOnce({...snapshot,generation:'fresh-actor'});
  render(<TmuxJumpPanel sessionId="retry-display" onClose={()=>{}} onJump={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'1: build'}));await screen.findByRole('alert');
  expect(screen.queryByRole('button',{name:'0: agent · Current'})).toBeNull();expect(invoke).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await screen.findByRole('button',{name:'0: agent · Current'});
  expect(invoke).toHaveBeenLastCalledWith('tmux_jump_snapshot',{sessionId:'retry-display'},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
});

const zellijTree={tabs:[
  {id:4,position:0,name:'shell',active:true,panes:[{id:8,title:'sh',focused:true}]},
  {id:9,position:1,name:'<b>logs</b>',active:false,panes:[{id:18,title:'sh',focused:true}]},
]};
it('lists the tabs of a Zellij session with exactly one current row and treats their names as text',async()=>{
  access(false);
  vi.mocked(invoke).mockResolvedValue(zellijTree);
  const {container}=render(<TmuxJumpPanel sessionId="display" zellij="work" onClose={vi.fn()}/>);
  expect(screen.getByRole('status').textContent).toBe('Reading Zellij tabs…');
  const current=await screen.findByRole('button',{name:'1: shell · Current'});
  expect(current.getAttribute('aria-current')).toBe('location');
  expect(container.querySelectorAll('[aria-current]')).toHaveLength(1);
  expect(await screen.findByRole('button',{name:'2: <b>logs</b>'})).toBeTruthy();
  expect(container.querySelector('b')).toBeNull();
  expect(screen.getByRole('region',{name:'Zellij Jump To'})).toBeTruthy();
  expect(screen.getByText('Jumping changes the current tab of this Zellij session.')).toBeTruthy();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('zellij_tree',{sessionId:'display',name:'work'},expect.anything());
});
it('jumps to a Zellij tab by its id and moves the current row without another read',async()=>{
  access(false);
  vi.mocked(invoke).mockResolvedValueOnce(zellijTree).mockResolvedValueOnce(undefined);
  const close=vi.fn(),jumped=vi.fn();
  const {container}=render(<TmuxJumpPanel sessionId="display" zellij="work" onClose={close} onJump={jumped}/>);
  fireEvent.click(await screen.findByRole('button',{name:'2: <b>logs</b>'}));
  await screen.findByRole('button',{name:'2: <b>logs</b> · Current'});
  expect(invoke).toHaveBeenLastCalledWith('zellij_action',{sessionId:'display',name:'work',action:{type:'jump',tabId:9}},expect.anything());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll('[aria-current]')).toHaveLength(1);
  expect(close).toHaveBeenCalledOnce();
  expect(jumped).toHaveBeenCalledOnce();
});
it('closes without a Zellij action when the current tab is chosen, and discloses a failed jump',async()=>{
  access(false);
  vi.mocked(invoke).mockResolvedValueOnce(zellijTree).mockRejectedValueOnce({message:'Tab 9 is gone'});
  const close=vi.fn();
  render(<TmuxJumpPanel sessionId="display" zellij="work" onClose={close}/>);
  fireEvent.click(await screen.findByRole('button',{name:'1: shell · Current'}));
  expect(close).toHaveBeenCalledOnce();expect(invoke).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'2: <b>logs</b>'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Jump To unavailable: Tab 9 is gone');
  expect(screen.queryByRole('button',{name:'1: shell · Current'})).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});
