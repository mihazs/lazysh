import {t,useUi} from './i18n/core';
import {argumentLimits,yoloFlags,type ArgumentProblem,type LaunchOptions} from './agentLaunchOptions';

/** What YOLO does, said wherever it is on: the dialog and its review step. */
export function YoloNote({agent,name}:{agent:string;name:string}) {
  useUi();
  return <p role="note">{t('agentLaunchYoloHint',{agent:name,flag:yoloFlags[agent]})}</p>;
}

/** The two choices a launch dialog adds after the agent and folder: free-text arguments, and the agent's YOLO flag (off by default,
 * offered only for an agent whose flag is verified). */
export default function AgentLaunchOptions({agent,name,value,problem,onChange}:{agent:string;name:string;value:LaunchOptions;problem?:ArgumentProblem;onChange:(value:LaunchOptions)=>void}) {
  useUi();
  const flag=yoloFlags[agent];
  return <>
    <label>{t('agentLaunchArguments')}<input value={value.text} spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-describedby="agent-launch-arguments-hint" aria-invalid={!!problem} onChange={event=>onChange({...value,text:event.target.value})}/></label>
    <p id="agent-launch-arguments-hint">{t('agentLaunchArgumentsHint')}</p>
    {problem && <p className="inline-error" role="alert">{problem==='quote' ? t('agentLaunchArgumentsQuote') : t('agentLaunchArgumentsLimit',{count:argumentLimits.count,length:argumentLimits.bytes})}</p>}
    {flag && <label><input type="checkbox" checked={value.yolo} onChange={event=>onChange({...value,yolo:event.target.checked})}/>{t('agentLaunchYolo',{flag})}</label>}
    {flag && value.yolo && <YoloNote agent={agent} name={name}/>}
  </>;
}
