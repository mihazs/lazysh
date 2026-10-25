// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import AppleStatusPanel from './AppleStatusPanel';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn().mockResolvedValue(()=>{})}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.resetAllMocks();});
const id='b11c6ca6-e4f7-4f63-859c-d08e66df2239';
function setup() {
  vi.mocked(listen).mockResolvedValue(()=>{});
  vi.mocked(invoke).mockImplementation((command,args)=>{
    if(command==='apple_status_capability')return Promise.resolve({liveActivities:true,watchPaired:true,watchInstalled:true,watchReachable:true,reason:'Local status.'}) as never;
    if(command==='agent_snapshot')return Promise.resolve({schemaVersion:1,sessions:[]}) as never;
    if(command==='agent_approvals')return Promise.resolve({schemaVersion:1,requests:[]}) as never;
    return Promise.resolve() as never;
  });
}
it('shares only after explicit opt-in and revokes the exact subscription on close',async()=>{
  setup();const view=render(<AppleStatusPanel sessionId={id}/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Enable Watch status'}) as HTMLButtonElement).disabled).toBe(false));
  expect(invoke).not.toHaveBeenCalledWith('agent_snapshot',expect.anything());
  fireEvent.click(screen.getByRole('button',{name:'Start Live Activity'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('apple_status_publish',expect.objectContaining({startActivity:true,snapshot:expect.objectContaining({sessionId:id,usage:null})})));
  const configured=vi.mocked(invoke).mock.calls.find(([command,args])=>command==='apple_status_configure' && (args as {enabled:boolean}).enabled)![1] as {subscriptionId:string};
  view.unmount();
  expect(invoke).toHaveBeenCalledWith('apple_status_configure',{subscriptionId:configured.subscriptionId,enabled:false});
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='resolve_agent_approval')).toBe(false);
});
it('a pending enable cannot publish after the view closes',async()=>{
  setup();let complete!:()=>void;
  vi.mocked(invoke).mockImplementation((command,args)=>{
    if(command==='apple_status_capability')return Promise.resolve({liveActivities:true,watchInstalled:true,reason:'Local'}) as never;
    if(command==='apple_status_configure' && (args as {enabled:boolean}).enabled)return new Promise<void>(resolve=>{complete=resolve;}) as never;
    return Promise.resolve() as never;
  });
  const view=render(<AppleStatusPanel sessionId={id}/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Start Live Activity'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Start Live Activity'}));view.unmount();complete();
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalledWith('apple_status_publish',expect.anything());
});
it('strips remote context and retains only a bounded last snapshot when backgrounded',async()=>{
  setup();const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,args)=>{
    if(command==='agent_snapshot')return Promise.resolve({schemaVersion:1,sessions:[
      {sessionId:id,agent:'claude',project:'/secret/project',state:'working',updatedAt:new Date().toISOString(),summary:'super-secret prompt',paneId:null,eventCount:1},
      {sessionId:id,agent:'claude',project:'/secret/project',state:'needs_attention',updatedAt:'2020-01-01T00:00:00Z',summary:'super-secret prompt',paneId:null,eventCount:1},
    ]}) as never;
    return original(command,args);
  });
  render(<AppleStatusPanel sessionId={id}/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Start Live Activity'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Start Live Activity'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('apple_status_publish',expect.objectContaining({snapshot:expect.objectContaining({running:1,waiting:0})})));
  const publish=vi.mocked(invoke).mock.calls.find(([command])=>command==='apple_status_publish')![1];
  expect(JSON.stringify(publish)).not.toMatch(/secret|project|summary/);
  vi.spyOn(document,'hidden','get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(vi.mocked(invoke).mock.calls.filter(([command,args])=>command==='apple_status_configure' && !(args as {enabled:boolean}).enabled)).toHaveLength(0);
});
it('retains the explicit Live Activity request after a transient publish failure',async()=>{
  vi.useFakeTimers();setup();const original=vi.mocked(invoke).getMockImplementation()!;
  let attempts=0;
  vi.mocked(invoke).mockImplementation((command,args)=>{
    if(command==='apple_status_publish' && ++attempts===1)return Promise.reject(new Error('Temporarily backgrounded'));
    return original(command,args);
  });
  await act(async()=>{render(<AppleStatusPanel sessionId={id}/>);});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Start Live Activity'}));});
  expect(attempts).toBe(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  const calls=vi.mocked(invoke).mock.calls.filter(([command])=>command==='apple_status_publish');
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toHaveProperty('startActivity',true);
});
it('keeps inspected counters separate and never freshens an aged report when publishing new status',async()=>{
  setup();const now=Date.now();const recordedAt=new Date(now-14*60_000).toISOString();
  const usage={inputTokens:120,outputTokens:0,cacheReadTokens:null,cacheWriteTokens:null,recordedAt,freshness:'fresh' as const,observedAt:new Date(now).toISOString(),receivedAt:now-2*60_000};
  render(<AppleStatusPanel sessionId={id} usage={usage}/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Start Live Activity'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Start Live Activity'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('apple_status_publish',expect.objectContaining({snapshot:expect.objectContaining({usage:{inputTokens:120,outputTokens:0,cacheReadTokens:null,cacheWriteTokens:null,recordedAt:Math.floor(Date.parse(recordedAt)/1000),freshness:'stale',freshUntil:Math.floor((now-60_000)/1000)}})})));
  const payload=vi.mocked(invoke).mock.calls.find(([command])=>command==='apple_status_publish')![1];
  expect(JSON.stringify(payload)).not.toContain('totalTokens');
});
it('routes Watch review only to the selected enabled SSH session',async()=>{
  setup();const review=vi.fn();render(<AppleStatusPanel sessionId={id} onReview={review}/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Start Live Activity'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Start Live Activity'}));
  await screen.findByRole('button',{name:'Stop Apple status'});
  const callback=vi.mocked(listen).mock.calls.find(([name])=>name==='lazysh-apple-review')![1] as (event:{payload:{sessionId:string;approvalId:string}})=>void;
  callback({payload:{sessionId:'another-session',approvalId:id}});expect(review).not.toHaveBeenCalled();
  callback({payload:{sessionId:id,approvalId:id}});expect(review).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'Stop Apple status'}));
  callback({payload:{sessionId:id,approvalId:id}});expect(review).toHaveBeenCalledOnce();
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='resolve_agent_approval')).toBe(false);
});
