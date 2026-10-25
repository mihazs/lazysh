// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import TmuxJumpPanel from './TmuxJumpPanel';
import type { TmuxJumpSnapshot } from './bridge';
import { accessSnapshot, applyAccessStatus } from './access';

vi.mock('@tauri-apps/api/core', () => ({invoke:vi.fn(),isTauri:()=>true}));
const snapshot: TmuxJumpSnapshot = { generation:'actor-one', current:{sessionId:'$1',windowId:'@3'}, sessions:[
  {id:'$1',name:'work',windows:[{id:'@3',index:0,name:'agent'}]},
  {id:'$2',name:'other',windows:[{id:'@4',index:1,name:'build'}]},
] };
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
