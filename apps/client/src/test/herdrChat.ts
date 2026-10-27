/** Synthetic native guarded-Herdr replies; no remote server or process runs. */
export const herdrCandidate='32345678-1234-4234-8234-123456789abc';
export const herdrReceipt='42345678-1234-4234-8234-123456789abc';
export const herdrTarget={workspace:'workspace 世界',tab:'tab $(literal)',pane:'pane-one',terminal:'terminal-original',runtimeGeneration:'18446744073709551615',viewport:{x:0,y:1,width:80,height:24}};
export const herdrPrepared={kind:'prepared',candidate:herdrCandidate,destination:herdrTarget};
export const herdrBound={kind:'bound',receipt:herdrReceipt,destination:herdrTarget,nextOperation:1};
export function herdrChatReply(_command:string,args:unknown) {
  const action=(args as {action:{kind:string;operation?:number}}).action;
  return Promise.resolve(action.kind==='status'?{kind:'status',available:true}:action.kind==='prepare'?herdrPrepared:action.kind==='confirm'?herdrBound:action.kind==='release'?{kind:'released'}:{kind:'delivered',nextOperation:action.operation!+1});
}
