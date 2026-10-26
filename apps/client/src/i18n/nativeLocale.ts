import {invoke, isTauri} from '@tauri-apps/api/core';
import {useSyncExternalStore} from 'react';
import {getPreferences, mirrorNativeUiLanguage, parsePreferences, savePreferences} from '../preferences';
import {isUiLanguage, type UiLanguage} from './core';

export class PreferenceStorageError extends Error {}

type NativeStatus = {nativeAuthority:boolean; choice:UiLanguage; resolvedLocale:string; revision:string};
export type LocaleSnapshot = {mode:'unknown'|'frontend'|'native'; phase:'loading'|'ready'|'saving'|'error'; native?:NativeStatus; error?:'read'|'write'; writerPending?:boolean};
type Port = {
  native:boolean;
  invoke:<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
  commit:(choice:UiLanguage, authoritative:boolean)=>void;
};
function parseStatus(value:unknown): NativeStatus {
  const v=value as Partial<NativeStatus>|null;
  if (!v || typeof v!=='object' || typeof v.nativeAuthority!=='boolean') throw new Error('Invalid locale capability');
  if (!v.nativeAuthority) return {nativeAuthority:false, choice:'system',resolvedLocale:'en',revision:'0'};
  if (!isUiLanguage(v.choice) || typeof v.resolvedLocale!=='string' || v.resolvedLocale.length>80
    || typeof v.revision!=='string' || !/^(0|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.test(v.revision)) throw new Error('Invalid native locale');
  const [canonical]=Intl.getCanonicalLocales(v.resolvedLocale);
  if (canonical!==v.resolvedLocale || !/^(en(?:-|$)|es(?:-|$)|pt-BR$)/.test(canonical)) throw new Error('Invalid native locale tag');
  return v as NativeStatus;
}

/** One cosmetic queue survives lock-driven workspace remounts; it never captures access authority. */
export function createLocaleController(port:Port) {
  let snapshot:LocaleSnapshot={mode:port.native?'unknown':'frontend',phase:port.native?'loading':'ready'};
  const listeners=new Set<()=>void>();
  let tail:Promise<unknown>=Promise.resolve();
  let refreshing:Promise<void>|undefined;
  let pendingChanges=0;
  let failureEpoch=0;
  let initialized=!port.native;
  const publish=(next:LocaleSnapshot)=>{snapshot=next;for(const listen of listeners)listen();};
  const accept=(status:NativeStatus)=>{
    if (status.nativeAuthority) port.commit(status.choice,true);
    publish({mode:status.nativeAuthority?'native':'frontend',phase:'ready',native:status});
  };
  const enqueue=<T>(work:()=>Promise<T>)=>{
    const task=tail.then(work);tail=task.catch(()=>{});return task;
  };
  const read=async()=>{
    if (!port.native) return;
    publish({...snapshot,phase:'loading',error:undefined});
    let deadline:ReturnType<typeof setTimeout>|undefined;
    const expired=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Native locale read timed out')),5000);});
    try {accept(parseStatus(await Promise.race([port.invoke('ui_locale_status'),expired])));}
    catch {publish({...snapshot,phase:'error',error:'read'});throw new Error('Native interface language could not be read');}
    finally {clearTimeout(deadline);}
  };
  const refresh=()=>{
    if(pendingChanges>0)return Promise.reject(new Error('A native language write is still finishing; wait or restart before retrying'));
    if(refreshing)return refreshing;
    const task=enqueue(read);refreshing=task;
    void task.then(()=>{refreshing=undefined;},()=>{refreshing=undefined;});
    return task;
  };
  return {
    snapshot:()=>snapshot,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    start:()=>{if (!initialized){initialized=true;void refresh().catch(()=>{});}},
    refresh,
    change:(choice:UiLanguage,current:()=>boolean=()=>true):Promise<void>=>{
      if (!isUiLanguage(choice)) return Promise.reject(new Error('Invalid interface language'));
      if (snapshot.mode==='frontend') {
        if (!current()) return Promise.reject(new Error('Language action cancelled'));
        try {port.commit(choice,false);return Promise.resolve();}
        catch {return Promise.reject(new PreferenceStorageError('Cannot save interface preferences'));}
      }
      if(snapshot.mode!=='native' || snapshot.phase==='error' || snapshot.phase==='loading')return Promise.reject(new Error('Retry the native language check'));
      if(pendingChanges>=16)return Promise.reject(new Error('Language changes are busy'));
      pendingChanges++;
      const capturedFailure=failureEpoch;
      return enqueue(async()=>{
        if (!current() || capturedFailure!==failureEpoch || snapshot.mode!=='native' || snapshot.phase==='error' || !snapshot.native) throw new Error('Retry the native language check');
        const previous=snapshot.native;
        publish({...snapshot,phase:'saving',error:undefined,writerPending:true});
        // Report slow native writes without abandoning their ownership or allowing replay.
        const watchdog=setTimeout(()=>{failureEpoch++;publish({...snapshot,phase:'error',error:'write'});},5000);
        try {
          const result=parseStatus(await port.invoke('ui_locale_set',{choice,expectedRevision:previous.revision}));
          if (!result.nativeAuthority || result.choice!==choice) throw new Error('Invalid native language result');
          accept(result);
        } catch {failureEpoch++;publish({...snapshot,phase:'error',error:'write',writerPending:false});throw new Error('Native interface language could not be saved');}
        finally {clearTimeout(watchdog);}
      }).finally(()=>{pendingChanges--;});
    },
  };
}

export const nativeLocale=createLocaleController({native:isTauri(),invoke,
  commit:(choice,authoritative)=>authoritative?mirrorNativeUiLanguage(choice):savePreferences({...getPreferences(),uiLanguage:choice}),
});
export function useNativeLocale() {
  return useSyncExternalStore(nativeLocale.subscribe,nativeLocale.snapshot,nativeLocale.snapshot);
}
/** Reset/import may change locale explicitly; ordinary preference writes never do on native-authority platforms. */
export function applyPreferenceIntent(value:unknown, explicitLanguage:boolean, current:()=>boolean=()=>true):Promise<void> {
  const preferences=parsePreferences(value);
  const commit=()=>{
    if(!current())return;
    try {savePreferences({...preferences,uiLanguage:getPreferences().uiLanguage});}
    catch {throw new PreferenceStorageError('Cannot save interface preferences');}
  };
  if (!explicitLanguage) {commit();return Promise.resolve();}
  const frontend=nativeLocale.snapshot().mode==='frontend';
  const task=nativeLocale.change(preferences.uiLanguage,current);
  if(frontend){commit();return task;}
  return task.then(commit);
}
