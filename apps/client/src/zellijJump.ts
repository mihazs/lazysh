import type {TmuxJumpSnapshot} from './bridge';

/** `zellij_jump_tabs`' answer: the tabs (a tab without a stable id cannot be a destination) and how many clients are attached. */
export type ZellijJumpTabs={tabs:{id?:number;position:number;name:string;active:boolean}[];clients:number};

/**
 * Jump To's snapshot of one Zellij session: its tabs as the windows of a single session, numbered from 1 like the tab strip.
 * Zellij cannot address a client from the command line, so a tab is current, and a jump allowed, only while this terminal is the
 * one client attached (#2046); with more, no row claims to be current and the panel offers no jump.
 */
export function zellijSnapshot(name:string,{tabs,clients}:ZellijJumpTabs):TmuxJumpSnapshot {
  const alone=clients===1;
  const active=alone ? tabs.find(tab=>tab.active && tab.id!==undefined) : undefined;
  return {
    generation:'',
    current:{sessionId:name,windowId:active?.id!==undefined ? String(active.id) : ''},
    ...(alone ? {} : {sharedClients:true as const}),
    sessions:[{id:name,name,restoreName:name,windows:tabs.flatMap(tab=>tab.id===undefined ? [] : [{id:String(tab.id),index:tab.position+1,name:tab.name}])}],
  };
}
