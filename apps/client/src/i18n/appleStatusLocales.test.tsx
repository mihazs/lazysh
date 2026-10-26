// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import AppleStatusPanel from '../AppleStatusPanel';
import {uiI18n} from './core';
import {appleStatusCapability,appleStatusInputs,appleStatusLocales,appleStatusNativeReason,appleStatusSession} from '../test/appleStatusData';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn().mockResolvedValue(()=>{})}));
afterEach(async()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.resetAllMocks();await uiI18n.changeLanguage('en');});
function setup(override?:(command:string,args:Record<string,unknown>)=>Promise<unknown>|undefined){
  vi.mocked(listen).mockResolvedValue(()=>{});
  const input=appleStatusInputs();
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    const changed=override?.(command,(args??{}) as Record<string,unknown>);if(changed)return changed;
    if(command==='apple_status_capability')return appleStatusCapability;
    if(command==='agent_snapshot')return input.activity;
    if(command==='agent_approvals')return input.approvals;
  });
  return input;
}
async function cycle(assertion:(labels:typeof appleStatusLocales[number])=>void){
  const calls=vi.mocked(invoke).mock.calls.slice();
  for(const labels of appleStatusLocales){await act(()=>uiI18n.changeLanguage(labels.locale));assertion(labels);expect(vi.mocked(invoke).mock.calls).toEqual(calls);}
}
async function clickWhenEnabled(button:HTMLElement){
  await waitFor(()=>expect(button).toHaveProperty('disabled',false));
  fireEvent.click(button);
}
it('waits for delayed capability before activating an already-rendered control',async()=>{
  let resolve!:(value:unknown)=>void;
  setup(command=>command==='apple_status_capability'?new Promise(value=>{resolve=value;}):undefined);
  render(<AppleStatusPanel sessionId={appleStatusSession}/>);
  const button=await screen.findByRole('button',{name:'Start Live Activity'});
  expect(button).toHaveProperty('disabled',true);
  const starting=clickWhenEnabled(button);
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='apple_status_configure')).toBe(false);
  await act(async()=>{resolve(appleStatusCapability);});
  await starting;
  expect(await screen.findByRole('button',{name:'Stop Apple status'})).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([command,args])=>command==='apple_status_configure'&&(args as {enabled:boolean}).enabled)).toHaveLength(1);
});
it('keeps a pending capability request and focused explicit control through same-mount language changes',async()=>{
  let resolve!:(value:unknown)=>void;setup(command=>command==='apple_status_capability'?new Promise(value=>{resolve=value;}):undefined);
  render(<AppleStatusPanel sessionId={appleStatusSession}/>);
  await cycle(labels=>{expect(screen.getByRole('region',{name:labels.title})).toBeTruthy();expect(screen.getByRole('button',{name:labels.start})).toHaveProperty('disabled',true);});
  await act(async()=>{resolve(appleStatusCapability);});
  const button=screen.getByRole('button',{name:appleStatusLocales[2].start});button.focus();
  await cycle(labels=>{expect(screen.getByRole('button',{name:labels.start})).toBe(button);expect(document.activeElement).toBe(button);expect(screen.getByText(appleStatusNativeReason,{exact:false})).toBeTruthy();});
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('preserves the publication sequence, original stale usage and redacted payload while enable is pending',async()=>{
  vi.useFakeTimers();const now=Date.now();let complete!:()=>void;
  const data=setup((command,args)=>command==='apple_status_configure'&&args.enabled===true?new Promise<void>(resolve=>{complete=resolve;}):undefined);
  await act(async()=>{render(<AppleStatusPanel sessionId={appleStatusSession} usage={data.usage}/>);});
  fireEvent.click(screen.getByRole('button',{name:'Start Live Activity'}));
  await cycle(labels=>expect(screen.getByRole('button',{name:labels.start})).toHaveProperty('disabled',true));
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='apple_status_publish')).toBe(false);
  await act(async()=>{complete();});
  const publish=()=>vi.mocked(invoke).mock.calls.filter(([command])=>command==='apple_status_publish').map(([,args])=>args as {snapshot:{sequence:number;subscriptionId:string;observedAt:number;expiresAt:number;running:number;waiting:number;usage:unknown};startActivity:boolean});
  expect(publish()).toHaveLength(1);const first=publish()[0];
  expect(first.startActivity).toBe(true);expect(first.snapshot).toMatchObject({sequence:1,running:1,waiting:0,expiresAt:first.snapshot.observedAt+60,usage:{freshness:'stale',recordedAt:Math.floor(Date.parse(data.usage.recordedAt)/1000),freshUntil:Math.floor((now-60_000)/1000)}});
  expect(JSON.stringify(first)).not.toMatch(/SECRET|private|project|summary|paneId|toolInput/);
  await cycle(labels=>{expect(screen.getByRole('button',{name:labels.stop})).toBeTruthy();expect(screen.getByRole('status')).toBeTruthy();});
  await act(async()=>{await vi.advanceTimersByTimeAsync(9999);});expect(publish()).toHaveLength(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(publish()).toHaveLength(2);
  expect(publish()[1]).toMatchObject({startActivity:false,snapshot:{subscriptionId:first.snapshot.subscriptionId,sequence:2,usage:first.snapshot.usage}});
});
it.each(['capability','stop'] as const)('translates a retained finite %s fallback without treating raw host keys as UI errors',async failure=>{
  setup((command,args)=>command==='apple_status_capability'&&failure==='capability'?Promise.reject('ignored native capability detail'):command==='apple_status_configure'&&args.enabled===false?Promise.reject('ignored native cleanup detail'):undefined);
  render(<AppleStatusPanel sessionId={appleStatusSession}/>);
  if(failure==='stop'){
    await clickWhenEnabled(await screen.findByRole('button',{name:'Start Live Activity'}));
    fireEvent.click(await screen.findByRole('button',{name:'Stop Apple status'}));
  }
  await screen.findByRole('alert');
  await cycle(labels=>expect(screen.getByRole('alert').textContent).toBe(failure==='capability'?labels.capability:labels.stopFailed));
});
it('leaves a raw native error identical to a catalog key verbatim through locale changes',async()=>{
  setup((command,args)=>command==='apple_status_configure'&&args.enabled===true?Promise.reject(new Error('appleStatusStopFailed')):undefined);
  render(<AppleStatusPanel sessionId={appleStatusSession}/>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Start Live Activity'})).toHaveProperty('disabled',false));
  fireEvent.click(screen.getByRole('button',{name:'Start Live Activity'}));await screen.findByRole('alert');
  await cycle(()=>expect(screen.getByRole('alert').textContent).toBe('appleStatusStopFailed'));
});
it.each([false,true])('translates the finite Watch availability explanation with installed=%s',async installed=>{
  setup(command=>command==='apple_status_capability'?Promise.resolve({...appleStatusCapability,watchInstalled:installed,watchReachable:false}):undefined);
  render(<AppleStatusPanel sessionId={appleStatusSession}/>);await screen.findByText(appleStatusNativeReason,{exact:false});
  await cycle(labels=>{expect(screen.getByText(appleStatusNativeReason,{exact:false}).textContent).toContain(installed?labels.unreachable:labels.missing);expect(screen.getByRole('button',{name:labels.watch})).toHaveProperty('disabled',!installed);});
});
