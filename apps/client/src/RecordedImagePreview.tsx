import {useEffect,useRef,useState} from 'react';
import {t,useUi} from './i18n/core';
import {recordedDisplaySize,recordedImageBytes,type RecordedImage} from './recordedImage';

// An uncancellable bitmap decode can outlive its panel and SSH view. Keep the
// permit until that actual work settles, including across panel remounts.
let decoderInFlight=false;

export default function RecordedImagePreview({image,access,onBusy,onClose}:{
  image:RecordedImage;access:{current:()=>boolean};onBusy:(busy:boolean)=>void;onClose:()=>void;
}) {
  useUi();
  const canvas=useRef<HTMLCanvasElement>(null);
  const [ready,setReady]=useState(false);
  const [error,setError]=useState<''|'chatImageUnavailable'|'chatImageBusy'|'chatImageDimensions'|'chatImageDecodeFailed'>('');
  useEffect(()=>{
    const target=canvas.current!;
    let alive=true;
    setReady(false);setError('');
    const clear=()=>{alive=false;target.width=0;target.height=0;};
    void (async()=>{
      // StrictMode may clean up the first setup before its microtask runs.
      // Admit decoder work only for the still-current explicit preview.
      await Promise.resolve();
      if(!alive || !access.current())return;
      if(typeof createImageBitmap!=='function') {setError('chatImageUnavailable');return;}
      if(decoderInFlight) {setError('chatImageBusy');return;}
      decoderInFlight=true;onBusy(true);
      let bitmap:ImageBitmap|undefined;
      try {
        const bytes=recordedImageBytes(image), size=recordedDisplaySize(image,bytes);
        bitmap=await createImageBitmap(new Blob([bytes],{type:image.mimeType}),{imageOrientation:'from-image'});
        if(!alive || !access.current())return;
        if(bitmap.width!==size.width || bitmap.height!==size.height){setError('chatImageDimensions');return;}
        const context=target.getContext('2d');
        if(!context){setError('chatImageUnavailable');return;}
        target.width=size.width;target.height=size.height;
        context.drawImage(bitmap,0,0);setReady(true);
      } catch {
        if(alive && access.current())setError('chatImageDecodeFailed');
      } finally {
        bitmap?.close();decoderInFlight=false;onBusy(false);
      }
    })();
    return clear;
  },[image,access,onBusy]);
  return <section aria-label={t('chatImagePreview')}>
    <button type="button" onClick={onClose}>{t('chatImageClose')}</button>
    {!ready&&!error&&<p role="status">{t('chatImageLoading')}</p>}
    {error&&<p role="alert">{t(error)}</p>}
    <canvas ref={canvas} width={0} height={0} role="img" aria-label={t('chatImagePreview')} hidden={!ready} style={{maxWidth:'100%',height:'auto'}} />
  </section>;
}
