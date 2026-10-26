// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AttachmentPanel from '../AttachmentPanel';
import {checkAttachment,checkDestination,imagePoint,imageSize,shellPath,validateCrop} from '../attachment';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {attachmentReceipt,attachmentBytes,attachmentDraft,attachmentFile,attachmentPath,attachmentPngHeader,attachmentSession} from '../test/attachmentData';
import {t,uiI18n} from './core';
import {LocalUiError} from './localError';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic attachment locale authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);
});
afterEach(async()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllGlobals();await uiI18n.changeLanguage('en');});
async function languagesKeep(check:()=>void){const calls=[...vi.mocked(invoke).mock.calls];for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});check();expect(vi.mocked(invoke).mock.calls).toEqual(calls);}}
async function choose(file=attachmentFile()){fireEvent.change(screen.getByLabelText(t('attachmentChooseLabel')),{target:{files:[file]}});await screen.findByLabelText(t('attachmentDestination'));}
it('retains exact private bytes/path/original lease through a held upload and preserves editable prompt and explicit actions',async()=>{
  let complete!:()=>void;vi.mocked(invoke).mockImplementation(command=>command==='upload_reserve'?Promise.resolve({uploadId:attachmentReceipt}):command==='upload_cancel'?Promise.resolve({outcome:'unknown_or_settled'}):new Promise(resolve=>{complete=()=>resolve(undefined);}));
  const read=vi.fn();const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read,writeText}});
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
  const view=render(<AttachmentPanel sessionId={attachmentSession}/>);await choose();const destination=screen.getByLabelText(t('attachmentDestination'));fireEvent.change(destination,{target:{value:attachmentPath}});destination.focus();
  await languagesKeep(()=>{expect(screen.getByLabelText(t('attachmentDestination'))).toBe(destination);expect(document.activeElement).toBe(destination);expect(destination).toHaveProperty('value',attachmentPath);expect(read).not.toHaveBeenCalled();expect(writeText).not.toHaveBeenCalled();});
  fireEvent.click(screen.getByRole('button',{name:t('attachmentUpload')}));
  await waitFor(()=>expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='upload_file')).toBe(true));
  await languagesKeep(()=>{expect(screen.getByRole('button',{name:t('attachmentUploading')})).toHaveProperty('disabled',true);expect(read).not.toHaveBeenCalled();});
  expect(invoke).toHaveBeenCalledWith('upload_file',{sessionId:attachmentSession,path:attachmentPath,data:attachmentBytes,uploadId:attachmentReceipt},{headers:{'X-Lazysh-Access':'c'.repeat(64)}});
  await act(async()=>{complete();});const prompt=screen.getByLabelText(t('attachmentPrompt'));const initial=prompt.getAttribute('value')??(prompt as HTMLTextAreaElement).value;
  await languagesKeep(()=>{expect(screen.getByLabelText(t('attachmentPrompt'))).toBe(prompt);expect(prompt).toHaveProperty('value',initial);expect(screen.getByRole('status').textContent).toBe(t('attachmentUploaded'));});
  fireEvent.change(prompt,{target:{value:attachmentDraft}});prompt.focus();await languagesKeep(()=>{expect(prompt).toHaveProperty('value',attachmentDraft);expect(document.activeElement).toBe(prompt);});
  fireEvent.click(screen.getByRole('button',{name:t('attachmentCopyPath')}));await waitFor(()=>expect(writeText).toHaveBeenCalledWith(shellPath(attachmentPath)));
  await languagesKeep(()=>expect(screen.getByRole('status').textContent).toBe(t('attachmentCopied')));
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:t('attachmentCopyPrompt')}));});expect(writeText).toHaveBeenLastCalledWith(attachmentDraft);
  fireEvent.click(screen.getByRole('button',{name:t('attachmentStage')}));expect(staged).toHaveBeenCalledOnce();expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:attachmentSession,text:attachmentDraft});
  await languagesKeep(()=>expect(screen.getByRole('status').textContent).toBe(t('attachmentStaged')));
  expect(view.container.textContent).not.toContain('c'.repeat(64));expect(view.container.querySelector('img,script')).toBeNull();window.removeEventListener('lazysh-prompt-draft',staged);
});
it('does not publish a held upload result into a replacement session after a language change',async()=>{
  let complete!:()=>void;vi.mocked(invoke).mockImplementation(command=>command==='upload_reserve'?Promise.resolve({uploadId:attachmentReceipt}):command==='upload_cancel'?Promise.resolve({outcome:'unknown_or_settled'}):new Promise(resolve=>{complete=()=>resolve(undefined);}));
  const view=render(<AttachmentPanel sessionId="old-attachment-session"/>);await choose();fireEvent.click(screen.getByRole('button',{name:t('attachmentUpload')}));
  await waitFor(()=>expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='upload_file')).toBe(true));
  view.rerender(<AttachmentPanel sessionId="new-attachment-session"/>);await languagesKeep(()=>expect(screen.queryByLabelText(t('attachmentHostPath'))).toBeNull());
  await act(async()=>{complete();});expect(screen.queryByLabelText(t('attachmentHostPath'))).toBeNull();expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['upload_reserve','upload_file','upload_cancel']);expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({sessionId:'old-attachment-session',data:attachmentBytes});
});
it('retranslates a retained destination error, keeps raw native diagnostic bytes and never retries on language change',async()=>{
  const raw='attachmentPathInvalid <native/path> {{path}}';vi.mocked(invoke).mockRejectedValue({message:raw,key:'attachmentPathInvalid'});
  render(<AttachmentPanel sessionId={attachmentSession}/>);await choose();fireEvent.change(screen.getByLabelText(t('attachmentDestination')),{target:{value:'/bad\tpath'}});fireEvent.click(screen.getByRole('button',{name:t('attachmentUpload')}));
  await screen.findByRole('alert');await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe(t('attachmentPathInvalid')));expect(invoke).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(t('attachmentDestination')),{target:{value:attachmentPath}});fireEvent.click(screen.getByRole('button',{name:t('attachmentUpload')}));await screen.findByText(raw);await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe(raw));
});
it('keeps explicit clipboard permission failures raw and translates only its own unavailable/empty/copy failures',async()=>{
  const read=vi.fn().mockRejectedValue(new Error('Raw clipboard denied {{device}}'));const writeText=vi.fn().mockRejectedValue(new Error('Native clipboard detail'));Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read,writeText}});
  vi.mocked(invoke).mockImplementation(async command=>command==='upload_reserve'?{uploadId:attachmentReceipt}:undefined);render(<AttachmentPanel sessionId={attachmentSession}/>);
  await languagesKeep(()=>expect(read).not.toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:t('attachmentPaste')}));await screen.findByRole('alert');await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe('Raw clipboard denied {{device}}'));
  read.mockResolvedValue([]);fireEvent.click(screen.getByRole('button',{name:t('attachmentPaste')}));await screen.findByText(t('attachmentClipboardEmpty'));await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe(t('attachmentClipboardEmpty')));
  await choose();fireEvent.click(screen.getByRole('button',{name:t('attachmentUpload')}));await screen.findByLabelText(t('attachmentHostPath'));fireEvent.click(screen.getByRole('button',{name:t('attachmentCopyPath')}));await screen.findByText(t('attachmentClipboardDenied'));await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe(t('attachmentClipboardDenied')));
});
it('preserves crop/color/canvas/image resources without new decode or redraw on language changes',async()=>{
  const context={clearRect:vi.fn(),drawImage:vi.fn(),strokeRect:vi.fn()};vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const decoded=vi.fn();vi.stubGlobal('Image',class{naturalWidth=100;naturalHeight=80;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;set src(value:string){if(value){decoded();queueMicrotask(()=>this.onload?.());}}});
  const create=vi.fn(()=> 'blob:owned-attachment');const revoke=vi.fn();Object.defineProperties(URL,{createObjectURL:{configurable:true,value:create},revokeObjectURL:{configurable:true,value:revoke}});
  const view=render(<AttachmentPanel sessionId={attachmentSession}/>);await choose(attachmentFile(attachmentPngHeader(),'shot.png','image/png'));fireEvent.click(screen.getByLabelText(t('attachmentEditing')));await waitFor(()=>expect(context.drawImage).toHaveBeenCalledOnce());
  const canvas=screen.getByLabelText(t('attachmentCanvas'));const crop=screen.getByLabelText(t('attachmentCropWidth'));fireEvent.change(crop,{target:{value:'50'}});fireEvent.change(screen.getByLabelText(t('attachmentColor')),{target:{value:'#123456'}});crop.focus();const draws=context.drawImage.mock.calls.length;
  await languagesKeep(()=>{expect(screen.getByLabelText(t('attachmentCanvas'))).toBe(canvas);expect(screen.getByLabelText(t('attachmentCropWidth'))).toBe(crop);expect(crop).toHaveProperty('value','50');expect(document.activeElement).toBe(crop);expect(screen.getByLabelText(t('attachmentColor'))).toHaveProperty('value','#123456');expect(context.drawImage).toHaveBeenCalledTimes(draws);expect(decoded).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledOnce();expect(revoke).not.toHaveBeenCalled();});
  view.unmount();expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned-attachment');
});
it('keeps an oversized image warning translatable while allowing the untouched original',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='upload_reserve'?{uploadId:attachmentReceipt}:undefined);render(<AttachmentPanel sessionId={attachmentSession}/>);const bytes=attachmentPngHeader(9000,1);await choose(attachmentFile(bytes,'large.png','image/png'));await languagesKeep(()=>expect(screen.getByRole('status').textContent).toBe(t('attachmentImageLimit')));expect(screen.queryByLabelText(t('attachmentEditing'))).toBeNull();fireEvent.click(screen.getByRole('button',{name:t('attachmentUpload')}));await screen.findByLabelText(t('attachmentHostPath'));expect(invoke).toHaveBeenCalledWith('upload_file',{sessionId:attachmentSession,path:'./large.png',data:Array.from(bytes),uploadId:attachmentReceipt},expect.anything());
});
it.each([
  ['attachmentFileLimit',()=>checkAttachment({name:'ok',size:10485761})],['attachmentFileName',()=>checkAttachment({name:'../bad',size:1})],['attachmentPathInvalid',()=>checkDestination('/bad\n')],['attachmentPngHeader',()=>{const bytes=attachmentPngHeader();bytes[8]=1;imageSize(bytes);}],['attachmentJpegHeader',()=>imageSize(new Uint8Array([255,216,0,192,0,8]))],['attachmentJpegSegment',()=>imageSize(new Uint8Array([255,216,255,192,0,99]))],['attachmentJpegDimensions',()=>imageSize(new Uint8Array([255,216,255,192,0,2]))],['attachmentJpegMissing',()=>imageSize(new Uint8Array([255,216,255,217]))],['attachmentCropInvalid',()=>validateCrop({x:0,y:0,width:0,height:1},{width:1,height:1,mime:'image/png'})],['attachmentPreviewSize',()=>imagePoint(0,0,{left:0,top:0,width:0,height:0},{width:1,height:1,mime:'image/png'})],
] as const)('retains a finite %s validator cause and the compatible Error.message',async(key,action)=>{
  let error:unknown;try{action();}catch(value){error=value;}expect(error).toBeInstanceOf(LocalUiError);expect(error).toHaveProperty('key',key);expect((error as Error).message).toBe(t(key));
});
