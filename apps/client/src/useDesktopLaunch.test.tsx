// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {StrictMode, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {acknowledgeAccessReady, accessSnapshot, applyAccessStatus} from './access';
import {captureLaunchError, useDesktopLaunch, type DesktopHostLaunch} from './useDesktopLaunch';
import {LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import {uiI18n, useUi} from './i18n/core';

const event=vi.hoisted(()=>({refresh:undefined as undefined|(()=>void)}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async (_name:string,callback:()=>void)=>{
  event.refresh=callback; return()=>{if(event.refresh===callback)event.refresh=undefined;};
})}));
const receipt='7b6d0fc9-a755-4e10-b2e3-0dbdc1259326';
let generation=0;
function access(locked=false) {
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'',generation:String(++generation),...(locked?{}:{nonce:'a'.repeat(64)})});
  if(!locked)acknowledgeAccessReady(accessSnapshot().epoch);
}
function Harness({open,available=true,busy=false,openHost}:{open:(receipt:string)=>Promise<void>;available?:boolean;busy?:boolean;openHost?:(launch:DesktopHostLaunch)=>Promise<void>}) {
  useUi(); const [notice,setNotice]=useState<UiErrorCause>('');
  useDesktopLaunch(true,available,busy,open,setNotice,openHost);
  return <p role="status">{notice && uiErrorText(notice)}</p>;
}
beforeEach(()=>{generation+=10;access();vi.mocked(invoke).mockReset();void uiI18n.changeLanguage('en');});
afterEach(cleanup);

it('starts a cold request once from a fresh ready mount and preserves its original header',async()=>{
  let pending:string|null=receipt;
  vi.mocked(invoke).mockImplementation(async()=>({directoryReceipt:pending,notice:null}));
  const open=vi.fn(async()=>{pending=null;});
  render(<Harness open={open}/>);
  await waitFor(()=>expect(open).toHaveBeenCalledExactlyOnceWith(receipt));
  expect(invoke).toHaveBeenCalledWith('desktop_launch_read',undefined,{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
});
it('does not spend admission in a StrictMode setup that is immediately cleaned up',async()=>{
  let pending:string|null=receipt;
  vi.mocked(invoke).mockImplementation(async()=>{
    const directoryReceipt=pending; pending=null;
    return {directoryReceipt,notice:null};
  });
  const open=vi.fn(async()=>{});
  render(<StrictMode><Harness open={open}/></StrictMode>);
  await waitFor(()=>expect(open).toHaveBeenCalledExactlyOnceWith(receipt));
});
it.each(['preparation failed before local_connect','LOCAL_LAUNCH_UNAVAILABLE','LOCAL_LAUNCH_DIRECTORY_UNSUPPORTED'])('does not reinterpret or retry a rejected open callback across busy cycles: %s',async raw=>{
  vi.mocked(invoke).mockResolvedValue({directoryReceipt:receipt,notice:null});
  const open=vi.fn(async()=>{throw raw;});
  const view=render(<Harness open={open}/>);
  await screen.findByText(raw);
  view.rerender(<Harness open={open} busy/>);
  view.rerender(<Harness open={open}/>);
  await waitFor(()=>expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(1));
  await act(async()=>{});
  expect(open).toHaveBeenCalledTimes(1);
});
it('keeps a locked or unsupported mount from reading directory metadata',async()=>{
  access(true); const open=vi.fn(async()=>{});
  const old=render(<Harness open={open}/>);
  await act(async()=>{}); expect(invoke).not.toHaveBeenCalled();
  old.unmount(); access();
  vi.mocked(invoke).mockResolvedValue({directoryReceipt:receipt,notice:null});
  const unsupported=render(<Harness open={open} available={false}/>);
  await act(async()=>{}); expect(open).not.toHaveBeenCalled(); unsupported.unmount();
  render(<Harness open={open}/>); await waitFor(()=>expect(open).toHaveBeenCalledWith(receipt));
});
it.each(['success','failure'] as const)('does not renew a same old mount after lock/unlock when a read settles with %s',async kind=>{
  let resolve!:(value:unknown)=>void,reject!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise((yes,no)=>{resolve=yes;reject=no;}));
  const open=vi.fn(async()=>{}); const old=render(<Harness open={open}/>);
  await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  await act(async()=>{access(true);access();});
  if(kind==='success')resolve({directoryReceipt:receipt,notice:null}); else reject('obsolete failure');
  await act(async()=>{});
  old.rerender(<Harness open={open} busy/>); old.rerender(<Harness open={open}/>);
  await act(async()=>{event.refresh?.();});
  expect(open).not.toHaveBeenCalled(); expect(screen.getByRole('status').textContent).toBe('');
  expect(invoke).toHaveBeenCalledTimes(1); old.unmount();
  vi.mocked(invoke).mockResolvedValue({directoryReceipt:receipt,notice:null});
  render(<Harness open={open}/>); await waitFor(()=>expect(open).toHaveBeenCalledWith(receipt));
});
it('shows a finite warm rejection without opening a terminal and translates the still-visible notice',async()=>{
  let notice:{receipt:string}|null={receipt};
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='desktop_launch_ack'){notice=null;return;}
    return {directoryReceipt:null,notice};
  });
  const open=vi.fn(async()=>{}); render(<Harness open={open}/>);
  await screen.findByText(/This launch requires a new app instance/);
  expect(open).not.toHaveBeenCalled();
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('desktop_launch_ack',{receipt},{headers:{'X-Lazysh-Access':'a'.repeat(64)}}));
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(screen.getByRole('status').textContent).toMatch(/^Esta abertura exige/);
  await act(async()=>{await uiI18n.changeLanguage('es');});
  expect(screen.getByRole('status').textContent).toMatch(/^Esta apertura requiere/);
  expect(uiErrorText(new LocalUiError('desktopLaunchWarmUnsupported'))).toMatch(/^Esta apertura requiere/);
  expect(captureLaunchError('raw filesystem error')).toBe('raw filesystem error');
});
it('translates a finite native Windows directory refusal across all UI locales',async()=>{
  vi.mocked(invoke).mockRejectedValue('LOCAL_LAUNCH_DIRECTORY_UNSUPPORTED');
  const open=vi.fn(async()=>{}); render(<Harness open={open}/>);
  await screen.findByText(/^This directory is not supported by the Windows local shell/);
  for(const [locale,expected] of [['pt-BR','Este diretório não é compatível'],['es','El shell local de Windows no admite']] as const) {
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('status').textContent).toMatch(new RegExp(`^${expected}`));
  }
  expect(open).not.toHaveBeenCalled();
});
it('rejects malformed native metadata instead of guessing a successful or empty launch',async()=>{
  vi.mocked(invoke).mockResolvedValue({directoryReceipt:'not-a-receipt',notice:null});
  const open=vi.fn(async()=>{}); render(<Harness open={open}/>);
  await screen.findByText('This launch request is no longer available. Run the command again.');
  expect(open).not.toHaveBeenCalled();
});

