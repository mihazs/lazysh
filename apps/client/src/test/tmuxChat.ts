/** Synthetic retained terminal replies; no tmux, provider or remote process runs. */
export const tmuxChatSource={agent:'claude',path:'/records/世界.jsonl',view:'records',inlineImages:false} as const;
export const tmuxChatTarget={generation:'12345678-1234-4234-8234-123456789abc',sessionId:'$1',windowId:'@2',paneId:'%3'};
export const tmuxChatReceipt='22345678-1234-4234-8234-123456789abc';
export const tmuxChatSnapshot={kind:'destination',destination:tmuxChatTarget,sessionName:'Agent work',windowName:'Claude workspace',paneIndex:3};
export const tmuxChatBound={kind:'bound',receipt:tmuxChatReceipt,destination:tmuxChatTarget,nextOperation:1};
export function tmuxChatReply(_command:string,args:unknown) {
  const action=(args as {action:{kind:string;operation?:number}}).action;
  return Promise.resolve(action.kind==='snapshot'?tmuxChatSnapshot:action.kind==='bind'?tmuxChatBound:action.kind==='release'?{kind:'released'}:{kind:'delivered',nextOperation:action.operation!+1});
}
