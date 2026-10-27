// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import ThemeImportPanel from './ThemeImportPanel';
import {accessSnapshot,applyAccessStatus} from './access';
import {defaults} from './preferences';
import {t,uiI18n} from './i18n/core';
import {qrFrameSize,qrImageBytes,QR_IMAGE_LIMIT} from './themeQr';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn(),isTauri:vi.fn()}));
const png=new Uint8Array([137,80,78,71,13,10,26,10]),jpeg=new Uint8Array([255,216,255,1]);
const payload='moshi-theme:'+btoa(JSON.stringify({v:1,name:'QR fixture',mode:'dark',colors:{background:'#000000',foreground:'#ffffff'}}));
let permission:ReturnType<typeof vi.fn>,stop:ReturnType<typeof vi.fn>,media:MediaStream,draw:ReturnType<typeof vi.fn>;
function authority(locked=false){applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'QR fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'a'.repeat(64)})});}
function image(bytes=png){const file=new File([bytes],'qr.png',{type:'image/png'});Object.defineProperty(file,'arrayBuffer',{configurable:true,value:vi.fn(async()=>bytes.slice().buffer)});return file;}
function frame(){return {size:jpeg.length,arrayBuffer:vi.fn(async()=>jpeg.slice().buffer)} as unknown as Blob;}
function mount(){const apply=vi.fn().mockReturnValue(true);const view=render(<ThemeImportPanel preferences={defaults} apply={apply}/>);const details=view.container.querySelector('details')!;details.open=true;return {...view,apply};}
const choose=(file=image())=>fireEvent.change(screen.getByLabelText(t('themeQrFile')),{target:{files:[file]}});
const scan=()=>fireEvent.click(screen.getByRole('button',{name:t('themeQrScan')}));
const pendingCleanup:Array<()=>void>=[];
function held<T>(fallback:T,capture:(finish:(value:T)=>void)=>void){return new Promise<T>(resolve=>{capture(resolve);pendingCleanup.push(()=>resolve(fallback));});}
beforeEach(()=>{
  vi.stubEnv('VITE_LAZYSH_QR_CAMERA_TRACE',undefined);
  authority();vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockReset().mockResolvedValue(payload);
  stop=vi.fn();media={getTracks:()=>[{stop}]} as unknown as MediaStream;
  permission=vi.fn().mockResolvedValue(media);Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:permission}});
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLVideoElement.prototype,'readyState','get').mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype,'videoWidth','get').mockReturnValue(1280);vi.spyOn(HTMLVideoElement.prototype,'videoHeight','get').mockReturnValue(720);
  draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(callback=>callback(frame()));
});
afterEach(async()=>{cleanup();await act(async()=>{while(pendingCleanup.length)pendingCleanup.shift()!();});vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();await uiI18n.changeLanguage('en');});
it.each([undefined,'true','0'])('camera diagnostics are disabled unless explicitly enabled, value=%s',async(value)=>{
  vi.stubEnv('VITE_LAZYSH_QR_CAMERA_TRACE',value);const logger=vi.spyOn(console,'warn');
  mount();scan();await screen.findByRole('heading',{name:'QR fixture'});
  expect(logger).not.toHaveBeenCalled();expect(permission).toHaveBeenCalledExactlyOnceWith({audio:false,video:{facingMode:{ideal:'environment'}}});
});
it.each([false,true])('camera markers retain successful behavior when optional logger throws=%s',async(throws)=>{
  vi.stubEnv('VITE_LAZYSH_QR_CAMERA_TRACE','1');
  const logger=vi.spyOn(console,'warn').mockImplementation(()=>{if(throws)throw new Error('private logger failure sentinel');});
  const view=mount();scan();await screen.findByRole('heading',{name:'QR fixture'});
  expect(logger.mock.calls).toEqual([['lazysh qr camera request'],['lazysh qr camera resolved'],['lazysh qr camera attached'],['lazysh qr camera play_resolved']]);
  expect(invoke).toHaveBeenCalledTimes(1);expect(view.apply).not.toHaveBeenCalled();expect(stop).toHaveBeenCalledTimes(1);
});
it('a rejected real camera request logs only fixed request/rejected boundaries',async()=>{
  vi.stubEnv('VITE_LAZYSH_QR_CAMERA_TRACE','1');const logger=vi.spyOn(console,'warn').mockImplementation(()=>{});
  permission.mockRejectedValue(new Error('private device identity sentinel'));mount();scan();await screen.findByRole('alert');
  expect(logger.mock.calls).toEqual([['lazysh qr camera request'],['lazysh qr camera rejected']]);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
});
it('pending camera work logs resolution after cancellation without attaching or publishing',async()=>{
  vi.stubEnv('VITE_LAZYSH_QR_CAMERA_TRACE','1');const logger=vi.spyOn(console,'warn').mockImplementation(()=>{});
  let finish!:(value:MediaStream)=>void;permission.mockImplementation(()=>held(media,resolve=>{finish=resolve;}));mount();scan();
  expect(logger.mock.calls).toEqual([['lazysh qr camera request']]);fireEvent.click(screen.getByRole('button',{name:t('themeQrCancel')}));
  await act(async()=>finish(media));
  expect(logger.mock.calls).toEqual([['lazysh qr camera request'],['lazysh qr camera resolved'],['lazysh qr camera stale']]);
  expect((screen.getByLabelText(t('themeQrVideo')) as HTMLVideoElement).srcObject).not.toBe(media);
  expect(stop).toHaveBeenCalledTimes(1);expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
});
it('attached camera work does not log play resolution until the actual play promise settles',async()=>{
  vi.stubEnv('VITE_LAZYSH_QR_CAMERA_TRACE','1');const logger=vi.spyOn(console,'warn').mockImplementation(()=>{});
  let finish!:(value:void)=>void;vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(()=>held<void>(undefined,resolve=>{finish=resolve;}));
  mount();scan();await waitFor(()=>expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
  expect(logger.mock.calls).toEqual([['lazysh qr camera request'],['lazysh qr camera resolved'],['lazysh qr camera attached']]);
  expect(draw).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
  await act(async()=>finish());await screen.findByRole('heading',{name:'QR fixture'});
  expect(logger).toHaveBeenLastCalledWith('lazysh qr camera play_resolved');expect(invoke).toHaveBeenCalledTimes(1);
});
it('play rejection logs only its finite boundary and preserves the existing camera failure',async()=>{
  vi.stubEnv('VITE_LAZYSH_QR_CAMERA_TRACE','1');const logger=vi.spyOn(console,'warn').mockImplementation(()=>{});
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error('private media failure sentinel'));mount();scan();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',t('themeQrCameraFailed'));
  expect(logger.mock.calls).toEqual([['lazysh qr camera request'],['lazysh qr camera resolved'],['lazysh qr camera attached'],['lazysh qr camera play_rejected']]);
  expect(draw).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();expect(stop).toHaveBeenCalledTimes(1);
});
it('selected PNG goes only through the native decoder and explicit existing preview/apply path',async()=>{
  const view=mount();const draft=screen.getByLabelText('Theme JSON or share code');fireEvent.change(draft,{target:{value:'unfinished manual draft'}});
  expect(permission).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();choose();
  await screen.findByRole('heading',{name:'QR fixture'});
  expect(draft).toHaveProperty('value','unfinished manual draft');expect(view.apply).not.toHaveBeenCalled();expect(permission).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('theme_qr_decode',{bytes:Array.from(png)},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  fireEvent.click(screen.getByRole('button',{name:'Apply to app and terminal'}));expect(view.apply).toHaveBeenCalledTimes(1);
});
it('bounds encoded images and aspect-preserved camera output without a JS decoder',()=>{
  expect(qrImageBytes(png.buffer)).toEqual(Array.from(png));expect(qrImageBytes(jpeg.buffer)).toEqual(Array.from(jpeg));
  for(const bytes of [new ArrayBuffer(0),new ArrayBuffer(QR_IMAGE_LIMIT+1),new Uint8Array([1,2,3]).buffer])expect(()=>qrImageBytes(bytes)).toThrow();
  expect(qrFrameSize(1280,720)).toEqual({width:500,height:281});expect(qrFrameSize(100,200)).toEqual({width:100,height:200});expect(qrFrameSize(720,1280)).toEqual({width:281,height:500});
  for(const value of [0,-1,Infinity,NaN])expect(()=>qrFrameSize(value,1)).toThrow();
});
it.each(['busy','imageLimit','invalidImage','multipleCodes','invalidPayload','stopped'] as const)('stops on native %s without retrying or applying',async(error)=>{
  vi.mocked(invoke).mockRejectedValue(error);const view=mount();choose();await screen.findByRole('alert');
  expect(invoke).toHaveBeenCalledTimes(1);expect(view.apply).not.toHaveBeenCalled();expect(screen.queryByRole('heading',{name:'QR fixture'})).toBeNull();expect(permission).not.toHaveBeenCalled();
});
it('reports no QR from a selected image without switching to camera',async()=>{
  vi.mocked(invoke).mockResolvedValue(null);mount();choose();await screen.findByText(t('themeQrNone'));expect(permission).not.toHaveBeenCalled();
});
it('retains the actual native promise gate after cancellation until it settles',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>held<unknown>(null,resolve=>{finish=resolve;}));mount();choose();await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:t('themeQrCancel')}));expect(screen.getByText(t('themeQrFinishing'))).toBeTruthy();
  expect(screen.getByLabelText(t('themeQrFile'))).toHaveProperty('disabled',true);choose();scan();expect(invoke).toHaveBeenCalledTimes(1);expect(permission).not.toHaveBeenCalled();
  await act(async()=>finish(payload));expect(screen.queryByRole('heading',{name:'QR fixture'})).toBeNull();expect(screen.getByLabelText(t('themeQrFile'))).toHaveProperty('disabled',false);
});
it.each(['cancel','timeout'] as const)('bounds pending permission on %s and stops late-arriving tracks',async(action)=>{
  vi.useFakeTimers();let finish!:(value:MediaStream)=>void;permission.mockImplementation(()=>held(media,resolve=>{finish=resolve;}));mount();scan();
  expect(permission).toHaveBeenCalledExactlyOnceWith({audio:false,video:{facingMode:{ideal:'environment'}}});
  if(action==='cancel')fireEvent.click(screen.getByRole('button',{name:t('themeQrCancel')}));else await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
  expect(screen.getByText(t(action==='timeout'?'themeQrTimeout':'themeQrCancelled'))).toBeTruthy();expect(screen.getByText(t('themeQrFinishing'))).toBeTruthy();
  await act(async()=>finish(media));expect(stop).toHaveBeenCalledTimes(1);expect(invoke).not.toHaveBeenCalled();expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});
