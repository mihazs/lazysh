/** The Zellij pane a hook report names: the companion writes `zellij:<session>:<pane>` for an agent that runs in a Zellij terminal pane. */
export function zellijPane(id:string|null|undefined):{session:string;pane:number}|undefined {
  const match=/^zellij:(.+):(\d{1,10})$/.exec(id ?? '');
  return match ? {session:match[1],pane:Number(match[2])} : undefined;
}
