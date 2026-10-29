// @vitest-environment jsdom
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {cleanupNativeMocks} from './test/nativeCoreMock';
import {uiI18n,t} from './i18n/core';
import {accessSnapshot, applyAccessStatus} from './access';
import KeepAwakeControl, {boardAwakeKey, parseKeepAwakeStatus} from './KeepAwakeControl';
vi.mock('@tauri-apps/api/core', async original=>({...await (await import('./test/nativeCoreMock')).mockNativeCore(original),isTauri:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn()}));
let nativeLoss:(payload:unknown)=>void;
let nativeFocus:()=>void=()=>{};
function authority(locked=false,enabled=true) {
  applyAccessStatus({initialized:true,supported:true,enabled,locked,reason:'fixture',
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'b'.repeat(64)})});
}
beforeEach(()=>{
  authority();vi.mocked(isTauri).mockReturnValue(true);nativeFocus=()=>{};
  vi.mocked(listen).mockImplementation(async(name,handler)=>{
    if(name==='lazysh-board-keep-awake-lost')nativeLoss=payload=>handler({payload} as never);
    if(name==='tauri://focus')nativeFocus=()=>handler({payload:null} as never);
    return()=>{};
  });
  vi.spyOn(document,'hasFocus').mockReturnValue(true);
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
});
afterEach(async()=>{cleanupNativeMocks();await uiI18n.changeLanguage('en');vi.restoreAllMocks();vi.resetAllMocks();localStorage.clear();});
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
  return {status,acquire,active:()=>active,availability(value:boolean){available=value;},invalidate(){active=undefined;issued=closed=0;epoch='1/22222222-2222-4222-8222-222222222222';}};
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
  expect(await screen.findByText('This board owns an acknowledged idle-inhibition request.')).toBeTruthy();
  const owner=native.active();expect(owner).toBeTruthy();expect(localStorage.getItem(boardAwakeKey)).toBe('true');
  fireEvent.click(toggle());await waitFor(()=>expect(native.active()).toBeUndefined());
  expect(invoke).toHaveBeenCalledWith('board_keep_awake_release',{request:owner});
  expect(await screen.findByText('Keep awake is off.')).toBeTruthy();
});
for(const action of ['background','blur','unmount'] as const) {
  it(`releases native ownership on ${action} without changing agent or network lifetimes`,async()=>{
    const native=backend();localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="a"/>);
    await screen.findByText('This board owns an acknowledged idle-inhibition request.');const owner=native.active();
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
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');const first=native.active();view.rerender(<KeepAwakeControl sessionId="b"/>);
  await waitFor(()=>expect(native.active()?.ticket).toBeGreaterThan(first!.ticket));
  expect(invoke).toHaveBeenCalledWith('board_keep_awake_release',{request:first});
});
it('never acquires when an old status response arrives after leaving the board',async()=>{
  const native=backend();let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}) as never);
  localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="a"/>);
  await waitFor(()=>expect(finish).toBeTypeOf('function'));view.unmount();
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
  expect(screen.queryByText('This board owns an acknowledged idle-inhibition request.')).toBeNull();
});
it('releases after access revocation and never refreshes the original mounted authority on unlock',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');
  await act(async()=>authority(true));await waitFor(()=>expect(native.active()).toBeUndefined());
  const calls=vi.mocked(invoke).mock.calls.length;await act(async()=>authority(false));
  expect(invoke).toHaveBeenCalledTimes(calls);
  expect(screen.queryByText('This board owns an acknowledged idle-inhibition request.')).toBeNull();
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
  if(operation==='release'){await screen.findByText('This board owns an acknowledged idle-inhibition request.');fireEvent.click(toggle());}
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',`Native ${operation} failed`);
  expect(screen.queryByText(operation==='acquire'?'This board owns an acknowledged idle-inhibition request.':'Keep awake is off.')).toBeNull();
});
it('browser mode is explicit and makes no native request',()=>{
  vi.mocked(isTauri).mockReturnValue(false);render(<KeepAwakeControl sessionId="a"/>);
  expect(toggle()).toHaveProperty('disabled',true);expect(screen.getByText('Keep awake requires the native app.')).toBeTruthy();expect(invoke).not.toHaveBeenCalled();
});

