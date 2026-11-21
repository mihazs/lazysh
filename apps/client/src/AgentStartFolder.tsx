import {FolderOpen} from 'lucide-react';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {bindProtectedInvoke} from './access';
import {shellPath} from './attachment';
import DirectoryPicker from './DirectoryPicker';
import {validAbsolutePath} from './herdrCreate';
import {Modal} from './HerdrWorkspaceCreateDialog';
import {t,useUi} from './i18n/core';

export const startAgents={claude:'Claude Code',codex:'Codex'} as const;
type StartAgent=keyof typeof startAgents;
/** The command staged for review: it changes into the chosen folder, then starts the agent there. */
export const startCommand=(agent:StartAgent,directory:string)=>`cd ${shellPath(directory)} && ${agent}`;

/** Starts Claude Code or Codex in a folder of the host: choose the agent and folder, review the exact command, then stage it in the terminal composer. It never runs from here. */
export default function AgentStartFolder({sessionId,invoke,recent,disabled,onStaged}:{sessionId:string;invoke:ReturnType<typeof bindProtectedInvoke>;recent:readonly string[];disabled:boolean;onStaged:()=>void}) {
  useUi();
  const [open,setOpen]=useState(false);
  const [agent,setAgent]=useState<StartAgent>('claude');
  const [directory,setDirectory]=useState('');
  const [command,setCommand]=useState<string>();
  const [invalid,setInvalid]=useState(false);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const close=()=>{setOpen(false);setCommand(undefined);setInvalid(false);};
  function review(event:FormEvent) {
    event.preventDefault();
    const valid=validAbsolutePath(directory);
    setInvalid(!valid);
    if(valid)setCommand(startCommand(agent,directory));
  }
  return <>
    <button type="button" className="subtle-button" disabled={disabled} onClick={()=>setOpen(true)}><FolderOpen size={16} aria-hidden="true"/>{t('agentViewStartFolder')}</button>
    {open && <Modal title={t('agentViewStartFolder')} close={close} step={command===undefined?'form':'review'}>
      {command===undefined ? <form className="form-stack herdr-create-form" onSubmit={review} noValidate>
        <fieldset className="herdr-create-agent">
          <legend>{t('herdrCreateAgent')}</legend>
          {(Object.keys(startAgents) as StartAgent[]).map(kind=><label key={kind}><input type="radio" name="agent-start-agent" checked={agent===kind} onChange={()=>setAgent(kind)}/>{startAgents[kind]}</label>)}
        </fieldset>
        <DirectoryPicker sessionId={sessionId} invoke={invoke} owns={()=>alive.current} value={directory} onChange={setDirectory} recent={recent}/>
        {invalid && <p className="inline-error" role="alert">{t('herdrCreateInvalidDirectory')}</p>}
        <div className="dialog-actions"><button type="button" className="subtle-button" onClick={close}>{t('appCancel')}</button><button type="submit" className="primary-button">{t('agentViewStartFolderReview')}</button></div>
      </form> : <div className="form-stack herdr-create-review">
        <p>{t('agentViewStartFolderIntro')}</p>
        <pre className="herdr-create-output"><code>{command}</code></pre>
        <div className="dialog-actions"><button type="button" className="subtle-button" onClick={()=>setCommand(undefined)}>{t('navigationBack')}</button>
          <button type="button" className="primary-button" onClick={()=>{window.dispatchEvent(new CustomEvent('lazysh-prompt-draft',{detail:{sessionId,text:command}}));close();onStaged();}}>{t('agentViewStartFolderStage')}</button></div>
      </div>}
    </Modal>}
  </>;
}
