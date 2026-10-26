import {agentApproval} from './agentBoardData';
export const appleStatusSession='b11c6ca6-e4f7-4f63-859c-d08e66df2239';
export const appleStatusNativeReason='appleStatusCapabilityUnavailable {{reason}} <native> 中文';
export const appleStatusCapability={liveActivities:true,watchPaired:true,watchInstalled:true,watchReachable:true,reason:appleStatusNativeReason};
export function appleStatusInputs(now=Date.now()) {
  const record={sessionId:appleStatusSession,agent:'claude',project:'/private/never-publish',summary:'SECRET_PROMPT_NEVER_PUBLISH',paneId:'%7',eventCount:1};
  return {
    activity:{schemaVersion:1,sessions:[{...record,state:'working',updatedAt:new Date(now).toISOString()},{...record,state:'needs_attention',updatedAt:new Date(now-61_000).toISOString()}]},
    approvals:{schemaVersion:1,requests:[agentApproval(new Date(now+30_000).toISOString())]},
    usage:{inputTokens:120,outputTokens:0,cacheReadTokens:null,cacheWriteTokens:null,recordedAt:new Date(now-14*60_000).toISOString(),freshness:'fresh' as const,observedAt:new Date(now).toISOString(),receivedAt:now-2*60_000},
  };
}
export const appleStatusLocales=[
  {locale:'en',title:'Apple status',start:'Start Live Activity',watch:'Enable Watch status',stop:'Stop Apple status',missing:'Watch companion not installed.',unreachable:'Watch unavailable; cached status expires.',capability:'Apple status capability unavailable.',stopFailed:'Could not clear native status. Existing snapshots expire within 60 seconds.'},
  {locale:'pt-BR',title:'Status Apple',start:'Iniciar Atividade ao Vivo',watch:'Ativar status no Watch',stop:'Parar status Apple',missing:'Aplicativo complementar do Watch não instalado.',unreachable:'Watch indisponível; o status em cache expira.',capability:'Recurso de status Apple indisponível.',stopFailed:'Não foi possível limpar o status nativo. Os registros existentes expiram em até 60 segundos.'},
  {locale:'es',title:'Estado de Apple',start:'Iniciar Actividad en Vivo',watch:'Activar estado en el Watch',stop:'Detener estado Apple',missing:'Aplicación complementaria del Watch no instalada.',unreachable:'Watch no disponible; el estado en caché caduca.',capability:'La función de estado Apple no está disponible.',stopFailed:'No se pudo borrar el estado nativo. Los registros existentes caducan en un máximo de 60 segundos.'},
] as const;