it('reacquires a fresh native ticket after a batched background/foreground cycle with app lock off',async()=>{
  authority(false,false);const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');const first=native.active();
  await act(async()=>{native.invalidate();fireEvent(window,new Event('blur'));fireEvent(window,new Event('focus'));});
  await waitFor(()=>expect(native.active()).toBeTruthy());
  expect(native.active()?.epoch).not.toBe(first!.epoch);
  expect(screen.getByText('This board owns an acknowledged idle-inhibition request.')).toBeTruthy();
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
  render(<KeepAwakeControl sessionId="a"/>);await optIn();await screen.findByText('This board owns an acknowledged idle-inhibition request.');
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
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');fireEvent(window,new Event('blur'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',failure);
  expect(toggle()).toHaveProperty('checked',true);
  expect(screen.getByRole('status').textContent).toContain('could not be confirmed');
  expect(screen.getByText(/Switch away from the app to retry release, or restart lazysh/)).toBeTruthy();
});
it('disables and releases even when saving the off preference fails',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');const owner=native.active();
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
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');const first=native.active();view.rerender(<KeepAwakeControl sessionId="b"/>);
  await waitFor(()=>expect(native.active()?.ticket).toBeGreaterThan(first!.ticket));
  await act(async()=>finish());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('This board owns an acknowledged idle-inhibition request.')).toBeTruthy();
});
it('clears acknowledged ownership on exact native loss without retrying while focused',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');const owner=native.active()!;
  const acquired=vi.mocked(invoke).mock.calls.filter(([name])=>name==='board_keep_awake_acquire').length;
  await act(async()=>nativeLoss({...native.status(owner.ticket),epoch:owner.epoch,active:false,reason:'Portal connection closed.'}));
  expect(screen.queryByText('This board owns an acknowledged idle-inhibition request.')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Portal connection closed.');
  await act(async()=>{fireEvent(window,new Event('blur'));fireEvent(window,new Event('focus'));});
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='board_keep_awake_acquire')).toHaveLength(acquired);
  expect(screen.getByText('Turn this off and on to request ownership again.')).toBeTruthy();
  fireEvent.click(toggle());await screen.findByText('Keep awake is off.');await optIn();
  expect(await screen.findByText('This board owns an acknowledged idle-inhibition request.')).toBeTruthy();
});
it('a matching loss before the acquire reply cannot be overwritten by late success',async()=>{
  const native=backend();const original=vi.mocked(invoke).getMockImplementation()!;let finish!:()=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='board_keep_awake_acquire')return new Promise(resolve=>{const owner=(args as {request:Owner}).request;native.acquire(owner);finish=()=>resolve({...native.status(owner.ticket),active:true});}) as never;
    return original(command,args,options);
  });
  render(<KeepAwakeControl sessionId="a"/>);await optIn();await waitFor(()=>expect(finish).toBeTypeOf('function'));
  await act(async()=>nativeLoss({...native.status(native.active()!.ticket),active:false,reason:'Owner disappeared before delivery.'}));
  await act(async()=>finish());
  expect(screen.queryByText('This board owns an acknowledged idle-inhibition request.')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Owner disappeared before delivery.');
});
it('ignores loss from an older document or ticket and discards callbacks after revocation',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');const owner=native.active()!;
  await act(async()=>{
    nativeLoss({...native.status(owner.ticket+1),active:false,reason:'Wrong ticket'});
    nativeLoss({...native.status(owner.ticket),epoch:`99/${owner.epoch.split('/')[1]}`,active:false,reason:'Wrong document'});
  });
  expect(screen.getByText('This board owns an acknowledged idle-inhibition request.')).toBeTruthy();
  await act(async()=>authority(true));
  await act(async()=>nativeLoss({...native.status(owner.ticket),epoch:owner.epoch,active:false,reason:'Old mount event'}));
  expect(screen.queryByText('Old mount event')).toBeNull();
});
for(const outcome of ['rejected','malformed','inactive'] as const)it(`requires explicit opt-in after a fresh ${outcome} acquisition failure`,async()=>{
  const native=backend();const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='board_keep_awake_acquire')return outcome==='rejected'?Promise.reject(new Error('Portal denied this request')):Promise.resolve(outcome==='malformed'?null:{...native.status((args as {request:Owner}).request.ticket),active:false}) as never;
    return original(command,args,options);
  });
  render(<KeepAwakeControl sessionId="a"/>);await optIn();await screen.findByRole('alert');
  const calls=()=>vi.mocked(invoke).mock.calls.filter(([name])=>name==='board_keep_awake_acquire').length;
  expect(calls()).toBe(1);
  await act(async()=>{fireEvent(window,new Event('blur'));fireEvent(window,new Event('focus'));nativeFocus();});
  expect(calls()).toBe(1);
  fireEvent.click(toggle());await screen.findByText('Keep awake is off.');await optIn();await screen.findByRole('alert');
  expect(calls()).toBe(2);
});
it('read-only metadata failure does not block a later foreground metadata refresh',async()=>{
  backend();vi.mocked(invoke).mockImplementationOnce(()=>Promise.reject(new Error('Metadata unavailable')));
  localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);await screen.findByRole('alert');
  await act(async()=>{fireEvent(window,new Event('blur'));fireEvent(window,new Event('focus'));});
  expect(await screen.findByText('This board owns an acknowledged idle-inhibition request.')).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='board_keep_awake_status')).toHaveLength(2);
});

