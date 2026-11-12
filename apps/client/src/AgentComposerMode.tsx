import {useEffect,useState,type ReactNode} from 'react';
import {ShieldCheck} from 'lucide-react';
import type {PermissionMode,TerminalControl} from './ChatTerminalInput';
import {t} from './i18n/core';

const names={default:'agentModeDefault',acceptEdits:'agentModeAcceptEdits',plan:'agentModePlan',auto:'agentModeAuto',bypassPermissions:'agentModeBypass'} as const;

/** Shift+Tab of the agent's TUI as a button. Each tap cycles the permission mode once and names the mode the agent's own
 * status line showed afterwards, so the note is a read-back and never a guess. `key` is the followed conversation. */
export function useModeSwitch(control:TerminalControl|undefined,offered:boolean,key:string):{button?:ReactNode;note?:ReactNode} {
  const [mode,setMode]=useState<PermissionMode>();
  const [pending,setPending]=useState(false);
  useEffect(()=>setMode(undefined),[key]);
  if(!offered || !control?.ready)return {};
  const label=t('agentModeSwitch');
  return {
    button:<button type="button" className="icon-button" disabled={control.busy || pending} aria-label={label} title={label}
      onClick={()=>{setPending(true);void control.cycleMode().then(landed=>{if(landed)setMode(landed);}).finally(()=>setPending(false));}}><ShieldCheck size={18} aria-hidden="true"/></button>,
    note:mode && <p role="status" className="agent-composer-note">{mode==='unconfirmed'?t('agentModeUnconfirmed'):t('agentModeNow',{mode:t(names[mode])})}</p>,
  };
}
