import {useEffect,useState} from 'react';
import {t,useUi} from './i18n/core';
import {useProtectedInvoke} from './access';
import {onAgentsRefresh,refreshAgents} from './agentsRefresh';
import {parseSnapshot} from './AgentPanel';
import {setKeepAwakeSlot} from './keepAwakeSlot';
import CompanionInstallPanel from './CompanionInstallPanel';
import CompanionHooksPanel from './CompanionHooksPanel';
import CompanionSettingsPanel from './CompanionSettingsPanel';
import {chooseHerdrServer,useHerdrNavigation} from './useHerdrNavigation';

/** The Live agents server: the picker the Agents page used to open behind its sliders button. */
function HerdrServerSetting({sessionId,herdrSession,onServerChange}:{sessionId:string;herdrSession?:string;onServerChange?:()=>void}) {
  const {data,busy}=useHerdrNavigation({sessionId,herdrSession,visible:true,intervalMs:30000});
  if(!data)return null;
  if(!data.servers.length)return <p>{t('herdrAgentsNoServers')}</p>;
  return <label>{t('herdrAgentsServer')}<select value={data.server} disabled={busy} onChange={event=>{onServerChange?.();chooseHerdrServer(sessionId,event.target.value);}}>
    <option value="">{t('herdrAgentsChoose')}</option>{data.servers.map(name=><option key={name}>{name}</option>)}
  </select></label>;
}

/**
 * Settings > Agents for the connected session: everything the Agents page's setup (sliders) button
 * opened, for Live agents (the Herdr server) and Activity (keep awake and the host companion),
 * plus the refresh action that pull-to-refresh stands in for on the page.
 */
export default function AgentSetupSettings({sessionId,herdrSession,reveal,onServerChange}:{sessionId:string;herdrSession?:string;reveal?:Readonly<{sessionId:string}>;onServerChange?:()=>void}) {
  useUi();
  const invoke=useProtectedInvoke();
  // The dialog that hosts Settings moves focus after its content mounts; revealing waits for that, so the hook summary keeps focus.
  const [placed,setPlaced]=useState(false);
  useEffect(()=>setPlaced(true),[]);
  /** The host whose companion last answered a snapshot, so Update replaces Install and its own settings can be read. */
  const [reporting,setReporting]=useState<string>();
  const ready=reporting===sessionId;
  useEffect(()=>{
    let current=true;
    const check=()=>void invoke('agent_snapshot',{sessionId}).then(parseSnapshot).then(()=>current&&setReporting(sessionId),()=>current&&setReporting(undefined));
    check();
    const off=onAgentsRefresh(check);
    return()=>{current=false;off();};
  },[invoke,sessionId]);
  return <>
    <p>{t('settingsAgentsHint')}</p>
    <HerdrServerSetting sessionId={sessionId} herdrSession={herdrSession} onServerChange={onServerChange}/>
    <button type="button" onClick={()=>refreshAgents()}>{t('settingsAgentsRefresh')}</button>
    <div ref={setKeepAwakeSlot}/>
    <CompanionInstallPanel sessionId={sessionId} ready={ready} onInstalled={()=>refreshAgents(true)}/>
    <CompanionHooksPanel sessionId={sessionId} visible reveal={placed?reveal:undefined}/>
    {ready && <CompanionSettingsPanel key={sessionId} sessionId={sessionId}/>}
  </>;
}
