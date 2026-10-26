// @vitest-environment jsdom
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {cleanupNativeMocks} from './test/nativeCoreMock';
import {accessSnapshot, applyAccessStatus} from './access';
import KeepAwakeControl, {boardAwakeKey, parseKeepAwakeStatus} from './KeepAwakeControl';
vi.mock('@tauri-apps/api/core', async original=>({...await (await import('./test/nativeCoreMock')).mockNativeCore(original),isTauri:vi.fn()}));
function authority(locked=false,enabled=true) {
  applyAccessStatus({initialized:true,supported:true,enabled,locked,reason:'fixture',
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'b'.repeat(64)})});
}
beforeEach(()=>{
  authority();vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(document,'hasFocus').mockReturnValue(true);
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
});
afterEach(()=>{cleanupNativeMocks();vi.restoreAllMocks();vi.resetAllMocks();localStorage.clear();});
type Owner={epoch:string;ticket:number};
function backend(available=true) {
  let issued=0,closed=0,active:Owner|undefined;
  let epoch='0/11111111-1111-4111-8111-111111111111';
  const status=(ticket:number)=>({available,reason:'RAW native capability <untouched>',active:!!active,epoch,ticket});
  const acquire=(owner:Owner)=>{
    if(owner.epoch!==epoch || owner.ticket<=closed)throw new Error('Display ownership has expired.');
    closed=owner.ticket;active=owner;return status(owner.ticket);
  };
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    const request=(args as {request:Owner}|undefined)?.request;
    if(command==='board_keep_awake_status')return status(++issued) as never;
    if(command==='board_keep_awake_acquire')return acquire(request!) as never;
    if(command==='board_keep_awake_release') {
      if(request!.epoch===epoch){closed=Math.max(closed,request!.ticket);if(active?.ticket===request!.ticket)active=undefined;}
      return status(request!.ticket) as never;
    }
    throw new Error(`Unexpected native fixture call: ${command}`);
  });
  return {status,acquire,active:()=>active,invalidate(){active=undefined;issued=closed=0;epoch='1/22222222-2222-4222-8222-222222222222';}};
}
const toggle=()=>screen.getByRole('checkbox',{name:'Keep display awake while this board is open'});
async function optIn(){await waitFor(()=>expect(toggle()).toHaveProperty('disabled',false));fireEvent.click(toggle());}
it('defaults off, strictly parses the opt-in, and never acquires from metadata alone',async()=>{
  backend();localStorage.setItem(boardAwakeKey,'"true"');render(<KeepAwakeControl sessionId="a"/>);
  await waitFor(()=>expect(toggle()).toHaveProperty('disabled',false));
  expect(toggle()).toHaveProperty('checked',false);
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['board_keep_awake_status']);
  for(const value of [null,{},{available:true,active:false,reason:'x',epoch:'raw',ticket:1},{available:true,active:false,reason:'x',epoch:'0/11111111-1111-4111-8111-111111111111',ticket:1.5}])
    expect(()=>parseKeepAwakeStatus(value)).toThrow('Native display status is unavailable.');
});
it('acquires only on opt-in and releases the exact ticket on disabling',async()=>{
  const native=backend();render(<KeepAwakeControl sessionId="a"/>);await optIn();
  expect(await screen.findByText('Native display keep-awake is active.')).toBeTruthy();
  const owner=native.active();expect(owner).toBeTruthy();expect(localStorage.getItem(boardAwakeKey)).toBe('true');
  fireEvent.click(toggle());await waitFor(()=>expect(native.active()).toBeUndefined());
  expect(invoke).toHaveBeenCalledWith('board_keep_awake_release',{request:owner});
  expect(await screen.findByText('Keep awake is off.')).toBeTruthy();
});
for(const action of ['background','blur','unmount'] as const) {
  it(`releases native ownership on ${action} without changing agent or network lifetimes`,async()=>{
    const native=backend();localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="a"/>);
    await screen.findByText('Native display keep-awake is active.');const owner=native.active();
    if(action==='unmount')view.unmount();
    else if(action==='blur')fireEvent(window,new Event('blur'));
    else {vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');fireEvent(document,new Event('visibilitychange'));}
    await waitFor(()=>expect(native.active()).toBeUndefined());
    expect(invoke).toHaveBeenCalledWith('board_keep_awake_release',{request:owner});
    expect(vi.mocked(invoke).mock.calls.every(([name])=>name.startsWith('board_keep_awake_'))).toBe(true);
  });
}
it('changes board session ownership without letting old cleanup release the newer owner',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('Native display keep-awake is active.');const first=native.active();view.rerender(<KeepAwakeControl sessionId="b"/>);
  await waitFor(()=>expect(native.active()?.ticket).toBeGreaterThan(first!.ticket));
  expect(invoke).toHaveBeenCalledWith('board_keep_awake_release',{request:first});
});
it('never acquires when an old status response arrives after leaving the board',async()=>{
  const native=backend();let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}) as never);
  localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="a"/>);view.unmount();
  await act(async()=>finish(native.status(1)));
  expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='board_keep_awake_acquire')).toBe(false);
});
it('fences a delayed native acquire with release when disabled before confirmation',async()=>{
  const native=backend();const original=vi.mocked(invoke).getMockImplementation()!;let finish!:()=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='board_keep_awake_acquire')return new Promise((resolve,reject)=>{finish=()=>{
      try{resolve(native.acquire((args as {request:Owner}).request));}catch(error){reject(error);}
    };}) as never;
    return original(command,args,options);
  });
  render(<KeepAwakeControl sessionId="a"/>);await optIn();await waitFor(()=>expect(finish).toBeTypeOf('function'));
  fireEvent.click(toggle());await waitFor(()=>expect(invoke).toHaveBeenCalledWith('board_keep_awake_release',{request:expect.anything()}));
  await act(async()=>finish());expect(native.active()).toBeUndefined();
  expect(screen.queryByText('Native display keep-awake is active.')).toBeNull();
});
it('releases after access revocation and never refreshes the original mounted authority on unlock',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('Native display keep-awake is active.');
  await act(async()=>authority(true));await waitFor(()=>expect(native.active()).toBeUndefined());
  const calls=vi.mocked(invoke).mock.calls.length;await act(async()=>authority(false));
  expect(invoke).toHaveBeenCalledTimes(calls);
  expect(screen.queryByText('Native display keep-awake is active.')).toBeNull();
  expect(toggle()).toHaveProperty('disabled',true);
  for(const [command,,options] of vi.mocked(invoke).mock.calls)if(command!=='board_keep_awake_release')
    expect(options).toEqual({headers:{'X-Lazysh-Access':'b'.repeat(64)}});
});
it('reports unavailable native capability verbatim and cannot opt in on that backend',async()=>{
  backend(false);render(<KeepAwakeControl sessionId="a"/>);
  expect(await screen.findByText('RAW native capability <untouched>')).toBeTruthy();
  expect(toggle()).toHaveProperty('disabled',true);expect(document.querySelector('untouched')).toBeNull();
});
for(const operation of ['acquire','release'] as const)it(`does not claim success after native ${operation} failure`,async()=>{
  backend();const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command===`board_keep_awake_${operation}`?Promise.reject(new Error(`Native ${operation} failed`)):original(command,args,options));
  render(<KeepAwakeControl sessionId="a"/>);await optIn();
  if(operation==='release'){await screen.findByText('Native display keep-awake is active.');fireEvent.click(toggle());}
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',`Native ${operation} failed`);
  expect(screen.queryByText(operation==='acquire'?'Native display keep-awake is active.':'Keep awake is off.')).toBeNull();
});
it('browser mode is explicit and makes no native request',()=>{
  vi.mocked(isTauri).mockReturnValue(false);render(<KeepAwakeControl sessionId="a"/>);
  expect(toggle()).toHaveProperty('disabled',true);expect(screen.getByText('Keep awake requires the native app.')).toBeTruthy();expect(invoke).not.toHaveBeenCalled();
});