it('discards a pending encoded frame after cancel without reading its bytes',async()=>{
  let encode!:BlobCallback;vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback=>{encode=callback;pendingCleanup.push(()=>callback(frame()));});mount();scan();
  await waitFor(()=>expect(encode).toBeTypeOf('function'));
  expect(draw).toHaveBeenCalledWith(screen.getByLabelText(t('themeQrVideo')),0,0,500,281);
  expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function),'image/jpeg',.85);
  fireEvent.click(screen.getByRole('button',{name:t('themeQrCancel')}));expect(stop).toHaveBeenCalledTimes(1);
  const blob=frame();await act(async()=>encode(blob));expect(blob.arrayBuffer).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
});
it.each(['cancel','hidden','pagehide','unmount','collapse','source','name','mode','review','paste','access'] as const)('rejects a held camera/native result after %s while keeping original ownership',async(action)=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>held<unknown>(null,resolve=>{finish=resolve;}));
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:vi.fn(()=>new Promise(()=>{}))}});
  const view=mount();scan();await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  if(action==='cancel')fireEvent.click(screen.getByRole('button',{name:t('themeQrCancel')}));
  if(action==='hidden'){vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');fireEvent(document,new Event('visibilitychange'));}
  if(action==='pagehide')fireEvent(window,new Event('pagehide'));
  if(action==='unmount')view.unmount();
  if(action==='collapse'){fireEvent.click(screen.getByText('Import and share theme'));}
  if(action==='source')fireEvent.change(screen.getByLabelText('Theme JSON or share code'),{target:{value:'new manual intent'}});
  if(action==='name')fireEvent.change(screen.getByLabelText('Theme name'),{target:{value:'new name'}});
  if(action==='mode')fireEvent.change(screen.getByLabelText('Theme mode'),{target:{value:'light'}});
  if(action==='review')fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));
  if(action==='paste')fireEvent.click(screen.getByRole('button',{name:'Read theme from clipboard'}));
  if(action==='access')await act(async()=>{authority(true);authority();});
  expect(stop).toHaveBeenCalledTimes(1);await act(async()=>finish(payload));
  expect(view.apply).not.toHaveBeenCalled();expect(screen.queryByRole('heading',{name:'QR fixture'})).toBeNull();expect(invoke).toHaveBeenCalledTimes(1);expect(permission).toHaveBeenCalledTimes(1);
});
it('keeps one held original frame and camera across locale changes, then previews without applying',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>held<unknown>(null,resolve=>{finish=resolve;}));const view=mount();scan();await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  const video=screen.getByLabelText(t('themeQrVideo'));const{enablePseudoLocale}=await import('./test/pseudoLocale');
  for(const locale of ['en','pt-BR','es','en-XA']){
    await act(async()=>{if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);});
    expect(screen.getByLabelText(t('themeQrVideo'))).toBe(video);expect(video).toHaveProperty('srcObject',media);expect(stop).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledTimes(1);expect(permission).toHaveBeenCalledTimes(1);
  }
  await act(async()=>finish(payload));expect(screen.getByRole('heading',{name:'QR fixture'})).toBeTruthy();expect(view.apply).not.toHaveBeenCalled();expect(stop).toHaveBeenCalledTimes(1);
});
it('continues only with a new frame after null, using the same lease and bounded frame delay',async()=>{
  vi.useFakeTimers();vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce(payload);mount();scan();await act(async()=>{});
  expect(invoke).toHaveBeenCalledTimes(1);await act(async()=>{await vi.advanceTimersByTimeAsync(249);});expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(invoke).toHaveBeenCalledTimes(2);expect(permission).toHaveBeenCalledTimes(1);expect(stop).toHaveBeenCalledTimes(1);
});
it('does not start camera or native decoding on mount or in the browser-only presentation',()=>{
  vi.mocked(isTauri).mockReturnValue(false);mount();expect(screen.getByRole('button',{name:t('themeQrScan')})).toHaveProperty('disabled',true);choose();scan();expect(permission).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
});

