import {useEffect,useRef,useState} from 'react';
import {subscribeAccess,useMountedAccess} from './access';
import {canDownloadFont,downloadNotoFont,notoFont} from './fontDownload';
import {useDeviceFonts} from './fonts';
import {formatNumber,t,useUi} from './i18n/core';
import license from './font-licenses/NotoSansMonoCJK-OFL.txt?raw';

type Phase='idle'|'downloading'|'saving'|'stopping'|'cancelled'|'downloaded';
export default function FontDownloadPanel({busy,run}:{busy:boolean;run:(action:()=>Promise<unknown>)=>Promise<void>}) {
  useUi();
  const {access,mounted}=useMountedAccess();
  const fonts=useDeviceFonts();
  const request=useRef<AbortController|null>(null);
  const [phase,setPhase]=useState<Phase>('idle');
  const [received,setReceived]=useState(0);
  const current=()=>mounted.current && access.current();
  useEffect(()=>{
    const stop=subscribeAccess(()=>{if(!access.current())request.current?.abort();});
    return()=>{stop();request.current?.abort();};
  },[access]);
  async function download(){
    if(busy || request.current || !current())return;
    const controller=new AbortController();request.current=controller;
    setReceived(0);setPhase('downloading');
    let completed=false;
    try {
      await run(async()=>{
        await downloadNotoFont(controller.signal,current,bytes=>{
          if(current() && request.current===controller){setReceived(bytes);if(bytes===notoFont.bytes)setPhase('saving');}
        });
        completed=true;
      });
    }finally{
      if(request.current===controller){
        request.current=null;
        if(current())setPhase(controller.signal.aborted?'cancelled':completed?'downloaded':'idle');
      }
    }
  }
  function cancel(){if(!current())return;request.current?.abort();setPhase('stopping');}
  return <section aria-label={t('fontDownloadRegion')}>
    <h4>{t('fontDownloadTitle')}</h4>
    <p>{t('fontDownloadHint',{size:formatNumber(notoFont.bytes/1048576,{maximumFractionDigits:2})})}</p>
    <button type="button" disabled={busy || !fonts.ready || !canDownloadFont()} onClick={()=>void download()}>{t('fontDownloadNoto')}</button>
    {request.current && <button type="button" onClick={cancel} disabled={phase==='stopping'}>{t('fontDownloadCancel')}</button>}
    {!canDownloadFont() && <p>{t('fontDownloadUnavailable')}</p>}
    {phase!=='idle' && <p role="status">{t(({downloading:'fontDownloadProgress',saving:'fontDownloadSaving',stopping:'fontDownloadStopping',cancelled:'fontDownloadCancelled',downloaded:'fontDownloadComplete'} as const)[phase],{received:formatNumber(received),total:formatNumber(notoFont.bytes)})}</p>}
    <details><summary>{t('fontDownloadLicense')}</summary><p>{t('fontDownloadSource')}</p><pre className="font-license">{license}</pre></details>
  </section>;
}
