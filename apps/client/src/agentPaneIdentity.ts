import type {AgentSession} from './AgentPanel';

/** The companion writes this summary when an agent's session ends, so the pane no longer runs it. */
const SESSION_ENDED='Session ended';
/** `tmux:<label>` or `rmux:<label>` of the server a display is attached to, the form the companion records as `paneServer`. */
export const attachedPaneServer=(attached?:{kind:string;tmuxServer?:string}):string|undefined=>attached && (attached.kind==='tmux' || attached.kind==='rmux') ? `${attached.kind}:${attached.tmuxServer??'default'}` : undefined;
/** A report from a companion that records no server (an older one) belongs to the attached server; a report that names another server never does, whatever its pane id. */
export const onServer=(row:{paneServer?:string},server:string|undefined)=>row.paneServer===undefined || row.paneServer===server;
/** The agent a tmux pane runs: the newest companion hook report carrying that pane's `TMUX_PANE`, null when there is none or its session has ended. */
export function paneAgent(reports:readonly AgentSession[],pane:string,server?:string):string|null {
  const newest=reports.find(row=>row.paneId===pane && onServer(row,server));
  return newest&&newest.summary!==SESSION_ENDED?newest.agent:null;
}

/** The Zellij pane a hook report names: the companion writes `zellij:<session>:<pane>` for an agent that runs in a Zellij terminal pane. */
export function zellijPane(id:string|null|undefined):{session:string;pane:number}|undefined {
  const match=/^zellij:(.+):(\d{1,10})$/.exec(id ?? '');
  return match ? {session:match[1],pane:Number(match[2])} : undefined;
}

const herdrPane=/^herdr:([\w.-]{1,64}):(w[1-9A-HJKMNP-TV-Z0]+:p[1-9A-HJKMNP-TV-Z0]+)$/;
/** The Herdr pane a hook report names: `herdr:<session>:<pane id>`. */
export function herdrPaneOf(id:string|null|undefined):{session:string;pane:string}|undefined {
  const match=herdrPane.exec(id ?? '');
  return match && !/^\.{1,2}$/.test(match[1]) && match[2].length<=50 ? {session:match[1],pane:match[2]} : undefined;
}
/** The panes a companion hook can name, as the companion validates them: tmux `%7`, Zellij `zellij:<session>:<pane>` and Herdr `herdr:<session>:<pane id>`.
 * An approval is answered with this identity unchanged, so anything else is refused rather than shown. */
export function validPaneIdentity(id:string):boolean {
  if(herdrPane.test(id))return herdrPaneOf(id)!==undefined;
  const zellij=zellijPane(id);
  return /^%\d{1,31}$/.test(id) || (zellij!==undefined && zellij.session.length<=200 && !/[\x00-\x1f\x7f-\x9f]/.test(zellij.session));
}
