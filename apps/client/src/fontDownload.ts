import {assertFontBudget,getDeviceFonts,importFont} from './fonts';
import {LocalUiError} from './i18n/localError';

/** Unmodified official OTF; asset size and Git blob independently checked before pinning SHA-256. */
export const notoFont=Object.freeze({
  name:'Noto Sans Mono CJK SC',
  file:'NotoSansMonoCJKsc-Regular.otf',
  bytes:16_393_784,
  sha256:'ec04cc376b34887cedbdf84074e2e226ed2761eeabdcb9173fc1dd7bfd153ef7',
  url:'https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Mono/NotoSansMonoCJKsc-Regular.otf',
});
export const FONT_DOWNLOAD_TIMEOUT=120_000;
let active=false;
export function canDownloadFont() {
  return typeof globalThis.fetch==='function' && typeof globalThis.crypto?.subtle?.digest==='function' && typeof globalThis.indexedDB!=='undefined' && typeof globalThis.FontFace==='function' && typeof document!=='undefined' && !!document.fonts;
}
/** One owned job lasts through browser decoding/storage, even after cancellation. */
export async function downloadNotoFont(signal:AbortSignal,current:()=>boolean,progress:(bytes:number)=>void=()=>{}):Promise<string> {
  if(active)throw new LocalUiError('fontDownloadBusy');
  if(!canDownloadFont())throw new LocalUiError('fontDownloadUnavailable');
  const stop=new AbortController();
  const allowed=()=>!signal.aborted && !stop.signal.aborted && current();
  const check=()=>{if(!allowed())throw new LocalUiError('fontDownloadCancelled');};
  check();assertFontBudget([...getDeviceFonts().fonts.map(font=>font.size),notoFont.bytes]);
  active=true;
  let timedOut=false;
  const cancel=()=>stop.abort();
  signal.addEventListener('abort',cancel,{once:true});
  const timeout=setTimeout(()=>{timedOut=true;stop.abort();},FONT_DOWNLOAD_TIMEOUT);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    const response=await fetch(notoFont.url,{method:'GET',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:stop.signal});
    check();
    const length=response.headers.get('content-length');
    if(response.status!==200 || !response.body || (length!==null && (!/^\d+$/.test(length) || Number(length)!==notoFont.bytes)))throw new LocalUiError('fontDownloadInvalid');
    reader=response.body.getReader();
    const bytes=new Uint8Array(notoFont.bytes);
    let received=0,reported=0;
    while(true){
      const part=await reader.read();check();
      if(part.done)break;
      if(part.value.byteLength>notoFont.bytes-received)throw new LocalUiError('fontDownloadInvalid');
      bytes.set(part.value,received);received+=part.value.byteLength;
      if(received<notoFont.bytes && received-reported>=1048576){reported=received;progress(received);}
    }
    clearTimeout(timeout);
    if(received!==notoFont.bytes)throw new LocalUiError('fontDownloadInvalid');
    progress(received);
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));check();
    if([...digest].map(value=>value.toString(16).padStart(2,'0')).join('')!==notoFont.sha256)throw new LocalUiError('fontDownloadIntegrity');
    // Reuse owned verified bytes rather than copying the 16 MiB asset into a Blob
    // and then copying it back out through File.arrayBuffer().
    const id=await importFont({name:notoFont.file,size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer},allowed);
    check();return id;
  }catch(error){
    if(timedOut)throw new LocalUiError('fontDownloadTimeout');
    if(!allowed())throw new LocalUiError('fontDownloadCancelled');
    throw error;
  }finally{
    clearTimeout(timeout);signal.removeEventListener('abort',cancel);stop.abort();
    try {if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}} finally {active=false;}
  }
}