it('does not revive pending permission when the import details is collapsed and reopened',async()=>{
  let finish!:(value:MediaStream)=>void;permission.mockImplementation(()=>held(media,resolve=>{finish=resolve;}));mount();scan();
  const summary=screen.getByText('Import and share theme');fireEvent.click(summary);expect(summary.parentElement).toHaveProperty('open',false);
  fireEvent.click(summary);expect(summary.parentElement).toHaveProperty('open',true);
  await act(async()=>finish(media));expect(stop).toHaveBeenCalledTimes(1);expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
});
it('rejects a result between a DOM collapse and its queued toggle event',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>held<unknown>(null,resolve=>{finish=resolve;}));const view=mount();choose();await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  view.container.querySelector('details')!.open=false;
  await act(async()=>finish(payload));expect(screen.queryByRole('heading',{name:'QR fixture'})).toBeNull();expect(view.apply).not.toHaveBeenCalled();
});
it('discards a file read after new manual intent without dispatching its bytes',async()=>{
  let finish!:(value:ArrayBuffer)=>void;const file=image();Object.defineProperty(file,'arrayBuffer',{configurable:true,value:vi.fn(()=>held(png.buffer,resolve=>{finish=resolve;}))});
  const view=mount();choose(file);fireEvent.change(screen.getByLabelText('Theme name'),{target:{value:'New manual name'}});
  expect(screen.getByText(t('themeQrFinishing'))).toBeTruthy();await act(async()=>finish(png.buffer));
  expect(invoke).not.toHaveBeenCalled();expect(view.apply).not.toHaveBeenCalled();expect(screen.getByLabelText(t('themeQrFile'))).toHaveProperty('disabled',false);
});
it.each([['too large','é'.repeat(8193)],['surrogate','\ud800'],['wrong type',{}]] as const)('rejects native %s payload before theme review',async(_label,value)=>{
  vi.mocked(invoke).mockResolvedValue(value);const view=mount();choose();await screen.findByText(t('themeQrInvalidPayload'));
  expect(view.apply).not.toHaveBeenCalled();expect(screen.queryByRole('region',{name:'Theme preview'})).toBeNull();
});
it('does not adapt, fetch or open a decoded URL',async()=>{
  vi.mocked(invoke).mockResolvedValue('lazysh://theme?data=raw');const view=mount();choose();
  await screen.findByText(t('validationEnterValidThemeJSONOrAThemeShareCode'));
  expect(view.apply).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledTimes(1);expect(vi.mocked(invoke).mock.calls[0][0]).toBe('theme_qr_decode');expect(permission).not.toHaveBeenCalled();
});

