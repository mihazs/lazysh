// @vitest-environment jsdom
import {StrictMode} from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import RecordedImagePreview from './RecordedImagePreview';
import ChatPanel from './ChatPanel';
import {invoke} from '@tauri-apps/api/core';
import {chatFollowAccess} from './test/chatFollowAccess';
import {grokFollowPage} from './test/recordedFollowData';
import {recordedImage,recordedDisplaySize,recordedImageBytes,type RecordedImage} from './recordedImage';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
const png=readFileSync('e2e/fixtures/recorded-images/regions.png');
const jpeg=readFileSync('e2e/fixtures/recorded-images/regions-orientation6.jpg');
const preview=(bytes:Uint8Array=png,mimeType:RecordedImage['mimeType']='image/png')=>recordedImage({mimeType,data:Buffer.from(bytes).toString('base64'),width:32,height:16});
let draw:ReturnType<typeof vi.fn>;
beforeEach(()=>{draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.mocked(invoke).mockReset();});

it('keeps decoder admission across actual ChatPanel remounts until the old bitmap settles',async()=>{
 const image=preview();chatFollowAccess();
 vi.mocked(invoke).mockResolvedValue({...grokFollowPage(),messages:[{id:'grok-record-0',role:'assistant',blocks:[{type:'image',text:'Owned image',imagePreview:image}]}]});
 let release!:(bitmap:unknown)=>void;let pending=0,maxPending=0;
 const bitmap=()=>({width:32,height:16,close:vi.fn(()=>{pending--;})});
 const oldBitmap=bitmap(),freshBitmap=bitmap();
 const decode=vi.fn().mockImplementation(()=>{pending++;maxPending=Math.max(maxPending,pending);return decode.mock.calls.length===1?new Promise(done=>{release=done;}):Promise.resolve(freshBitmap);});
 vi.stubGlobal('createImageBitmap',decode);
 async function open(sessionId:string) {
  const view=render(<ChatPanel sessionId={sessionId}/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'grok-acp'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/owned/updates.jsonl'}});
  fireEvent.click(screen.getByLabelText('Include recorded images'));
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'View recorded image'}));});
  return view;
 }
 try {
  const original=await open('original-ssh');expect(decode).toHaveBeenCalledTimes(1);original.unmount();
  await open('new-ssh');
  expect(decode).toHaveBeenCalledTimes(1);expect(maxPending).toBe(1);
  expect(screen.getByRole('alert').textContent).toBe('Another image preview is finishing. Choose View again when it completes.');
  await act(async()=>{release(oldBitmap);});
  expect(oldBitmap.close).toHaveBeenCalledTimes(1);expect(draw).not.toHaveBeenCalled();
  expect(decode).toHaveBeenCalledTimes(1);expect(pending).toBe(0);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'View recorded image'}));});
  expect(decode).toHaveBeenCalledTimes(2);expect(maxPending).toBe(1);expect(draw).toHaveBeenCalledTimes(1);
  expect(freshBitmap.close).toHaveBeenCalledTimes(1);expect(pending).toBe(0);
 } finally {cleanup();await act(async()=>{release?.(oldBitmap);});}
});
it('StrictMode admits exactly one explicitly mounted decoder and paints its current result',async()=>{
 const bitmap={width:32,height:16,close:vi.fn()};const decode=vi.fn().mockResolvedValue(bitmap);vi.stubGlobal('createImageBitmap',decode);
 const access={current:()=>true};
 await act(async()=>{render(<StrictMode><RecordedImagePreview image={preview()} access={access} onBusy={vi.fn()} onClose={vi.fn()} /></StrictMode>);});
 expect(decode).toHaveBeenCalledTimes(1);expect(draw).toHaveBeenCalledTimes(1);expect(bitmap.close).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByRole('img')).toHaveProperty('width',32);
});

it('validates returned preview fields and derives EXIF display dimensions without trusting swapped metadata',()=>{
 const rotated=preview(jpeg,'image/jpeg');expect(recordedDisplaySize(rotated,recordedImageBytes(rotated))).toEqual({width:16,height:32});
 const valid=preview();const apng=readFileSync('e2e/fixtures/recorded-images/regions-animated.png');
 for(const invalid of [{...valid,width:16,height:32},{...valid,uri:'https://must-not-fetch.invalid'},
  {...valid,data:'not-b64'},{...valid,data:'AAAA'.repeat(16385)},{...valid,mimeType:'image/svg+xml'},
  {...valid,width:2049},{...valid,width:2048,height:1024},{...valid,data:apng.toString('base64')}])expect(()=>recordedImage(invalid)).toThrow();
});

