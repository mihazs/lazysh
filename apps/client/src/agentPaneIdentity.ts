/** The Zellij pane a hook report names: the companion writes `zellij:<session>:<pane>` for an agent that runs in a Zellij terminal pane. */
export function zellijPane(id:string|null|undefined):{session:string;pane:number}|undefined {
  const match=/^zellij:(.+):(\d{1,10})$/.exec(id ?? '');
  return match ? {session:match[1],pane:Number(match[2])} : undefined;
}

const herdrPane=/^herdr:([\w.-]{1,64}):(w[1-9A-HJKMNP-TV-Z0]+:p[1-9A-HJKMNP-TV-Z0]+)$/;
/** The panes a companion hook can name, as the companion validates them: tmux `%7`, Zellij `zellij:<session>:<pane>` and Herdr `herdr:<session>:<pane id>`.
 * An approval is answered with this identity unchanged, so anything else is refused rather than shown. */
export function validPaneIdentity(id:string):boolean {
  const herdr=herdrPane.exec(id);
  if(herdr)return !/^\.{1,2}$/.test(herdr[1]) && herdr[2].length<=50;
  const zellij=zellijPane(id);
  return /^%\d{1,31}$/.test(id) || (zellij!==undefined && zellij.session.length<=200 && !/[\x00-\x1f\x7f-\x9f]/.test(zellij.session));
}
