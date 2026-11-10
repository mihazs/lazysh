import {t,useUi} from './i18n/core';

type Status = 'running' | 'ok' | 'error' | 'denied';
type Edit = {kind:'edit';path:string;added:number;removed:number;hunks:string[];created:boolean;movePath?:string};
type Execute = {kind:'execute';command:string;exitCode?:number;background?:boolean};
type Generic = {kind:'read';path:string} | {kind:'search';query:string} | {kind:'fetch';url:string}
  | {kind:'task';agent:string;agentId:string;ongoing:boolean} | {kind:'other'}
  | {kind:'plan';items:{text:string;state:'pending'|'in_progress'|'done'|'cancelled'}[]}
  | {kind:'question';questions:{text:string;header?:string;multiple:boolean;options:{label:string;description?:string}[]}[]};
export type AgentTool = {name:string;summary:string;status:Status;input?:string;result?:string;call?:Edit | Execute | Generic};

const string = (value:unknown, max:number):value is string => typeof value === 'string' && value.length <= max;
const count = (value:unknown):value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 262144;
const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value:Record<string,unknown>, allowed:string[]) => Object.keys(value).every(key=>allowed.includes(key));

/** Strictly parse the currently recorded schema 2 tool shapes. */
export function parseAgentTool(value:unknown):AgentTool | null {
  if (!object(value) || !keys(value,['type','name','summary','status','input','result','call']) || value.type !== 'tool' || !string(value.name,4096) || !value.name
    || !string(value.summary,4096) || !['running','ok','error','denied'].includes(value.status as string)
    || (value.input !== undefined && !string(value.input,262144))
    || (value.result !== undefined && !string(value.result,262144))) return null;
  if (value.call === undefined) return value as unknown as AgentTool;
  if (!object(value.call)) return null;
  const call=value.call;
  if (call.kind === 'edit') {
    if (!keys(call,['kind','path','added','removed','hunks','created','movePath']) || !string(call.path,4096) || !call.path || /[\x00-\x1f\x7f-\x9f]/.test(call.path)
      || !count(call.added) || !count(call.removed) || typeof call.created !== 'boolean'
      || !Array.isArray(call.hunks) || call.hunks.length > 1000 || call.hunks.some(hunk=>!string(hunk,262144))
      || (call.movePath !== undefined && (!string(call.movePath,4096) || !call.movePath || /[\x00-\x1f\x7f-\x9f]/.test(call.movePath)))) return null;
  } else if (call.kind === 'execute') {
    if (!keys(call,['kind','command','exitCode','background']) || !string(call.command,262144) || (call.exitCode !== undefined && (!Number.isInteger(call.exitCode) || (call.exitCode as number) < -2147483648 || (call.exitCode as number) > 2147483647))
      || (call.background !== undefined && typeof call.background !== 'boolean')) return null;
  } else if (call.kind === 'read' || call.kind === 'search' || call.kind === 'fetch') {
    const field=call.kind === 'read' ? 'path' : call.kind === 'search' ? 'query' : 'url';
    if (!keys(call,['kind',field]) || !string(call[field],16384)) return null;
  } else if (call.kind === 'task') {
    if (!keys(call,['kind','agent','agentId','ongoing']) || !string(call.agent,4096) || !call.agent
      || !string(call.agentId,4096) || !call.agentId || typeof call.ongoing !== 'boolean') return null;
  } else if (call.kind === 'other') {
    if (!keys(call,['kind'])) return null;
  } else if (call.kind === 'plan') {
    if (!keys(call,['kind','items']) || !Array.isArray(call.items) || !call.items.length || call.items.length > 100
      || call.items.some(item=>!object(item) || !keys(item,['text','state']) || !string(item.text,16384) || !item.text.trim()
        || !['pending','in_progress','done','cancelled'].includes(item.state as string))) return null;
  } else if (call.kind === 'question') {
    if (!keys(call,['kind','questions']) || !Array.isArray(call.questions) || !call.questions.length || call.questions.length > 20
      || call.questions.some(question=>!object(question) || !keys(question,['text','header','multiple','options'])
        || !string(question.text,16384) || !question.text.trim() || (question.header !== undefined && (!string(question.header,16384) || !question.header.trim()))
        || typeof question.multiple !== 'boolean' || !Array.isArray(question.options) || question.options.length > 20
        || question.options.some(option=>!object(option) || !keys(option,['label','description']) || !string(option.label,16384) || !option.label.trim()
          || (option.description !== undefined && (!string(option.description,16384) || !option.description.trim()))))) return null;
  } else return null;
  return value as unknown as AgentTool;
}

/** A recorded receipt; opening it never executes a command or applies a diff. */
export default function AgentToolCard({tool}:{tool:AgentTool}) {
  useUi();
  const call=tool.call;
  const detail=call?.kind==='execute' ? call.command : call?.kind==='read' ? call.path : call?.kind==='search' ? call.query : call?.kind==='fetch' ? call.url : call?.kind==='task' ? call.agent : '';
  const text=Array.from(detail.replace(/[\x00-\x1f\x7f-\x9f\s]+/g,' ').trim());
  const short=text.slice(0,160).join('')+(text.length>160?'…':'');
  const status=t(call?.kind==='execute' && call.background && tool.status==='ok' ? 'agentToolBackground' : ({running:'agentToolRunning',ok:'agentToolOk',error:'agentToolError',denied:'agentToolDenied'} as const)[tool.status]);
  return <details className="agent-tool-card">
    <summary>{call?.kind === 'edit' ? <>{call.path} {call.movePath && <>→ {call.movePath} </>}<span>+{call.added} −{call.removed}</span></> : <>{tool.summary}{short && ` · ${short}`}</>} · {status}</summary>
    {call?.kind === 'edit' ? call.hunks.map((hunk,index)=><pre key={index}>{hunk}</pre>) : call?.kind === 'execute' ? <>
      <pre>{call.command}</pre>
      {call.exitCode !== undefined && <p>{t('chatExitCode',{code:call.exitCode})}</p>}
    </> : tool.input && <pre>{tool.input}</pre>}
    {tool.input && (call?.kind==='edit' || call?.kind==='execute' && tool.input!==call.command) && <details><summary>{t('agentToolRecordedInput')}</summary><pre>{tool.input}</pre></details>}
    {tool.result && <pre>{tool.result}</pre>}
  </details>;
}
