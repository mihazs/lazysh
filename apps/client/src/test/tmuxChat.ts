import type {TranscriptAgentId} from '../transcriptSources';
/** Synthetic retained terminal replies; no tmux, provider or remote process runs. */
export const tmuxChatSource={agent:'claude',path:'/records/世界.jsonl',view:'records',inlineImages:false} as const;
export const tmuxChatTarget={generation:'12345678-1234-4234-8234-123456789abc',sessionId:'$1',windowId:'@2',paneId:'%3'};
export const tmuxChatReceipt='22345678-1234-4234-8234-123456789abc';
export const tmuxChatSnapshot={kind:'destination',destination:tmuxChatTarget,sessionName:'Agent work',windowName:'Claude workspace',paneIndex:3};
export const tmuxChatBound={kind:'bound',receipt:tmuxChatReceipt,destination:tmuxChatTarget,nextOperation:1};
/** The mode a `cycle_mode` input reads back; tests set it to play a status line the profile does or does not recognise. */
export const tmuxChatMode={landed:'plan'};
export function tmuxChatReply(_command:string,args:unknown) {
  const action=(args as {action:{kind:string;operation?:number;input?:{kind:string}}}).action;
  const delivered={kind:'delivered',nextOperation:action.operation!+1};
  return Promise.resolve(action.kind==='snapshot'?tmuxChatSnapshot:action.kind==='bind'?tmuxChatBound:action.kind==='release'?{kind:'released'}:action.input?.kind==='cycle_mode'?{...delivered,mode:tmuxChatMode.landed}:delivered);
}

export function tmuxChatReaderSource(agent:TranscriptAgentId,selector='database-session') {
  // Gemini CLI has only a conversation view.
  return agent==='hermes'||agent==='opencode'?{...tmuxChatSource,agent,transcriptSessionId:selector}:{...tmuxChatSource,agent,...(agent==='gemini'?{view:'conversation' as const}:{})};
}
export function tmuxChatReaderPage(agent:TranscriptAgentId) {
  return {schemaVersion:1,agent,messages:[],nextOffset:0,hasMore:false,
    ...(['grok-acp','antigravity-jsonl'].includes(agent)?{view:'record_stream'}:{}),
    ...(agent==='gemini'?{view:'active_branch',truncated:false}:{}),
    ...(agent==='antigravity-jsonl'?{checkpoint:`v1:0:${'a'.repeat(64)}`}:{})};
}
