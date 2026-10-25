import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { bindProtectedInvoke, captureAccess, isAccessReady, subscribeAccess } from './access';
import { chromeColors, parseThemeImport, type ImportedTheme } from './themeImport';
import { getPreferences, savePreferences } from './preferences';

type Candidate = {receipt: string; code: string};
export function themeCandidate(value: unknown): Candidate {
  if (!value || typeof value !== 'object') throw new Error('Theme link is unavailable.');
  const p=value as Record<string,unknown>;
  if (typeof p.receipt!=='string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(p.receipt)
    || typeof p.code!=='string' || p.code.length>16384 || !/^lazysh-theme:[\w-]+$/.test(p.code)) throw new Error('Theme link is unavailable.');
  return {receipt:p.receipt,code:p.code};
}
/** This separate surface never changes the manual import form or its unsaved draft. */
export default function ThemeLinkPanel({target}: {target?: HTMLElement|null}) {
  const lease=useRef(captureAccess()).current;
  const invoke=useMemo(()=>bindProtectedInvoke(lease),[lease]);
  const [pending,setPending]=useState(false),[candidate,setCandidate]=useState<Candidate>(),[preview,setPreview]=useState<ImportedTheme>();
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const mounted=useRef(true),running=useRef(false);
  useEffect(()=>{
    mounted.current=true;let disposed=false,revision=0,stopEvent:(()=>void)|undefined;
    const refresh=()=>{
      if(disposed || !lease.current() || !isAccessReady())return;
      const request=++revision;
      void invoke<unknown>('theme_link_status').then(value=>{if(!disposed && request===revision && lease.current() && typeof value==='boolean')setPending(value);}).catch(()=>{});
    };
    const stopAccess=subscribeAccess(refresh);
    void listen('lazysh-theme-link',refresh).then(stop=>{if(disposed)stop();else{stopEvent=stop;refresh();}}).catch(()=>{});
    refresh();
    return()=>{disposed=true;mounted.current=false;stopAccess();stopEvent?.();};
  },[lease,invoke]);
  async function action(kind:'review'|'apply'|'cancel') {
    if(!mounted.current || !lease.current() || running.current)return;
    running.current=true;setBusy(true);setError('');setNotice('');
    try {
      if(kind==='review') {
        const value=await invoke<unknown>('theme_link_read');
        if(!mounted.current || !lease.current())return;
        if(value===null){setPending(false);return;}
        const next=themeCandidate(value);setCandidate(next);
        try {setPreview(parseThemeImport(next.code,{name:'Linked theme',mode:'dark'}));}
        catch {setError('This link does not contain a supported theme. Discard it or keep your current theme.');}
      } else if(candidate) {
        await invoke('theme_link_ack',{receipt:candidate.receipt});
        lease.assert();if(!mounted.current)return;
        if(kind==='apply' && preview) {
          savePreferences({...getPreferences(),customTheme:preview.colors,customThemeInfo:{name:preview.name,mode:preview.mode},theme:'custom',appTheme:'custom'});
          setNotice('Linked theme applied to app and terminal.');
        }
        setCandidate(undefined);setPreview(undefined);
        // Refresh failure must not misreport an already applied theme as unchanged.
        const value=await invoke<unknown>('theme_link_status').catch(()=>undefined);
        if(mounted.current && lease.current() && typeof value==='boolean')setPending(value);
      }
    } catch {if(mounted.current && lease.current())setError('Theme link could not be updated. Your current theme was kept. Retry when ready.');}
    finally {if(mounted.current && lease.current()){running.current=false;setBusy(false);}}
  }
  if(!pending && !candidate && !notice)return null;
  const content=<aside aria-label="Theme link">
    {pending && !candidate && <><p>A theme link is ready to review. Your current theme stays in use until you apply it.</p><button type="button" disabled={busy} onClick={()=>void action('review')}>Review linked theme</button></>}
    {candidate && <section aria-label="Linked theme preview" className="theme-preview" style={preview?chromeColors(preview):undefined}>
      <h2>{preview?.name ?? 'Unsupported theme link'}</h2>
      {preview && <><p>{preview.mode==='light'?'Light':'Dark'} theme · lazysh 中文</p><pre style={{background:preview.colors.background,color:preview.colors.foreground}}>agent $ ready for review</pre><button type="button" disabled={busy} onClick={()=>void action('apply')}>Apply linked theme</button></>}
      <button type="button" disabled={busy} onClick={()=>void action('cancel')}>Discard theme link</button>
    </section>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </aside>;
  return target?createPortal(content,target):content;
}
