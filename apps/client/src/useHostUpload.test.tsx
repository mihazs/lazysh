// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AttachmentPanel from './AttachmentPanel';
import {FilesPanel} from './SessionTools';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from './access';
import {attachmentFile,attachmentReceipt,attachmentSession} from './test/attachmentData';
import {t} from './i18n/core';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Upload lifecycle fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'d'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const commands=()=>vi.mocked(invoke).mock.calls.map(([command])=>command);
async function mount(kind:'attachment'|'files',file=attachmentFile()){
  const view=render(kind==='attachment'?<AttachmentPanel sessionId={attachmentSession}/>:<FilesPanel sessionId={attachmentSession}/>);
  if(kind==='files')await waitFor(()=>expect(screen.queryByText(t('filesLoading'))).toBeNull());
  fireEvent.change(screen.getByLabelText(t(kind==='attachment'?'attachmentChooseLabel':'filesChooseUpload')),{target:{files:[file]}});
  const upload=await screen.findByRole('button',{name:t(kind==='attachment'?'attachmentUpload':'filesUploadFile')});
  fireEvent.click(upload);
  return {view,cancel:()=>fireEvent.click(screen.getByRole('button',{name:t(kind==='attachment'?'attachmentCancel':'filesCancel')}))};
}
it.each(['attachment','files'] as const)('%s cancels an exact late reserve acknowledgement without ever sending bytes',async kind=>{
  let acknowledge!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='upload_reserve'?new Promise(resolve=>{acknowledge=resolve;}):command==='list_directory'?[]:{outcome:'unknown_or_settled'});
  const owner=await mount(kind);await waitFor(()=>expect(acknowledge).toBeTypeOf('function'));
  owner.cancel();expect(screen.getByText(t('uploadCancelledWarning'))).toBeTruthy();
  await act(async()=>{acknowledge({uploadId:attachmentReceipt});});
  expect(commands()).not.toContain('upload_file');
  expect(invoke).toHaveBeenCalledWith('upload_cancel',{sessionId:attachmentSession,uploadId:attachmentReceipt},{headers:{'X-Lazysh-Access':'d'.repeat(64)}});
  expect(screen.queryByLabelText(t('attachmentHostPath'))).toBeNull();
});
it.each(['attachment','files'] as const)('%s cancellation cannot publish a late successful transfer or refresh the directory',async kind=>{
  let complete!:()=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='upload_reserve'?{uploadId:attachmentReceipt}:command==='upload_file'?new Promise<void>(resolve=>{complete=resolve;}):command==='list_directory'?[]:{outcome:'cancellation_requested'});
  const owner=await mount(kind);await waitFor(()=>expect(complete).toBeTypeOf('function'));
  owner.cancel();await waitFor(()=>expect(commands()).toContain('upload_cancel'));
  await act(async()=>{complete();});
  expect(screen.queryByLabelText(t('attachmentHostPath'))).toBeNull();
  expect(commands().filter(command=>command==='list_directory')).toHaveLength(kind==='files'?1:0);
  expect(screen.getByText(t('uploadCancelledWarning'))).toBeTruthy();
});
it.each([['attachment',false],['files',false],['attachment',true],['files',true]] as const)('%s retains cancellation errors when upload completes first=%s',async(kind,uploadFirst)=>{
  let complete!:()=>void;let rejectCancel!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='upload_reserve')return {uploadId:attachmentReceipt};
    if(command==='list_directory')return [];
    if(command==='upload_cancel')return new Promise((_yes,no)=>{rejectCancel=no;});
    return new Promise<void>(resolve=>{complete=resolve;});
  });
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
  try{
    const owner=await mount(kind);await waitFor(()=>expect(complete).toBeTypeOf('function'));owner.cancel();
    await waitFor(()=>expect(rejectCancel).toBeTypeOf('function'));
    if(uploadFirst){await act(async()=>{complete();});expect(screen.getByRole('button',{name:t('uploadCancelling')})).toHaveProperty('disabled',true);}
    await act(async()=>{rejectCancel(new Error('Cancellation acknowledgement unavailable'));});
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Cancellation acknowledgement unavailable');
    expect(screen.getByText(t('uploadCancelledWarning'))).toBeTruthy();
    if(!uploadFirst)await act(async()=>{complete();});
    expect(screen.getByRole('alert')).toHaveProperty('textContent','Cancellation acknowledgement unavailable');
    expect(screen.getByText(t('uploadCancelledWarning'))).toBeTruthy();
    expect(screen.queryByLabelText(t('attachmentHostPath'))).toBeNull();expect(screen.queryByLabelText(t('attachmentPrompt'))).toBeNull();
    expect(commands().filter(command=>command==='list_directory')).toHaveLength(kind==='files'?1:0);
    expect(staged).not.toHaveBeenCalled();
    expect(commands().filter(command=>command==='upload_cancel')).toHaveLength(1);
  }finally{window.removeEventListener('lazysh-prompt-draft',staged);}
});
it('file-browser cancellation during held preparation never reserves or sends a late file read',async()=>{
  let decode!:(value:ArrayBuffer)=>void;const file=new File(['fixture'],'held.txt');Object.defineProperty(file,'arrayBuffer',{value:()=>new Promise(resolve=>{decode=resolve;})});
  vi.mocked(invoke).mockResolvedValue([]);
  const owner=await mount('files',file);await waitFor(()=>expect(decode).toBeTypeOf('function'));owner.cancel();
  await act(async()=>{decode(new Uint8Array([1]).buffer);});expect(commands()).toEqual(['list_directory']);
});
it.each(['attachment','files'] as const)('%s unmount cleans a late receipt using only its original authority',async kind=>{
  let acknowledge!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='upload_reserve'?new Promise(resolve=>{acknowledge=resolve;}):command==='list_directory'?[]:{outcome:'unknown_or_settled'});
  const owner=await mount(kind);await waitFor(()=>expect(acknowledge).toBeTypeOf('function'));owner.view.unmount();
  await act(async()=>{acknowledge({uploadId:attachmentReceipt});});expect(commands()).not.toContain('upload_file');
  expect(invoke).toHaveBeenCalledWith('upload_cancel',{sessionId:attachmentSession,uploadId:attachmentReceipt},{headers:{'X-Lazysh-Access':'d'.repeat(64)}});
});
it('a held transfer cannot publish or freshen authority after lock and unlock in the old mounted view',async()=>{
  let complete!:()=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='upload_reserve'?{uploadId:attachmentReceipt}:new Promise<void>(resolve=>{complete=resolve;}));
  await mount('attachment');await waitFor(()=>expect(complete).toBeTypeOf('function'));
  await act(async()=>{
    const generation=BigInt(accessSnapshot().status!.generation)+1n;
    applyAccessStatus({initialized:true,supported:true,enabled:true,locked:true,reason:'locked',generation:String(generation)});
    applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'unlocked',generation:String(generation+1n),nonce:'e'.repeat(64)});
    acknowledgeAccessReady(accessSnapshot().epoch);complete();
  });
  expect(screen.queryByLabelText(t('attachmentHostPath'))).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
  for(const call of vi.mocked(invoke).mock.calls)expect(call[2]).toEqual({headers:{'X-Lazysh-Access':'d'.repeat(64)}});
});
