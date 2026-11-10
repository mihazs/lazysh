import {parseAgentTool,type AgentTool} from './AgentToolCard';
import {parseCard,type Card} from './ChatInteraction';
import {LocalUiError} from './i18n/localError';

const invalid=()=>new LocalUiError('chatUnsupportedResponse');
function record(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const result=value as Record<string,unknown>;
  if (required.some(key=>!Object.hasOwn(result,key)) || Object.keys(result).some(key=>!required.includes(key) && !optional.includes(key))) throw invalid();
  return result;
}
function card(tool:AgentTool,agent:string):Card|undefined {
  const call=tool.call;
  if(call?.kind==='plan') return parseCard({kind:'plan',entries:call.items.map(item=>({text:item.text,status:item.state==='done'?'completed':item.state}))},{agent,view:'active_branch',type:'tool_use'});
  if(call?.kind==='question') return parseCard({kind:'question',questions:call.questions.map(question=>({question:question.text,multiple:question.multiple,options:question.options,...(question.header===undefined?{}:{header:question.header})}))},{agent,view:'active_branch',type:'tool_use'});
  return undefined;
}

/** Validate a schema 2 snapshot before adapting it to the existing timeline model. */
export function schemaTwoPage(value:unknown):unknown {
  const page=record(value,['schemaVersion','view','agent','messages','nextOffset','hasMore','truncated'],['branchId','activity','historicalActivity']);
  if (page.schemaVersion === 3) {
    const history=record(page.historicalActivity,['version','events','truncated']);
    if(page.agent!=='codex' || history.version!==1 || typeof history.truncated!=='boolean' || !Array.isArray(history.events) || history.events.length>50 || history.events.some(event=>!['started','interacted','completed','interrupted'].includes(event))) throw invalid();
  } else if (page.historicalActivity!==undefined) throw invalid();
  if(![2,3].includes(page.schemaVersion as number) || page.view!=='active_branch' || !['claude','codex'].includes(page.agent as string)
    || !Number.isSafeInteger(page.nextOffset) || (page.nextOffset as number)<0 || page.hasMore!==false || typeof page.truncated!=='boolean'
    || (page.branchId!==undefined && (typeof page.branchId!=='string' || page.branchId.length>4096))
    || !Array.isArray(page.messages) || page.messages.length>100) throw invalid();
  const ids=new Set<string>();
  const messages=page.messages.map(value=>{
    const message=record(value,['id','rev','role','source','parts'],['partial','timestamp','usage','parentId']);
    if(typeof message.id!=='string' || !message.id || message.id.length>4096 || ids.has(message.id)
      || !Number.isSafeInteger(message.rev) || (message.rev as number)<0 || message.source!=='transcript'
      || !['user','assistant','note'].includes(message.role as string) || (message.partial!==undefined && typeof message.partial!=='boolean')
      || (message.parentId!==undefined && (typeof message.parentId!=='string' || message.parentId.length>4096))
      || (message.timestamp!==undefined && (typeof message.timestamp!=='string' || message.timestamp.length>256))
      || !Array.isArray(message.parts) || message.parts.length>1000) throw invalid();
    ids.add(message.id);
    const blocks=message.parts.map(value=>{
      const part=record(value,['type'],['text','card','name','summary','status','input','result','call']);
      if(part.type==='tool') {
        const {card:recordedCard,...toolPart}=part;
        const tool=parseAgentTool(toolPart);if(!tool)throw invalid();
        if(recordedCard!==undefined && (page.agent!=='claude' || tool.name!=='ExitPlanMode' || tool.call!==undefined))throw invalid();
        const proposed=recordedCard===undefined?undefined:parseCard(recordedCard,{agent:'claude',view:'active_branch',type:'tool_use'});
        if(proposed && proposed.kind!=='proposed_plan')throw invalid();
        return {type:'tool_use',name:tool.name,text:tool.input ?? '',agentTool:tool,card:proposed ?? card(tool,page.agent as string)};
      }
      if(!['text','thinking','image'].includes(part.type as string) || Object.keys(part).some(key=>!['type','text','card'].includes(key))
        || (part.text!==undefined && (typeof part.text!=='string' || part.text.length>262144))) throw invalid();
      if(part.type==='text' && part.card!==undefined && page.agent==='claude') {
        if(message.partial!==true || typeof part.text!=='string')throw invalid();
        const name=part.text.startsWith('ExitPlanMode: ')?'ExitPlanMode':part.text.startsWith('AskUserQuestion: ')?'AskUserQuestion':undefined;
        const recorded=parseCard(part.card,{agent:'claude',view:'active_branch',type:'tool_use'});
        if(!name || (name==='ExitPlanMode' ? recorded.kind!=='proposed_plan' : recorded.kind!=='question'))throw invalid();
        return {type:'tool_use',name,text:part.text,card:recorded,unmatched:true};
      }
      return part;
    });
    return {id:message.id,role:message.role==='note'?'tool':message.role,blocks,...(message.partial===undefined?{}:{partial:message.partial}),...(message.timestamp===undefined?{}:{timestamp:message.timestamp}),...(message.usage===undefined?{}:{usage:message.usage})};
  });
  return {...page,schemaVersion:1,messages};
}
