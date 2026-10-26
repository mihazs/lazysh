// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import SharePanel,{parseShare,thumbnailBlob} from '../SharePanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {shareOrigin,sharedFile,sharedImage,shareThumbnail} from '../test/shareData';
import {t,uiI18n} from './core';
import {LocalUiError,uiErrorText} from './localError';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic share locale authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);vi.mocked(invoke).mockImplementation(async command=>command==='share_status'?{configured:true,origin:shareOrigin}:undefined);});
afterEach(async()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();await uiI18n.changeLanguage('en');});
async function languagesKeep(check:()=>void){const calls=[...vi.mocked(invoke).mock.calls];for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});check();expect(vi.mocked(invoke).mock.calls).toEqual(calls);}}
async function ready(){await waitFor(()=>expect(screen.getByRole('button',{name:t('shareHistory')})).toHaveProperty('disabled',false));}
function selectFile(bytes=new Uint8Array(300*1024)){
  const file=new File([new Uint8Array(bytes)],'notes.txt',{type:'text/plain'});Object.defineProperty(file,'slice',{value:(start:number,end:number)=>({arrayBuffer:async()=>bytes.slice(start,end).buffer})});fireEvent.change(screen.getByLabelText(t('shareFile')),{target:{files:[file]}});return bytes;
}
it('preserves focused credential drafts without storing/publishing them and sends one explicit original-lease configuration',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(async command=>command==='share_status'?{configured:false,origin:null}:new Promise(resolve=>{finish=resolve;}));
  const stored=vi.spyOn(Storage.prototype,'setItem');render(<SharePanel/>);await waitFor(()=>expect(screen.getByLabelText(t('shareOriginLabel')).closest('fieldset')).toHaveProperty('disabled',false));
  const origin=screen.getByLabelText(t('shareOriginLabel'));const token=screen.getByLabelText(t('shareToken'));fireEvent.change(origin,{target:{value:shareOrigin}});fireEvent.change(token,{target:{value:'b'.repeat(64)}});token.focus();
  await languagesKeep(()=>{expect(screen.getByLabelText(t('shareToken'))).toBe(token);expect(document.activeElement).toBe(token);expect(token).toHaveProperty('value','b'.repeat(64));});expect(invoke).toHaveBeenCalledTimes(1);expect(stored).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:t('shareSave')}));await languagesKeep(()=>expect(screen.getByLabelText(t('shareToken'))).toHaveProperty('value','b'.repeat(64)));
  expect(invoke).toHaveBeenLastCalledWith('share_configure',{origin:shareOrigin,token:'b'.repeat(64)},{headers:{'X-Lazysh-Access':'c'.repeat(64)}});
  await act(async()=>{finish({configured:true,origin:shareOrigin});});await languagesKeep(()=>{expect(token).toHaveProperty('value','');expect(screen.getByRole('status').textContent).toBe(t('shareSaved'));});
});
it('keeps the selected File/TTL and exact ordered chunk data while a chunk is held across locale changes',async()=>{
  let finish!:()=>void;vi.mocked(invoke).mockImplementation(async(command,args)=>command==='share_status'?{configured:true,origin:shareOrigin}:command==='share_upload_begin'?{id:'original-pending'}:command==='share_upload_chunk'&&(args as {offset:number}).offset===0?new Promise(resolve=>{finish=()=>resolve(undefined);}):command==='share_upload_finish'?{schemaVersion:1,share:sharedFile}:undefined);
  render(<SharePanel/>);await ready();const bytes=new Uint8Array(300*1024);bytes[0]=255;bytes[262144]=17;selectFile(bytes);fireEvent.change(screen.getByLabelText(t('shareLifetime')),{target:{value:'86400'}});const file=screen.getByLabelText(t('shareFile'));
  await languagesKeep(()=>{expect(screen.getByLabelText(t('shareFile'))).toBe(file);expect(screen.getByLabelText(t('shareLifetime'))).toHaveProperty('value','86400');});fireEvent.click(screen.getByRole('button',{name:t('shareUpload')}));await waitFor(()=>expect(finish).toBeDefined());
  await languagesKeep(()=>expect(screen.getByRole('button',{name:t('shareCancel')})).toBeTruthy());await act(async()=>{finish();});await screen.findByText(t('shareComplete'));
  const chunks=vi.mocked(invoke).mock.calls.filter(([command])=>command==='share_upload_chunk');expect(chunks.map(([,args])=>(args as {offset:number}).offset)).toEqual([0,262144]);expect(chunks.map(([,args])=>(args as {data:number[]}).data)).toEqual([Array.from(bytes.slice(0,262144)),Array.from(bytes.slice(262144))]);
  expect(invoke).toHaveBeenCalledWith('share_upload_begin',{name:'notes.txt',mime:'text/plain',size:bytes.length,ttlSeconds:86400},{headers:{'X-Lazysh-Access':'c'.repeat(64)}});expect(invoke).toHaveBeenCalledWith('share_upload_finish',{id:'original-pending'},{headers:{'X-Lazysh-Access':'c'.repeat(64)}});await languagesKeep(()=>expect(screen.getByRole('status').textContent).toBe(t('shareComplete')));
});
it('retains an accepted late finish after cancellation and translates its warning without repeating publication',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(async command=>command==='share_status'?{configured:true,origin:shareOrigin}:command==='share_upload_begin'?{id:'cancel-pending'}:command==='share_upload_finish'?new Promise(resolve=>{finish=resolve;}):undefined);
  render(<SharePanel/>);await ready();selectFile(new Uint8Array());fireEvent.click(screen.getByRole('button',{name:t('shareUpload')}));await waitFor(()=>expect(finish).toBeDefined());fireEvent.click(screen.getByRole('button',{name:t('shareCancel')}));await languagesKeep(()=>expect(screen.getByRole('button',{name:t('shareCancel')})).toBeTruthy());await act(async()=>{finish({schemaVersion:1,share:sharedFile});});
  await languagesKeep(()=>{expect(screen.getByRole('status').textContent).toBe(t('shareCompletedBeforeCancellation'));expect(screen.getByRole('button',{name:t('shareDelete',{name:sharedFile.name})})).toHaveProperty('disabled',false);});expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='share_upload_finish')).toHaveLength(1);
});
it('preserves thumbnail identity/resources and performs copy/delete/forget only after explicit actions',async()=>{
  const create=vi.fn(()=> 'blob:share-locale');const revoke=vi.fn();Object.defineProperties(URL,{createObjectURL:{configurable:true,value:create},revokeObjectURL:{configurable:true,value:revoke}});const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async command=>command==='share_status'?{configured:true,origin:shareOrigin}:command==='share_list'?{schemaVersion:1,shares:[sharedImage],nextCursor:null}:command==='share_thumbnail'?shareThumbnail:undefined);
  const view=render(<SharePanel/>);await ready();fireEvent.click(screen.getByRole('button',{name:t('shareHistory')}));await screen.findByText(sharedImage.name);fireEvent.click(screen.getByRole('button',{name:t('shareLoadThumbnail',{name:sharedImage.name})}));const image=await screen.findByRole('img');
  await languagesKeep(()=>{expect(screen.getByRole('img')).toBe(image);expect(image.getAttribute('src')).toBe('blob:share-locale');expect(image.getAttribute('alt')).toBe(t('shareThumbnailAlt',{name:sharedImage.name}));expect(create).toHaveBeenCalledOnce();expect(revoke).not.toHaveBeenCalled();expect(writeText).not.toHaveBeenCalled();expect(confirm).not.toHaveBeenCalled();});
  fireEvent.click(screen.getByRole('button',{name:t('shareCopy',{name:sharedImage.name})}));await screen.findByText(t('shareCopied'));expect(writeText).toHaveBeenCalledExactlyOnceWith(sharedImage.url);await languagesKeep(()=>expect(screen.getByRole('status').textContent).toBe(t('shareCopied')));
  fireEvent.click(screen.getByRole('button',{name:t('shareDelete',{name:sharedImage.name})}));await waitFor(()=>expect(screen.queryByRole('img')).toBeNull());expect(confirm).toHaveBeenCalledExactlyOnceWith(t('shareConfirmDelete',{name:sharedImage.name}));expect(invoke).toHaveBeenCalledWith('share_delete',{id:sharedImage.id},{headers:{'X-Lazysh-Access':'c'.repeat(64)}});expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:share-locale');
  fireEvent.click(screen.getByRole('button',{name:t('shareForget')}));await screen.findByText(t('shareForgotten'));await languagesKeep(()=>expect(screen.getByRole('status').textContent).toBe(t('shareForgotten')));expect(view.container.textContent).not.toContain('c'.repeat(64));
});
it('keeps one held thumbnail request and translates its cancellation state while ignoring its late bytes',async()=>{
  let finish!:(value:unknown)=>void;const create=vi.fn();Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create});
  vi.mocked(invoke).mockImplementation(async command=>command==='share_status'?{configured:true,origin:shareOrigin}:command==='share_list'?{schemaVersion:1,shares:[sharedImage],nextCursor:null}:command==='share_thumbnail'?new Promise(resolve=>{finish=resolve;}):undefined);
  const view=render(<SharePanel/>);await ready();fireEvent.click(screen.getByRole('button',{name:t('shareHistory')}));fireEvent.click(await screen.findByRole('button',{name:t('shareLoadThumbnail',{name:sharedImage.name})}));
  await languagesKeep(()=>expect(screen.getByRole('status').textContent).toBe(t('shareLoading')));const args=vi.mocked(invoke).mock.calls.find(([command])=>command==='share_thumbnail')![1];
  fireEvent.click(screen.getByRole('button',{name:t('shareCancelThumbnail')}));await languagesKeep(()=>expect(screen.getByRole('status').textContent).toBe(t('shareStopping')));expect(invoke).toHaveBeenCalledWith('share_thumbnail_cancel',{requestId:(args as {requestId:string}).requestId},{headers:{'X-Lazysh-Access':'c'.repeat(64)}});
  await act(async()=>{finish(shareThumbnail);});expect(create).not.toHaveBeenCalled();expect(view.container.querySelector('img')).toBeNull();
});
it('retains local URL/history failures in the current language while native key-shaped failures stay raw',async()=>{
  let response:unknown={schemaVersion:9};vi.mocked(invoke).mockImplementation(async command=>command==='share_status'?{configured:true,origin:shareOrigin}:response);
  render(<SharePanel/>);await ready();fireEvent.change(screen.getByLabelText(t('shareOriginLabel')),{target:{value:'https://user@other.test/path'}});fireEvent.click(screen.getByRole('button',{name:t('shareSave')}));await screen.findByRole('alert');await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe(t('shareOriginInvalid')));expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:t('shareHistory')}));await screen.findByText(t('shareHistoryInvalid'));await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe(t('shareHistoryInvalid')));
  const raw='shareHistoryInvalid <native/path> {{name}}';response=Promise.reject({key:'shareHistoryInvalid',message:raw});fireEvent.click(screen.getByRole('button',{name:t('shareHistory')}));await screen.findByText(raw);await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe(raw));
});
it.each(['completed','stopped'])('emits a finite %s closing-dialog warning without publishing its raw URL/token into the event',async outcome=>{
  let finish!:(value:unknown)=>void;let fail!:(reason:unknown)=>void;vi.mocked(invoke).mockImplementation(async command=>command==='share_status'?{configured:true,origin:shareOrigin}:command==='share_upload_begin'?{id:'closing-pending'}:command==='share_upload_finish'?new Promise((resolve,reject)=>{finish=resolve;fail=reject;}):undefined);
  const event=vi.fn();window.addEventListener('lazysh-error',event);const view=render(<SharePanel/>);await ready();selectFile(new Uint8Array());fireEvent.click(screen.getByRole('button',{name:t('shareUpload')}));await waitFor(()=>expect(finish).toBeDefined());view.unmount();await act(async()=>{if(outcome==='completed')finish({schemaVersion:1,share:sharedFile});else fail('raw secret service diagnostic');});
  expect(event).toHaveBeenCalledOnce();const detail=(event.mock.calls[0][0] as CustomEvent).detail;expect(detail).toBeInstanceOf(LocalUiError);const key=outcome==='completed'?'shareCompletedWhileClosing':'shareStoppedWhileClosing';await languagesKeep(()=>expect(uiErrorText(detail)).toBe(t(key)));expect(JSON.stringify(detail)).not.toContain(shareOrigin);expect(JSON.stringify(detail)).not.toContain('raw secret');window.removeEventListener('lazysh-error',event);
});
it.each([
  ['shareInvalidPreview',()=>thumbnailBlob(null)],['sharePreviewMismatch',()=>thumbnailBlob({...shareThumbnail,width:2})],['shareResponseInvalid',()=>parseShare({...sharedFile,size:10485761},shareOrigin)],['shareAddressInvalid',()=>parseShare({...sharedFile,url:'not a URL'},shareOrigin)],['shareAddressInvalid',()=>parseShare({...sharedFile,url:'https://other.test/s/'+sharedFile.id},shareOrigin)],
] as const)('preserves finite %s validation without changing trust bounds',async(key,action)=>{let error:unknown;try{action();}catch(value){error=value;}expect(error).toBeInstanceOf(LocalUiError);expect(error).toHaveProperty('key',key);await languagesKeep(()=>expect(uiErrorText(error as LocalUiError)).toBe(t(key)));});