const launchHost={id:'legacy-host 世界',name:'Saved host',hostname:'host.test',port:22,username:'owner'};
it('defers host admission until desktop capability and prepares once with its original lease under StrictMode',async()=>{
  let offered=false;
  vi.mocked(invoke).mockImplementation(async command=>command==='desktop_launch_prepare_host'?{hosts:[launchHost]}:{directoryReceipt:null,hostReceipt:offered?null:(offered=true,receipt),notice:null});
  const open=vi.fn(async()=>{}),openHost=vi.fn(async(_launch:DesktopHostLaunch)=>{});
  const view=render(<StrictMode><Harness open={open} openHost={openHost} available={false}/></StrictMode>);
  await act(async()=>{});expect(invoke).not.toHaveBeenCalled();
  view.rerender(<StrictMode><Harness open={open} openHost={openHost}/></StrictMode>);
  await waitFor(()=>expect(openHost).toHaveBeenCalledTimes(1));
  const handoff=openHost.mock.calls[0][0];expect(handoff.receipt).toBe(receipt);expect(handoff.hosts).toEqual([launchHost]);
  expect(Object.isFrozen(handoff)).toBe(true);expect(Object.isFrozen(handoff.hosts[0])).toBe(true);
  expect(handoff.lease.headers).toEqual({'X-Lazysh-Access':'a'.repeat(64)});
  expect(open).not.toHaveBeenCalled();
});
it.each(['HOST_LAUNCH_MISSING','HOST_LAUNCH_AMBIGUOUS'])('does not retry native host preparation failure after busy cycles: %s',async code=>{
  vi.mocked(invoke).mockImplementation(async command=>{if(command==='desktop_launch_prepare_host')throw code;return {directoryReceipt:null,hostReceipt:receipt,notice:null};});
  const openHost=vi.fn(async()=>{}),open=vi.fn(async()=>{});const view=render(<Harness open={open} openHost={openHost}/>);
  await waitFor(()=>expect(screen.getByRole('status').textContent).not.toBe(''));
  view.rerender(<Harness open={open} openHost={openHost} busy/>);view.rerender(<Harness open={open} openHost={openHost}/>);
  await act(async()=>{event.refresh?.();});
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='desktop_launch_prepare_host')).toHaveLength(1);
  expect(openHost).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
});
it.each(['success','failure'] as const)('drops a stale prepared-host %s on the same old mount after revoke/reunlock',async outcome=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='desktop_launch_prepare_host'?new Promise((yes,no)=>{finish=yes;fail=no;}):{directoryReceipt:null,hostReceipt:receipt,notice:null});
  const openHost=vi.fn(async()=>{}),open=vi.fn(async()=>{});render(<Harness open={open} openHost={openHost}/>);
  await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(2));
  await act(async()=>{access(true);access();});
  await act(async()=>{if(outcome==='success')finish({hosts:[launchHost]});else fail('HOST_LAUNCH_CHANGED');});
  expect(openHost).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toBe('');
});
it('keeps a raw host callback sentinel verbatim while native-owned failures remain branded',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='desktop_launch_prepare_host'?{hosts:[launchHost]}:{directoryReceipt:null,hostReceipt:receipt,notice:null});
  render(<Harness open={vi.fn(async()=>{})} openHost={vi.fn(async()=>{throw 'HOST_LAUNCH_CHANGED';})}/>);
  await screen.findByText('HOST_LAUNCH_CHANGED');
});
