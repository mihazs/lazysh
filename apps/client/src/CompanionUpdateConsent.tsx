import {useEffect,useRef,useState} from 'react';
import {api as nativeApi} from './bridge';
import {useMountedAccess,useProtectedApi,useProtectedInvoke} from './access';
import {t,useUi} from './i18n/core';
import {appVersion} from './version';
import {companionUpdatedEvent,compareVersions,consentEvent,readConsent,writeConsent,type Consent} from './companionUpdate';

type Probe={sessionId:string;version:string|null;unix:boolean};
const parseProbe=(value:unknown,sessionId:string):Probe|undefined=>{
  const probe=value as {schemaVersion?:unknown;version?:unknown;unix?:unknown}|null;
  if(!probe || typeof probe!=='object' || probe.schemaVersion!==1 || typeof probe.unix!=='boolean' || (probe.version!==null && typeof probe.version!=='string'))return;
  return {sessionId,version:probe.version as string|null,unix:probe.unix};
};
/** The remembered choice for a host, kept current when another view changes it. */
export function useConsent(host:string):Consent|undefined {
  const [consent,setConsent]=useState(()=>readConsent(host));
  useEffect(()=>{
    const sync=()=>setConsent(readConsent(host));sync();
    window.addEventListener(consentEvent,sync);return()=>window.removeEventListener(consentEvent,sync);
  },[host]);
  return consent;
}

/** A companion that cannot update itself (no `update` in its reply) and is older than this app is only ever
 * changed by this app after the user agreed, once per host: Always, Not now or Never. */
export default function CompanionUpdateConsent({sessionId,host,ready,companionReplied,onInstalled}:{sessionId:string;host:string;ready:boolean;companionReplied:boolean;onInstalled:()=>void}) {
  useUi();const invoke=useProtectedInvoke();const api=useProtectedApi(nativeApi);const {access,mounted}=useMountedAccess();
  const [probe,setProbe]=useState<Probe>();
  const [declined,setDeclined]=useState<string>();
  const [phase,setPhase]=useState<{sessionId:string;state:'running'|'done'|'failed'}>();
  const asked=useRef<string|undefined>(undefined);const started=useRef<string|undefined>(undefined);
  const consent=useConsent(host);
  useEffect(()=>{
    if(!ready || companionReplied || asked.current===sessionId)return;
    asked.current=sessionId;
    invoke('companion_version',{sessionId}).then(value=>{if(mounted.current)setProbe(parseProbe(value,sessionId));},()=>{});
  },[ready,companionReplied,sessionId]);
  const current=probe?.sessionId===sessionId && probe.unix && probe.version && (compareVersions(probe.version,appVersion)??0)<0?probe.version:undefined;
  async function install() {
    if(!current || started.current===sessionId || !access.current())return;
    started.current=sessionId;setPhase({sessionId,state:'running'});
    try {
      await api.installCompanion(sessionId,()=>{});
      if(!mounted.current)return;
      setPhase({sessionId,state:'done'});setProbe({sessionId,version:appVersion,unix:true});
      window.dispatchEvent(new CustomEvent(companionUpdatedEvent,{detail:{sessionId}}));onInstalled();
    } catch {if(mounted.current)setPhase({sessionId,state:'failed'});}
  }
  useEffect(()=>{if(current && consent==='always')void install();},[current,consent,sessionId]);
  const choose=(choice:Consent|'later')=>{
    if(choice==='later'){setDeclined(sessionId);return;}
    writeConsent(host,choice);
    if(choice==='always')void install();
  };
  const here=phase?.sessionId===sessionId?phase.state:undefined;
  if(here==='running')return <p className="agent-note companion-update" role="status" aria-busy="true" data-update-state="running">{t('companionUpdateRunning',{version:appVersion})}</p>;
  if(here==='done')return <p className="agent-note companion-update" role="status" data-update-state="done">{t('companionUpdateDone',{version:appVersion})}</p>;
  if(here==='failed')return <p className="agent-note companion-update inline-error" role="alert" data-update-state="failed">{t('companionUpdateFailed',{version:appVersion,current:current??''})}</p>;
  if(!current || consent || declined===sessionId)return null;
  return <section className="agent-note companion-update-consent" aria-labelledby="companion-consent-title">
    <h4 id="companion-consent-title">{t('companionConsentTitle')}</h4>
    <p>{t('companionConsentBody',{current,version:appVersion})}</p>
    <div className="tool-bar">
      <button type="button" onClick={()=>choose('always')}>{t('companionConsentAlways')}</button>
      <button type="button" className="subtle-button" onClick={()=>choose('later')}>{t('companionConsentNotNow')}</button>
      <button type="button" className="subtle-button" onClick={()=>choose('never')}>{t('companionConsentNever')}</button>
    </div>
  </section>;
}

/** Lets the user take the remembered choice back: shown only while one exists. */
export function CompanionConsentSetting({host}:{host:string}) {
  useUi();const consent=useConsent(host);
  if(!consent)return null;
  return <label className="companion-consent-setting">{t('companionConsentSetting')}
    <select value={consent} onChange={event=>writeConsent(host,event.target.value==='ask'?undefined:event.target.value as Consent)}>
      <option value="ask">{t('companionConsentAsk')}</option>
      <option value="always">{t('companionConsentAlways')}</option>
      <option value="never">{t('companionConsentNever')}</option>
    </select>
  </label>;
}