it('decodes the oriented JPEG once, closes the bitmap after drawing and clears canvas on unmount',async()=>{
 const bitmap={width:16,height:32,close:vi.fn()};const decode=vi.fn().mockResolvedValue(bitmap);vi.stubGlobal('createImageBitmap',decode);
 const busy=vi.fn();const access={current:()=>true};
 const view=render(<RecordedImagePreview image={preview(jpeg,'image/jpeg')} access={access} onBusy={busy} onClose={vi.fn()} />);
 await act(async()=>{});const canvas=screen.getByRole('img') as HTMLCanvasElement;
 expect([canvas.width,canvas.height]).toEqual([16,32]);expect(bitmap.close).toHaveBeenCalledTimes(1);
 expect(decode).toHaveBeenCalledWith(expect.any(Blob),{imageOrientation:'from-image'});
 expect(busy.mock.calls).toEqual([[true],[false]]);view.unmount();expect([canvas.width,canvas.height]).toEqual([0,0]);
});

it.each(['resolve','reject'])('suppresses a late decode %s after lease loss and disposes the original resource',async outcome=>{
 let settle!:(value:unknown)=>void;const decode=vi.fn().mockImplementation(()=>new Promise((resolve,reject)=>{settle=outcome==='resolve'?resolve:reject;}));vi.stubGlobal('createImageBitmap',decode);
 const bitmap={width:32,height:16,close:vi.fn()};let allowed=true;const access={current:()=>allowed};
 const view=render(<RecordedImagePreview image={preview()} access={access} onBusy={vi.fn()} onClose={vi.fn()} />);
 await act(async()=>{});const canvas=screen.getByRole('img',{hidden:true}) as HTMLCanvasElement;
 allowed=false;view.unmount();await act(async()=>{settle(outcome==='resolve'?bitmap:new Error('stale decode'));});
 expect(draw).not.toHaveBeenCalled();expect(bitmap.close).toHaveBeenCalledTimes(outcome==='resolve'?1:0);
 expect([canvas.width,canvas.height]).toEqual([0,0]);expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps one in-flight decode across replacement and never retries a refused new preview automatically',async()=>{
 let resolve!:(value:unknown)=>void;const bitmap={width:32,height:16,close:vi.fn()};const decode=vi.fn().mockImplementation(()=>new Promise(done=>{resolve=done;}));vi.stubGlobal('createImageBitmap',decode);
 const access={current:()=>true};const busy=vi.fn();
 const view=render(<RecordedImagePreview image={preview()} access={access} onBusy={busy} onClose={vi.fn()} />);
 await act(async()=>{});
 view.rerender(<RecordedImagePreview image={preview(jpeg,'image/jpeg')} access={access} onBusy={busy} onClose={vi.fn()} />);
 await act(async()=>{});expect(decode).toHaveBeenCalledTimes(1);
 await act(async()=>{resolve(bitmap);});expect(bitmap.close).toHaveBeenCalledTimes(1);expect(draw).not.toHaveBeenCalled();expect(decode).toHaveBeenCalledTimes(1);
});

it('rejects wrong actual dimensions and unsupported decoders without publishing pixels',async()=>{
 const bitmap={width:16,height:32,close:vi.fn()};vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap));
 const view=render(<RecordedImagePreview image={preview()} access={{current:()=>true}} onBusy={vi.fn()} onClose={vi.fn()} />);
 await act(async()=>{});expect(draw).not.toHaveBeenCalled();expect(bitmap.close).toHaveBeenCalledTimes(1);expect(screen.getByRole('alert').textContent).toMatch(/dimensions/);
 view.unmount();vi.stubGlobal('createImageBitmap',undefined);
 render(<RecordedImagePreview image={preview()} access={{current:()=>true}} onBusy={vi.fn()} onClose={vi.fn()} />);
 await act(async()=>{});expect(screen.getByRole('alert').textContent).toBe('Recorded image preview is unavailable on this device.');
});
