// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {downloadNotoFont,FONT_DOWNLOAD_TIMEOUT,notoFont} from './fontDownload';
import {getDeviceFonts,importFont} from './fonts';
vi.mock('./fonts',async original=>({...await original<typeof import('./fonts')>(),getDeviceFonts:vi.fn(),importFont:vi.fn()}));
const digest=vi.fn();
const fetcher=vi.fn();
const expected=Uint8Array.from(notoFont.sha256.match(/../g)!,part=>parseInt(part,16)).buffer;
function response(bytes:Uint8Array<ArrayBuffer>,headers:Record<string,string>={},status=200){return new Response(bytes,{status,headers});}
const start=(signal=new AbortController().signal,current=()=>true,progress=vi.fn())=>downloadNotoFont(signal,current,progress);
beforeEach(()=>{
  vi.stubGlobal('fetch',fetcher);vi.stubGlobal('crypto',{subtle:{digest}});vi.stubGlobal('indexedDB',{});vi.stubGlobal('FontFace',class{});
  Object.defineProperty(document,'fonts',{configurable:true,value:{}});
  vi.mocked(getDeviceFonts).mockReturnValue({fonts:[],selection:{},warnings:[],ready:true});
  vi.mocked(importFont).mockResolvedValue('cached-font');digest.mockResolvedValue(expected);
  fetcher.mockImplementation(async()=>response(new Uint8Array(notoFont.bytes)));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetAllMocks();});
it('uses only the pinned credential-free nonredirecting request and imports exact verified bytes without selecting them',async()=>{
  const progress=vi.fn();
  expect(await start(undefined,undefined,progress)).toBe('cached-font');
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(notoFont.url,{method:'GET',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:expect.any(AbortSignal)});
  expect(digest).toHaveBeenCalledExactlyOnceWith('SHA-256',expect.any(Uint8Array));
  const [file,permitted]=vi.mocked(importFont).mock.calls[0];
  expect(file).toMatchObject({name:notoFont.file,size:notoFont.bytes});
  expect(await file.arrayBuffer()).toBe(digest.mock.calls[0][1].buffer);expect(permitted!()).toBe(false);
  expect(progress).toHaveBeenLastCalledWith(notoFont.bytes);
});
const invalidResponses:Array<{bytes:number;headers:Record<string,string>;status:number}>=[
  {bytes:12,headers:{},status:200},
  {bytes:notoFont.bytes+1,headers:{},status:200},
  {bytes:1,headers:{'content-length':'12'},status:200},
  {bytes:1,headers:{'content-length':'not-a-size'},status:200},
  {bytes:1,headers:{},status:500},
  {bytes:1,headers:{},status:302},
];
it.each(invalidResponses)('rejects status/size mismatch before digest or import: %j',async fixture=>{
  fetcher.mockResolvedValue(response(new Uint8Array(fixture.bytes),fixture.headers,fixture.status));
  await expect(start()).rejects.toThrow('unexpected status or byte length');
  expect(digest).not.toHaveBeenCalled();expect(importFont).not.toHaveBeenCalled();
});
it('rejects missing streams and a wrong digest without handing bytes to the font parser',async()=>{
  fetcher.mockResolvedValueOnce(new Response(null,{status:200}));
  await expect(start()).rejects.toThrow('unexpected status or byte length');
  digest.mockResolvedValueOnce(new ArrayBuffer(32));
  await expect(start()).rejects.toThrow('pinned SHA-256');expect(importFont).not.toHaveBeenCalled();
});
it('checks capability and existing storage budgets before any network request',async()=>{
  vi.mocked(getDeviceFonts).mockReturnValue({fonts:Array.from({length:4},(_,i)=>({id:String(i),name:'owned',size:12})),selection:{},warnings:[],ready:true});
  await expect(start()).rejects.toThrow('at most 4');expect(fetcher).not.toHaveBeenCalled();
  vi.stubGlobal('FontFace',undefined);
  await expect(start()).rejects.toThrow('required browser APIs');expect(fetcher).not.toHaveBeenCalled();
});
it('retains one slot through cancelled browser decoding and prevents a replacement job until retirement',async()=>{
  let finish!:(id:string)=>void;
  vi.mocked(importFont).mockImplementationOnce(()=>new Promise(done=>{finish=done;}));
  const controller=new AbortController();
  const job=start(controller.signal);const cancelled=expect(job).rejects.toThrow('cancelled');
  await vi.waitFor(()=>expect(importFont).toHaveBeenCalledOnce());
  controller.abort();
  expect(vi.mocked(importFont).mock.calls[0][1]!()).toBe(false);
  await expect(start()).rejects.toThrow('still finishing');expect(fetcher).toHaveBeenCalledOnce();
  finish('already-cached');await cancelled;
  fetcher.mockResolvedValueOnce(response(new Uint8Array(notoFont.bytes)));
  expect(await start()).toBe('cached-font');
});
it('rejects a stale original owner after a held digest and never imports',async()=>{
  let finish!:(value:ArrayBuffer)=>void;let current=true;
  digest.mockImplementationOnce(()=>new Promise(done=>{finish=done;}));
  const job=start(undefined,()=>current);const rejected=expect(job).rejects.toThrow('cancelled');
  await vi.waitFor(()=>expect(digest).toHaveBeenCalledOnce());current=false;finish(expected);await rejected;
  expect(importFont).not.toHaveBeenCalled();
});
it('bounds a stalled transfer with the existing original signal, without a retry',async()=>{
  vi.useFakeTimers();
  fetcher.mockImplementation((_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true})));
  const job=start();const rejected=expect(job).rejects.toThrow('two-minute');
  await vi.advanceTimersByTimeAsync(FONT_DOWNLOAD_TIMEOUT);await rejected;
  expect(fetcher).toHaveBeenCalledOnce();expect(importFont).not.toHaveBeenCalled();
});
it('aborts a blocked stream and does not mistake the full byte count for EOF',async()=>{
  let body!:ReadableStreamDefaultController<Uint8Array>;
  const controller=new AbortController();
  fetcher.mockImplementation((_url,options)=>Promise.resolve(new Response(new ReadableStream<Uint8Array>({start(value){body=value;options.signal.addEventListener('abort',()=>value.error(new DOMException('aborted','AbortError')),{once:true});}}))));
  const progress=vi.fn();const job=start(controller.signal,undefined,progress);const rejected=expect(job).rejects.toThrow('cancelled');
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());body.enqueue(new Uint8Array(notoFont.bytes));
  await Promise.resolve();await Promise.resolve();
  expect(digest).not.toHaveBeenCalled();expect(progress).not.toHaveBeenCalledWith(notoFont.bytes);
  controller.abort();await rejected;expect(importFont).not.toHaveBeenCalled();
});
it('rejects already-revoked or already-cancelled requests before networking',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(start(controller.signal)).rejects.toThrow('cancelled');
  await expect(start(undefined,()=>false)).rejects.toThrow('cancelled');expect(fetcher).not.toHaveBeenCalled();
});
