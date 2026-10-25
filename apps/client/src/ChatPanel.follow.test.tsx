// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import ChatPanel from './ChatPanel';
import {accessSnapshot,applyAccessStatus} from './access';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));
const page=(text='Initial branch')=>({schemaVersion:1,agent:'claude',view:'active_branch',messages:[{id:text,role:'assistant',blocks:[{type:'text',text}]}],nextOffset:100,hasMore:false});
function access(locked=false){applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked,generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'a'.repeat(64)})});}
beforeEach(()=>{vi.useFakeTimers();vi.mocked(invoke).mockReset();access();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});});
afterEach(()=>{cleanup();vi.useRealTimers();});
async function open(){
  const result=render(<ChatPanel sessionId="host"/>);
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/claude.jsonl'}});
  fireEvent.change(screen.getByLabelText('View'),{target:{value:'conversation'}});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  return result;
}
const advance=async(ms:number)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
it('defaults off, serializes polling and waits two seconds after completion before replacing the branch',async()=>{
  let resolve!: (value:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(page()).mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue(page('Newest branch'));
  await open();
  expect(screen.getByLabelText('Follow selected Claude branch')).toHaveProperty('checked',false);
  await advance(10_000);expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText('Follow selected Claude branch'));
  await advance(1999);expect(invoke).toHaveBeenCalledTimes(1);
  await advance(1);expect(invoke).toHaveBeenCalledTimes(2);
  await advance(20_000);expect(invoke).toHaveBeenCalledTimes(2);
  await act(async()=>{resolve(page('Replacement branch'));});
  expect(screen.queryByText('Initial branch')).toBeNull();expect(screen.getByText('Replacement branch')).toBeTruthy();
  await advance(1999);expect(invoke).toHaveBeenCalledTimes(2);
  await advance(1);expect(invoke).toHaveBeenCalledTimes(3);
  expect(screen.queryByText('Replacement branch')).toBeNull();expect(screen.getByText('Newest branch')).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.every(([command,args])=>command==='agent_transcript'&&(args as Record<string,unknown>).offset===0)).toBe(true);
});
it('stops on errors and requires explicit resume',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue(page('Recovered branch'));
  await open();fireEvent.click(screen.getByLabelText('Follow selected Claude branch'));
  await advance(2000);
  expect(screen.getByRole('alert').textContent).toBe('Read failed');
  expect(screen.getByLabelText('Follow selected Claude branch')).toHaveProperty('checked',false);
  await advance(10_000);expect(invoke).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByLabelText('Follow selected Claude branch'));
  await advance(2000);expect(screen.getByText('Recovered branch')).toBeTruthy();
});
it('pauses hidden/page-hidden reads, drops late hidden results and resumes at the completion interval',async()=>{
  let resolve!: (value:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(page()).mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue(page('Visible branch'));
  await open();fireEvent.click(screen.getByLabelText('Follow selected Claude branch'));
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
  fireEvent(document,new Event('visibilitychange'));
  await advance(20_000);expect(invoke).toHaveBeenCalledTimes(1);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  fireEvent(document,new Event('visibilitychange'));
  await advance(2000);expect(invoke).toHaveBeenCalledTimes(2);
  fireEvent(window,new Event('pagehide'));
  await act(async()=>{resolve(page('Hidden late content'));});
  expect(screen.queryByText('Hidden late content')).toBeNull();
  await advance(20_000);expect(invoke).toHaveBeenCalledTimes(2);
  fireEvent(window,new Event('pageshow'));
  await advance(1999);expect(invoke).toHaveBeenCalledTimes(2);
  await advance(1);expect(screen.getByText('Visible branch')).toBeTruthy();
});
it('stops on source/session changes and unmount rather than following a new target implicitly',async()=>{
  vi.mocked(invoke).mockResolvedValue(page());
  const result=await open();fireEvent.click(screen.getByLabelText('Follow selected Claude branch'));
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/other.jsonl'}});
  await advance(10_000);expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Follow selected Claude branch')).toHaveProperty('checked',false);
  expect(screen.getByLabelText('Follow selected Claude branch')).toHaveProperty('disabled',true);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  fireEvent.click(screen.getByLabelText('Follow selected Claude branch'));
  result.rerender(<ChatPanel sessionId="other-host"/>);
  await advance(10_000);expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText('Follow selected Claude branch')).toBeNull();
  result.unmount();await advance(10_000);expect(invoke).toHaveBeenCalledTimes(2);
});
it('does not acquire a new access lease or display an old result after lock and unlock',async()=>{
  let resolve!: (value:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(page()).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  await open();fireEvent.click(screen.getByLabelText('Follow selected Claude branch'));
  await advance(2000);
  await act(async()=>{access(true);access();await Promise.resolve();await Promise.resolve();});
  await act(async()=>{resolve(page('Stale private content'));});
  expect(screen.queryByText('Stale private content')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('Follow selected Claude branch')).toHaveProperty('checked',false);
  expect(screen.getByLabelText('Follow selected Claude branch')).toHaveProperty('disabled',true);
  await advance(20_000);expect(invoke).toHaveBeenCalledTimes(2);
});
it('keeps an explicitly requested manual read when visibility changes',async()=>{
  let resolve!: (value:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(page()).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  await open();
  fireEvent.click(screen.getByRole('button',{name:'Refresh new messages'}));
  fireEvent(window,new Event('pagehide'));
  await act(async()=>{resolve(page('Explicit result'));});
  expect(screen.getByText('Explicit result')).toBeTruthy();
  expect(screen.getByLabelText('Follow selected Claude branch')).toHaveProperty('checked',false);
});
it('keeps the reader in history until Jump to latest and resumes following the bottom',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(page()).mockResolvedValue(page('New branch'));
  await open();
  const list=screen.getByRole('region',{name:'Conversation messages'});
  Object.defineProperty(list,'scrollHeight',{configurable:true,value:1000});
  Object.defineProperty(list,'clientHeight',{configurable:true,value:200});
  fireEvent.click(screen.getByLabelText('Follow selected Claude branch'));
  expect(list.scrollTop).toBe(1000);
  list.scrollTop=100;fireEvent.scroll(list);
  await advance(2000);expect(list.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole('button',{name:'Jump to latest'}));
  expect(list.scrollTop).toBe(1000);
  Object.defineProperty(list,'scrollHeight',{configurable:true,value:1500});
  await advance(2000);expect(list.scrollTop).toBe(1500);
});
