export const panelRawText='RAW $t(language) {{name}} <opaque> 中文';
export const panelTimestamp='2026-10-25T12:34:56.000Z';
export const panelSession={id:'locale-ssh',hostId:'host-locale',name:panelRawText,connected:true};
export const recordedTranscript={schemaVersion:1,agent:'claude',messages:[{id:panelRawText,role:'assistant',blocks:[{type:'text',text:panelRawText},{type:'tool_result',id:panelRawText,name:panelRawText,text:JSON.stringify({argument:panelRawText}),isError:true}]}],nextOffset:17,hasMore:false};
export const recordedUsage={schemaVersion:1,agent:'codex',scope:'transcript_window',observedAt:panelTimestamp,nextOffset:9,hasMore:false,samplesAvailable:1,samples:[{id:panelRawText,recordedAt:panelTimestamp,freshness:'fresh',inputTokens:12500,outputTokens:0,cacheReadTokens:null,cacheWriteTokens:null}],context:{usedTokens:null,limitTokens:null,remainingTokens:null},quota:{remaining:null,resetsAt:null},providerWindows:[{provider:'codex',accountId:null,limitId:panelRawText,kind:'primary',usedPercent:12.5,windowMinutes:1,resetsAt:null,recordedAt:panelTimestamp,freshness:'fresh'}]};

export const panelInboxRow={id:'a'.repeat(64),eventId:'b'.repeat(64),sessionId:panelSession.id,hostId:panelSession.hostId,hostName:panelRawText,agent:panelRawText,project:panelRawText,agentSessionId:panelRawText,state:'needs_attention',updatedAt:panelTimestamp,paneId:'%7'} as const;