it('renders locale changes during a held acquire without releasing, reacquiring or replacing the checkbox',async()=>{
  const native=backend(),original=vi.mocked(invoke).getMockImplementation()!;
  let finish!:()=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='board_keep_awake_acquire'?
    new Promise(resolve=>{finish=()=>resolve(native.acquire((args as {request:Owner}).request));}) as never:original(command,args,options));
  render(<KeepAwakeControl sessionId="locale-owner"/>);await optIn();
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  const checkbox=toggle(),calls=vi.mocked(invoke).mock.calls.length,listeners=vi.mocked(listen).mock.calls.length;
  for(const locale of ['pt-BR','es','en']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('checkbox',{name:t('keepAwakeLabel')})).toBe(checkbox);
    expect(screen.getByRole('status').textContent).toBe(t('keepAwakeChecking'));
    expect(invoke).toHaveBeenCalledTimes(calls);expect(listen).toHaveBeenCalledTimes(listeners);
  }
  await act(async()=>finish());
  expect(screen.getByRole('status').textContent).toBe(t('keepAwakeActive'));
  const owner=native.active()!;
  await act(async()=>{nativeLoss({...native.status(owner.ticket),active:false,reason:'Native display status is unavailable.'});});
  const afterLoss=vi.mocked(invoke).mock.calls.length;
  await act(async()=>{await uiI18n.changeLanguage('es');});
  expect(screen.getByRole('alert').textContent).toBe('Native display status is unavailable.');
  expect(screen.getByText(t('keepAwakeOptIn'))).toBeTruthy();
  expect(invoke).toHaveBeenCalledTimes(afterLoss);
});
it('keeps the same retained cleanup cause through language changes and clears it only on acknowledged release',async()=>{
  const native=backend(),original=vi.mocked(invoke).getMockImplementation()!;
  let releases=0;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='board_keep_awake_acquire')return Promise.resolve({...native.status((args as {request:Owner}).request.ticket),active:false}) as never;
    if(command==='board_keep_awake_release' && ++releases===1)return Promise.resolve({...native.status(1),active:true}) as never;
    return original(command,args,options);
  });
  render(<KeepAwakeControl sessionId="cleanup-locale"/>);await optIn();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Native display release is still pending.');
  const calls=vi.mocked(invoke).mock.calls.length;
  for(const locale of ['pt-BR','es']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('alert').textContent).toBe(t('keepAwakeReleasePending'));
    expect(invoke).toHaveBeenCalledTimes(calls);
  }
  fireEvent.click(screen.getByRole('checkbox',{name:t('keepAwakeLabel')}));
  await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
  expect(releases).toBe(2);
});
it.each(['', 'Native display status is unavailable.', 'RAW native <reason> {{name}}'])('leaves native capability reason %j literal in every locale',async(reason)=>{
  const native=backend(false);vi.mocked(invoke).mockResolvedValue({...native.status(1),reason} as never);
  render(<KeepAwakeControl sessionId="raw-reason"/>);
  await waitFor(()=>expect(invoke).toHaveBeenCalled());
  for(const locale of ['pt-BR','es']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('status').textContent).toBe(reason);
  }
});
it('keeps a preference failure live across locale changes after releasing the original owner',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="save-locale"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage');});
  fireEvent.click(toggle());await waitFor(()=>expect(native.active()).toBeUndefined());
  const calls=vi.mocked(invoke).mock.calls.length;
  for(const locale of ['pt-BR','es']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('alert').textContent).toBe(t('keepAwakeSaveFailed'));
    expect(invoke).toHaveBeenCalledTimes(calls);
  }
});

it('refreshes unavailable resume metadata on native main-window focus without a second DOM focus event',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');
  native.invalidate();native.availability(false);
  await act(async()=>{fireEvent(window,new Event('blur'));fireEvent(window,new Event('focus'));});
  await screen.findByText('RAW native capability <untouched>');
  const acquisitions=()=>vi.mocked(invoke).mock.calls.filter(([command])=>command==='board_keep_awake_acquire').length;
  expect(acquisitions()).toBe(1);
  native.availability(true);
  await act(async()=>nativeFocus());
  await waitFor(()=>expect(native.active()).toBeTruthy());
  expect(acquisitions()).toBe(2);
});

