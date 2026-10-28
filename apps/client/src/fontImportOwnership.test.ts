// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {importFont} from './fonts';
const bytes=new ArrayBuffer(12);new DataView(bytes).setUint32(0,0x4f54544f);
const input={name:'owned.otf',size:bytes.byteLength,arrayBuffer:async()=>bytes};
const open=vi.fn();
const load=vi.fn();
beforeEach(()=>{
  vi.stubGlobal('indexedDB',{open});vi.stubGlobal('FontFace',class{load=load;});
  Object.defineProperty(document,'fonts',{configurable:true,value:{}});
  load.mockResolvedValue({});
});
afterEach(()=>{vi.unstubAllGlobals();vi.resetAllMocks();});
it('does not open font storage when original permission expires during browser decoding',async()=>{
  let finish!:(value:unknown)=>void;let allowed=true;
  load.mockImplementation(()=>new Promise(done=>{finish=done;}));
  const job=importFont(input,()=>allowed);const rejected=expect(job).rejects.toThrow('cancelled');
  await vi.waitFor(()=>expect(load).toHaveBeenCalledOnce());allowed=false;finish({});await rejected;
  expect(open).not.toHaveBeenCalled();
});
it.each(['revoke','budget'])('rejects late %s before admitting a store write',async transition=>{
  let allowed=true;
  const add=vi.fn(),close=vi.fn();
  const getAll={result:[] as unknown[],onsuccess:undefined as undefined|(()=>void)};
  const transaction={onabort:undefined as undefined|(()=>void),onerror:undefined as undefined|(()=>void),oncomplete:undefined as undefined|(()=>void),
    objectStore:()=>({getAll:()=>getAll,add}),abort:()=>transaction.onabort?.()};
  const database={transaction:()=>transaction,close};
  const request={result:database,onsuccess:undefined as undefined|(()=>void)};
  open.mockReturnValue(request);
  const job=importFont(input,()=>allowed);const rejected=expect(job).rejects.toThrow(transition==='revoke'?'cancelled':'at most 4');
  await vi.waitFor(()=>expect(open).toHaveBeenCalledOnce());request.onsuccess!();
  await vi.waitFor(()=>expect(getAll.onsuccess).toBeTypeOf('function'));
  if(transition==='revoke')allowed=false;
  else getAll.result=Array.from({length:4},(_,index)=>({id:`00000000-0000-0000-0000-${String(index).padStart(12,'0')}`,name:'existing',size:12,bytes}));
  getAll.onsuccess!();await rejected;
  expect(add).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
});
