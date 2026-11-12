import type {HerdrNavigationTarget,MultiplexerKind,TmuxJumpSnapshot} from './bridge';
import {LocalUiError} from './i18n/localError';
import type {HerdrTree,LiveAgent} from './useHerdrNavigation';

/** What a chip selects, in the terms of the multiplexer's own guarded command. */
export type MuxRef=
  | {kind:'herdr';target:HerdrNavigationTarget}
  | {kind:'zellij';index:number}
  | {kind:'tmux';session:string;window:string;generation:string};
/** One chip. `attention` is an agent waiting for input; `state` is the agent state Herdr reports, absent for tmux and Zellij. */
export type MuxTab={id:string;title:string;active:boolean;attention:boolean;state?:LiveAgent['agent_status'];ref:MuxRef};
/** The strip's leading chip: Herdr's workspace (with the other workspaces to switch to) or the tmux/Zellij session name. */
export type MuxStrip={kind:MultiplexerKind;group:{title:string;state?:LiveAgent['agent_status'];attention:boolean;choices:MuxTab[]};tabs:MuxTab[]};
export type ZellijTabRow={position:number;name:string;active:boolean};

const waiting=(state:LiveAgent['agent_status'])=>state==='blocked';

/** Herdr: the focused workspace's tabs, and every workspace as a choice of the leading chip. */
export function herdrStrip(tree:HerdrTree):MuxStrip|undefined {
  const workspace=tree.workspaces.find(item=>item.focused)??tree.workspaces[0];
  if(!workspace)return;
  const choices=tree.workspaces.map(item=>({id:item.workspace_id,title:item.label,active:item.workspace_id===workspace.workspace_id,attention:waiting(item.agent_status),state:item.agent_status,
    ref:{kind:'herdr',target:{kind:'workspace',workspace:item.workspace_id}} as const}));
  const tabs=tree.tabs.filter(tab=>tab.workspace_id===workspace.workspace_id).sort((a,b)=>a.number-b.number).map(tab=>({id:tab.tab_id,title:tab.label,active:tab.focused,attention:waiting(tab.agent_status),state:tab.agent_status,
    ref:{kind:'herdr',target:{kind:'tab',workspace:tab.workspace_id,tab:tab.tab_id}} as const}));
  // A workspace elsewhere that needs attention is visible from here, on the leading chip.
  return {kind:'herdr',group:{title:workspace.label,state:workspace.agent_status,attention:choices.some(item=>!item.active && item.attention),choices},tabs};
}
/** Zellij: the session name and its tabs; a tab is selected by its 1-based position. */
export function zellijStrip(session:string,rows:ZellijTabRow[]):MuxStrip {
  const tabs=[...rows].sort((a,b)=>a.position-b.position).map(row=>({id:String(row.position),title:row.name||String(row.position+1),active:row.active,attention:false,ref:{kind:'zellij',index:row.position+1} as const}));
  return {kind:'zellij',group:{title:session,attention:false,choices:[]},tabs};
}
/** tmux: the windows of the session the terminal is attached to. */
export function tmuxStrip(snapshot:TmuxJumpSnapshot):MuxStrip|undefined {
  const session=snapshot.sessions.find(item=>item.id===snapshot.current.sessionId);
  if(!session)return;
  const tabs=[...session.windows].sort((a,b)=>a.index-b.index).map(window=>({id:window.id,title:window.name,active:window.id===snapshot.current.windowId,attention:false,
    ref:{kind:'tmux',session:session.id,window:window.id,generation:snapshot.generation} as const}));
  return {kind:'tmux',group:{title:session.name,attention:false,choices:[]},tabs};
}

/**
 * The guarded Herdr command for `target`, checked against a fresh tree: a workspace, tab or pane that has gone since the user last saw it
 * is refused, never focused by guess. One reader serves the navigation sheet and the tab strip.
 */
export function herdrFocusAction(snapshot:HerdrTree,target:HerdrNavigationTarget) {
  const workspace=snapshot.workspaces.find(row=>row.workspace_id===target.workspace);
  const tab=target.kind==='workspace'?undefined:snapshot.tabs.find(row=>row.workspace_id===target.workspace && row.tab_id===target.tab);
  const pane=target.kind!=='pane'?undefined:snapshot.panes.find(row=>row.workspace_id===target.workspace && row.tab_id===target.tab && row.pane_id===target.pane && row.terminal_id===target.terminal);
  if(!workspace || (target.kind!=='workspace' && !tab) || (target.kind==='pane' && !pane))throw new LocalUiError('herdrNavigationChanged');
  return target.kind==='workspace'?{type:'focusWorkspace',target:target.workspace}:target.kind==='tab'?{type:'focusTab',target:target.tab}:{type:'focusPane',target:target.pane};
}
