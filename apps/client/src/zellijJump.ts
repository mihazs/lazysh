import type {TmuxJumpSnapshot} from './bridge';

/** `zellij_tree`'s answer: each tab by its stable id, with the terminal panes it holds. */
export type ZellijTree={tabs:{id:number;position:number;name:string;active:boolean;panes:{id:number;title:string;focused:boolean}[]}[]};

/**
 * Jump To's snapshot of one Zellij session: its tabs as the windows of a single session, numbered from 1 like the tab strip.
 * The first active tab is the one current row (Zellij briefly flags the tab it leaves as well), and none when no client shows one.
 */
export function zellijSnapshot(name:string,{tabs}:ZellijTree):TmuxJumpSnapshot {
  const active=tabs.find(tab=>tab.active);
  return {
    generation:'',
    current:{sessionId:name,windowId:active ? String(active.id) : ''},
    sessions:[{id:name,name,restoreName:name,windows:tabs.map(tab=>({id:String(tab.id),index:tab.position+1,name:tab.name}))}],
  };
}
