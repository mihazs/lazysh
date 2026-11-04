import {ChevronDown,ChevronUp,TerminalSquare} from 'lucide-react';
import {useId,useLayoutEffect,useRef,useState} from 'react';
import {formatNumber,t,useUi} from './i18n/core';
import type {LiveSession} from './terminal';

type Choice=Pick<LiveSession,'id'|'name'|'destination'|'connected'>;
export default function WorkspaceSessions({sessions,activeId,compact,visible,busy,onChoose}:{
  sessions:readonly Choice[];activeId:string|null;compact:boolean;visible:boolean;busy:boolean;onChoose:(id:string)=>void;
}) {
  useUi();
  const [expanded,setExpanded]=useState(false);
  const listId=useId(),list=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const connected=sessions.filter(session=>session.connected),selected=connected.find(session=>session.id===activeId);
  const single=connected.length===1?selected:undefined;
  const collapsed=!!single || (compact && connected.length>0 && !expanded);
  useLayoutEffect(()=>{
    if(visible && collapsed && list.current?.contains(document.activeElement))trigger.current?.focus();
  },[collapsed,visible]);
  return <section className="workspace-app-sessions" hidden={!visible}>
    {single?<button ref={trigger} type="button" className="workspace-current-session" title={`${t('navigationReturnTerminal')} · ${single.destination}`} disabled={busy} onClick={()=>onChoose(single.id)}><TerminalSquare size={16} aria-hidden="true"/><strong>{single.name}</strong></button>:compact && connected.length>0?<button ref={trigger} type="button" className="subtle-button workspace-session-summary" aria-expanded={expanded} aria-controls={listId} onClick={()=>setExpanded(value=>!value)}>
      <TerminalSquare size={17} aria-hidden="true"/><span><span>{t('navigationLiveSessions')} · {formatNumber(connected.length)}</span>{' '}{selected && <strong title={selected.name}>{selected.name}</strong>}</span>
      {expanded?<ChevronUp size={18} aria-hidden="true"/>:<ChevronDown size={18} aria-hidden="true"/>}
    </button>:<h3>{t('navigationLiveSessions')}</h3>}
    <div ref={list} id={listId} className="workspace-live-sessions" role="group" aria-label={t('navigationLiveSessions')} hidden={collapsed}>
      {connected.map(session=><button className="subtle-button" key={session.id} aria-current={activeId===session.id?'location':undefined} disabled={busy} onClick={()=>onChoose(session.id)}><strong>{session.name}</strong>{' '}<small>{session.destination}</small></button>)}
      {!connected.length && <p>{t('navigationNoSessions')}</p>}
    </div>
  </section>;
}
