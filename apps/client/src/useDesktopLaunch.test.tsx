// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {acknowledgeAccessReady, accessSnapshot, applyAccessStatus} from './access';
import {localLaunchError, useDesktopLaunch, WARM_UNSUPPORTED} from './useDesktopLaunch';
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
function Harness({open,available=true,busy=false}:{open:(receipt:string)=>Promise<void>;available?:boolean;busy?:boolean}) {
  useUi(); const [notice,setNotice]=useState('');
  useDesktopLaunch(true,available,busy,open,setNotice);
  return <p role="status">{notice && localLaunchError(notice)}</p>;
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
  await screen.findByText(/Directory launch requires a new app instance/);
  expect(open).not.toHaveBeenCalled();
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('desktop_launch_ack',{receipt},{headers:{'X-Lazysh-Access':'a'.repeat(64)}}));
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(screen.getByRole('status').textContent).toMatch(/^Abrir um diretório exige/);
  await act(async()=>{await uiI18n.changeLanguage('es');});
  expect(screen.getByRole('status').textContent).toMatch(/^Abrir un directorio requiere/);
  expect(localLaunchError(WARM_UNSUPPORTED)).toMatch(/^Abrir un directorio requiere/);
  expect(localLaunchError('raw filesystem error')).toBe('raw filesystem error');
});
it('rejects malformed native metadata instead of guessing a successful or empty launch',async()=>{
  vi.mocked(invoke).mockResolvedValue({directoryReceipt:'not-a-receipt',notice:null});
  const open=vi.fn(async()=>{}); render(<Harness open={open}/>);
  await screen.findByText('This directory launch is no longer available. Run the directory command again.');
  expect(open).not.toHaveBeenCalled();
});