it('ends camera capture at the total deadline while retaining the original native promise gate',async()=>{
  vi.useFakeTimers();let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>held<unknown>(null,resolve=>{finish=resolve;}));mount();scan();await act(async()=>{});expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});expect(stop).toHaveBeenCalledTimes(1);expect(screen.getByText(t('themeQrTimeout'))).toBeTruthy();expect(screen.getByText(t('themeQrFinishing'))).toBeTruthy();
  await act(async()=>finish(payload));expect(screen.queryByRole('heading',{name:'QR fixture'})).toBeNull();expect(invoke).toHaveBeenCalledTimes(1);expect(screen.getByLabelText(t('themeQrFile'))).toHaveProperty('disabled',false);
});
it('rejects an oversized selected file before reading or dispatching it',async()=>{
  const file=image(new Uint8Array(QR_IMAGE_LIMIT+1));mount();choose(file);await screen.findByText(t('themeQrImageLimit'));expect(file.arrayBuffer).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();expect(permission).not.toHaveBeenCalled();
});

it.each(['permission','blob','native'] as const)('retains the original %s pipeline across unmount and refuses new camera and file work until actual settlement',async(stage)=>{
  const permissions:Array<(value:MediaStream)=>void>=[],encodings:BlobCallback[]=[],replies:Array<(value:unknown)=>void>=[];
  if(stage==='permission')permission.mockImplementation(()=>held(media,resolve=>permissions.push(resolve)));
  if(stage==='blob')vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback=>{encodings.push(callback);pendingCleanup.push(()=>callback(frame()));});
  if(stage==='native')vi.mocked(invoke).mockImplementation(()=>held<unknown>(null,resolve=>replies.push(resolve)));
  const first=mount();scan();
  const entered=()=>stage==='permission'?permissions.length:stage==='blob'?encodings.length:replies.length;
  await waitFor(()=>expect(entered()).toBe(1));first.unmount();
  const second=mount();scan();const file=image();choose(file);
  expect(permission).toHaveBeenCalledTimes(1);expect(file.arrayBuffer).not.toHaveBeenCalled();
  expect(screen.getByText(t('themeQrBusy'))).toBeTruthy();expect(screen.getByRole('button',{name:t('themeQrScan')})).toHaveProperty('disabled',false);
  const settle=(index:number)=>{if(stage==='permission')permissions[index](media);else if(stage==='blob')encodings[index](frame());else replies[index](payload);};
  await act(async()=>settle(0));expect(screen.queryByRole('heading',{name:'QR fixture'})).toBeNull();expect(second.apply).not.toHaveBeenCalled();
  scan();await waitFor(()=>expect(entered()).toBe(2));expect(permission).toHaveBeenCalledTimes(2);
  await act(async()=>settle(1));expect(screen.getByRole('heading',{name:'QR fixture'})).toBeTruthy();expect(second.apply).not.toHaveBeenCalled();
});
