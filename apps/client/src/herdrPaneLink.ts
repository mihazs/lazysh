import {reportedSessionCounts} from './HerdrSessionDetails';
import type {LiveAgent,ReportedSessionRef,useHerdrNavigation} from './useHerdrNavigation';

type Data=NonNullable<ReturnType<typeof useHerdrNavigation>['data']>;
export type LinkedAgent=LiveAgent&{agent_session:ReportedSessionRef};
export type FocusedPane={
  /** Identity of the focused pane; it changes when focus moves to another pane, tab or workspace. */
  key:string;
  /** The live agent Herdr detects in that pane, if any. */
  agent?:LiveAgent;
  /** Set when Herdr reports exactly one Claude Code or Codex conversation for that agent. */
  link?:LinkedAgent;
  /** Workspace and tab names, for a compact "where" label. */
  place:string;
};

/** The pane Herdr reports as focused on the attached server (stock 0.9.3 included: `panes[].focused` is true only for
 * the active workspace, its active tab and that tab's focused pane), and what runs in it. Undefined until a read succeeded. */
export function focusedPane(data:Data|null|undefined):FocusedPane|undefined {
  if(!data?.loaded || !data.server)return;
  const pane=data.snapshot?.panes.find(item=>item.focused);
  const agent=pane && data.rows.find(row=>row.pane_id===pane.pane_id && row.terminal_id===pane.terminal_id);
  const reference=agent?.agent_session;
  // Two live panes naming the same session cannot both own it, so neither is linked.
  const unique=!!reference && reference.agent!=='opencode' && reportedSessionCounts(data.rows).get(JSON.stringify([reference.agent,reference.value]))===1;
  const place=pane?[data.snapshot?.workspaces.find(item=>item.workspace_id===pane.workspace_id)?.label??pane.workspace_id,data.snapshot?.tabs.find(item=>item.tab_id===pane.tab_id)?.label??pane.tab_id].join(' · '):'';
  return {key:pane?JSON.stringify([pane.workspace_id,pane.tab_id,pane.pane_id,pane.terminal_id]):'',agent,link:agent && reference && unique?{...agent,agent_session:reference}:undefined,place};
}
