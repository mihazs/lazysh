import {isTauri} from '@tauri-apps/api/core';
import type {RefObject} from 'react';
import {t,useUi} from './i18n/core';
import {qrErrorKey,useThemeQr} from './themeQr';
const phases={permission:'themeQrPermission',scanning:'themeQrScanning',reading:'themeQrReading',decoding:'themeQrDecoding'} as const;
const notices={cancelled:'themeQrCancelled',timeout:'themeQrTimeout',none:'themeQrNone'} as const;
export default function ThemeQrPanel({intent,cancelRef,onDecoded}:{intent:RefObject<number>;cancelRef:RefObject<(()=>void)|null>;onDecoded:(payload:string)=>void}){
  useUi();const qr=useThemeQr(intent,cancelRef,onDecoded),native=isTauri();
  const pending=qr.state.phase!=='idle'||qr.state.finishing,disabled=!native||!qr.current()||pending;
  return <section className="theme-qr-panel" aria-label={t('themeQrTitle')}>
    <p>{t('themeQrIntro')}</p>
    {!native&&<p>{t('themeQrNative')}</p>}
    <button type="button" disabled={disabled} onClick={qr.startCamera}>{t('themeQrScan')}</button>
    <label>{t('themeQrFile')}<input type="file" accept="image/png,image/jpeg" disabled={disabled} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)qr.startFile(file);}}/></label>
    {pending&&<button type="button" onClick={qr.cancel}>{t('themeQrCancel')}</button>}
    <video ref={qr.video} muted playsInline hidden={!qr.state.camera||qr.state.phase==='idle'} aria-label={t('themeQrVideo')}/>
    {qr.state.phase!=='idle'&&<p role="status">{t(phases[qr.state.phase])}</p>}
    {qr.state.finishing&&<p role="status">{t('themeQrFinishing')}</p>}
    {qr.state.notice&&<p role="status">{t(notices[qr.state.notice])}</p>}
    {qr.state.error&&<p role="alert">{t(qrErrorKey(qr.state.error))}</p>}
  </section>;
}
