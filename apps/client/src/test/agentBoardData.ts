/** Synthetic reported context. Hash/nonce-looking values below are fixture data only. */
export const agentBoardSession='ssh:agent-locale';
export const agentBoardRecord={sessionId:'raw-agent-session',agent:'Agent {{name}}',project:'/raw/project <literal>',state:'needs_attention',updatedAt:'2026-10-25T12:34:56.000Z',summary:'Raw agent prompt {{name}} <img src=secret>',paneId:'%7',eventCount:12500};
export const companionSettings={schemaVersion:1 as const,revision:7,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
export function agentApproval(expiresAt=new Date(Date.now()+600000).toISOString()) {
  return {id:'b714333f-82b1-4ee0-a383-6fd6dc1eca01',expectedHash:'a'.repeat(64),agent:agentBoardRecord.agent,sessionId:agentBoardRecord.sessionId,project:agentBoardRecord.project,paneId:agentBoardRecord.paneId,toolName:'Bash {{tool}}',toolInput:{command:'printf "$TOKEN"',prompt:'Raw {{prompt}} <img src=secret>'},createdAt:agentBoardRecord.updatedAt,expiresAt};
}
export const inactiveBoardDisplay={available:false,active:false,reason:'Synthetic native display unavailable',epoch:'0/11111111-1111-4111-8111-111111111111',ticket:1};
