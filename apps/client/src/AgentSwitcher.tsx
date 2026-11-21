import {useEffect,useId,useRef,useState} from 'react';
import {Check,ChevronDown} from 'lucide-react';
import {t} from './i18n/core';
import {herdrStatusKeys,type LiveAgent} from './useHerdrNavigation';
import {StatusRing,herdrTones} from './AgentStatus';
import {pathBasename} from './relativeTime';
import {agentSwitchHint} from './keyboard';

const nameOf=(row:LiveAgent)=>row.name??row.agent??row.pane_id;

/** Header control: the agent shown now, opening a list of the live agents; one tap on a row switches to it. `open` lets a shortcut open it. */
export default function AgentSwitcher({rows,current,open,onOpenChange,onSwitch}:{rows:LiveAgent[];current?:string;open:boolean;onOpenChange:(open:boolean)=>void;onSwitch:(row:LiveAgent)=>void}) {
  const listId=useId(),trigger=useRef<HTMLButtonElement>(null),list=useRef<HTMLDivElement>(null);
  const [wasOpen,setWasOpen]=useState(false);
  const shown=rows.find(row=>row.pane_id===current);
  useEffect(()=>{
    if(open)(list.current?.querySelector<HTMLElement>('[aria-current="true"]')??list.current?.querySelector<HTMLElement>('button'))?.focus();
    else if(wasOpen)trigger.current?.focus();
    setWasOpen(open);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open]);
  const hint=agentSwitchHint();
  return <>
    <button ref={trigger} type="button" className="agent-switch-trigger" aria-label={shown?`${t('agentSwitchLabel')}: ${nameOf(shown)}`:t('agentSwitchLabel')} aria-expanded={open} aria-controls={open?listId:undefined} aria-keyshortcuts={hint.keys}
      title={`${t('agentSwitchLabel')} (${hint.label})`} onClick={()=>onOpenChange(!open)}>
      {shown && <StatusRing tone={herdrTones[shown.agent_status]}/>}
      <span>{shown?nameOf(shown):t('agentSwitchLabel')}</span><ChevronDown size={16} aria-hidden="true"/>
    </button>
    {open && <div ref={list} id={listId} className="agent-switch-list" role="group" aria-label={t('agentSwitchLabel')}
      onKeyDown={event=>{
        if(event.key==='Escape'){event.stopPropagation();onOpenChange(false);return;}
        if(event.key!=='ArrowDown' && event.key!=='ArrowUp')return;
        const items=[...event.currentTarget.querySelectorAll<HTMLElement>('button')],at=items.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();items[(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
      }}>
      {rows.map(row=>{
        const isCurrent=row.pane_id===current;
        return <button type="button" key={`${row.terminal_id}:${row.pane_id}`} aria-current={isCurrent?'true':undefined} onClick={()=>{onOpenChange(false);if(!isCurrent)onSwitch(row);}}>
          <StatusRing tone={herdrTones[row.agent_status]}/>
          <span className="agent-switch-name"><strong>{nameOf(row)}</strong><small>{[t(herdrStatusKeys[row.agent_status]),row.cwd&&pathBasename(row.cwd)].filter(Boolean).join(' · ')}</small></span>
          {isCurrent && <Check size={16} aria-hidden="true"/>}
        </button>;
      })}
    </div>}
  </>;
}