it.each(['hidden','unmount','revoked'] as const)('cannot reacquire from a retained native focus callback after %s',async boundary=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="a"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');
  const originalFocus=nativeFocus;
  await act(async()=>{
    if(boundary==='hidden'){vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');fireEvent(document,new Event('visibilitychange'));}
    else if(boundary==='unmount')view.unmount();
    else authority(true);
  });
  await waitFor(()=>expect(native.active()).toBeUndefined());
  const calls=[...vi.mocked(invoke).mock.calls];
  await act(async()=>originalFocus());
  expect(vi.mocked(invoke).mock.calls).toEqual(calls);
});
it('retires a late native-focus subscription after unmount without refreshing metadata',async()=>{
  backend();const remove=vi.fn();let finish!:(remove:()=>void)=>void;let focus!:()=>void;
  vi.mocked(listen).mockImplementationOnce(async(_name,handler)=>{
    focus=()=>handler({payload:null} as never);
    return new Promise<()=>void>(resolve=>{finish=resolve;});
  });
  const view=render(<KeepAwakeControl sessionId="a"/>);
  await waitFor(()=>expect(toggle()).toHaveProperty('disabled',false));
  view.unmount();const calls=[...vi.mocked(invoke).mock.calls];
  await act(async()=>{finish(remove);focus();});
  expect(remove).toHaveBeenCalledOnce();expect(vi.mocked(invoke).mock.calls).toEqual(calls);
});

it('keeps an initially hidden board idle and releases its owned ticket on sidebar hide',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="nav-board" visible={false}/>);
  await act(async()=>{});expect(invoke).not.toHaveBeenCalled();expect(listen).not.toHaveBeenCalled();view.rerender(<KeepAwakeControl sessionId="nav-board"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');const owner=native.active();
  view.rerender(<KeepAwakeControl sessionId="nav-board" visible={false}/>);await waitFor(()=>expect(native.active()).toBeUndefined());
  expect(invoke).toHaveBeenCalledWith('board_keep_awake_release',{request:owner});const calls=vi.mocked(invoke).mock.calls.length;
  await act(async()=>{fireEvent(window,new Event('focus'));nativeFocus();});expect(invoke).toHaveBeenCalledTimes(calls);expect(localStorage.getItem(boardAwakeKey)).toBe('true');
  view.rerender(<KeepAwakeControl sessionId="nav-board"/>);await waitFor(()=>expect(native.active()?.ticket).toBeGreaterThan(owner!.ticket));
});
it('retains the native-loss opt-in latch across hidden navigation',async()=>{
  const native=backend();localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="lost-board"/>);
  await screen.findByText('This board owns an acknowledged idle-inhibition request.');const owner=native.active()!;
  await act(async()=>nativeLoss({...native.status(owner.ticket),active:false,reason:'Owned display lost'}));
  const acquired=vi.mocked(invoke).mock.calls.filter(([name])=>name==='board_keep_awake_acquire').length;
  view.rerender(<KeepAwakeControl sessionId="lost-board" visible={false}/>);view.rerender(<KeepAwakeControl sessionId="lost-board"/>);await act(async()=>{});
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='board_keep_awake_acquire')).toHaveLength(acquired);expect(screen.getByText('Turn this off and on to request ownership again.')).toBeTruthy();
});
it('does not let a held acquire result cross a hide/reopen ownership boundary',async()=>{
  const native=backend();const original=vi.mocked(invoke).getMockImplementation()!;
  let complete!:(value:unknown)=>void,first:Owner|undefined;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='board_keep_awake_acquire' && !first) {
      first=(args as {request:Owner}).request;native.acquire(first);
      return new Promise(resolve=>{complete=resolve;}) as never;
    }
    return original(command,args,options);
  });
  localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="held-nav"/>);
  await waitFor(()=>expect(first).toBeTruthy());view.rerender(<KeepAwakeControl sessionId="held-nav" visible={false}/>);
  await waitFor(()=>expect(native.active()).toBeUndefined());view.rerender(<KeepAwakeControl sessionId="held-nav"/>);
  await waitFor(()=>expect(native.active()?.ticket).toBeGreaterThan(first!.ticket));const current=native.active();
  await act(async()=>complete({...native.status(first!.ticket),active:true}));
  expect(native.active()).toEqual(current);expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('This board owns an acknowledged idle-inhibition request.')).toBeTruthy();
});

it('observes another window disabling the preference while this board is hidden',async()=>{
  backend();localStorage.setItem(boardAwakeKey,'true');const view=render(<KeepAwakeControl sessionId="hidden-preference" visible={false}/>);
  await act(async()=>{localStorage.setItem(boardAwakeKey,'false');window.dispatchEvent(new StorageEvent('storage',{key:boardAwakeKey,newValue:'false'}));});
  expect(invoke).not.toHaveBeenCalled();view.rerender(<KeepAwakeControl sessionId="hidden-preference"/>);
  await waitFor(()=>expect(toggle()).toHaveProperty('disabled',false));expect(toggle()).toHaveProperty('checked',false);
  expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='board_keep_awake_acquire')).toBe(false);
});