it('reacquires a fresh native ticket after a batched background/foreground cycle with app lock off',async()=>{
  authority(false,false);const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('Native display keep-awake is active.');const first=native.active();
  await act(async()=>{native.invalidate();fireEvent(window,new Event('blur'));fireEvent(window,new Event('focus'));});
  await waitFor(()=>expect(native.active()).toBeTruthy());
  expect(native.active()?.epoch).not.toBe(first!.epoch);
  expect(screen.getByText('Native display keep-awake is active.')).toBeTruthy();
});
it('reports an off preference with retained native ownership truthfully instead of paused or off',async()=>{
  const native=backend();vi.mocked(invoke).mockImplementationOnce(async()=>({...native.status(1),active:true}) as never);
  render(<KeepAwakeControl sessionId="a"/>);
  await waitFor(()=>expect(toggle()).toHaveProperty('disabled',false));
  expect(toggle()).toHaveProperty('checked',false);
  expect(screen.getByRole('status').textContent).toContain('still reported active');
  expect(screen.getByText(/Switch away from the app to retry release, or restart lazysh/)).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='board_keep_awake_acquire')).toBe(false);
});
it('keeps a visible cleanup failure when a concurrent old status reply arrives after it',async()=>{
  const native=backend();const original=vi.mocked(invoke).getMockImplementation()!;
  let holdStatus=false,finishStatus!:()=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='board_keep_awake_release')return Promise.reject(new Error('Native release failed'));
    if(command==='board_keep_awake_status' && holdStatus)return new Promise(resolve=>{finishStatus=()=>resolve({...native.status(3),active:false});}) as never;
    return original(command,args,options);
  });
  render(<KeepAwakeControl sessionId="a"/>);await optIn();await screen.findByText('Native display keep-awake is active.');
  holdStatus=true;fireEvent.click(toggle());await screen.findByText('Native release failed');
  await act(async()=>finishStatus());
  expect(screen.getByRole('alert').textContent).toContain('Native release failed');
  expect(screen.queryByText('Keep awake is off.')).toBeNull();
  expect(screen.queryByText('Keep awake is paused until this board is visible and focused.')).toBeNull();
});
for(const outcome of ['rejected','still-active','malformed'] as const)it(`reports ${outcome} release on blur while the preference remains enabled`,async()=>{
  const native=backend();const original=vi.mocked(invoke).getMockImplementation()!;
  const failure=outcome==='rejected'?'Blur release failed':outcome==='still-active'?'Native display release is still pending.':'Native display status is unavailable.';
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='board_keep_awake_release'?
    outcome==='rejected'?Promise.reject(new Error(failure)):Promise.resolve(outcome==='still-active'?{...native.status(2),active:true}:null) as never:original(command,args,options));
  localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('Native display keep-awake is active.');fireEvent(window,new Event('blur'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',failure);
  expect(toggle()).toHaveProperty('checked',true);
  expect(screen.getByRole('status').textContent).toContain('could not be confirmed');
  expect(screen.getByText(/Switch away from the app to retry release, or restart lazysh/)).toBeTruthy();
});
it('disables and releases even when saving the off preference fails',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('Native display keep-awake is active.');const owner=native.active();
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Storage unavailable');});
  fireEvent.click(toggle());
  await waitFor(()=>expect(native.active()).toBeUndefined());
  expect(toggle()).toHaveProperty('checked',false);
  expect(invoke).toHaveBeenCalledWith('board_keep_awake_release',{request:owner});
  expect(screen.getByRole('alert').textContent).toContain('could not be saved');
});
it('does not attribute an old release acknowledgement to a newer active owner',async()=>{
  const native=backend();const original=vi.mocked(invoke).getMockImplementation()!;let finish!:()=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='board_keep_awake_release')return original(command,args,options).then(()=>new Promise(resolve=>{finish=()=>resolve({...native.status((args as {request:Owner}).request.ticket),active:true});})) as never;
    return original(command,args,options);
  });
  localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('Native display keep-awake is active.');const first=native.active();view.rerender(<KeepAwakeControl sessionId="b"/>);
  await waitFor(()=>expect(native.active()?.ticket).toBeGreaterThan(first!.ticket));
  await act(async()=>finish());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Native display keep-awake is active.')).toBeTruthy();
});
