import {Ellipsis,FolderPlus,GitBranchPlus,X} from 'lucide-react';
import {useEffect,useMemo,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {bindProtectedInvoke,type AccessLease} from './access';
import DirectoryPicker,{type Load} from './DirectoryPicker';
import type {ReportedSessionSource} from './HerdrSessionDetails';
import {agentName,branchFromLabel,knownDirectories,suggestWorktreePath,validAbsolutePath,validBase,validBranch,validLabel,validPrompt,workspaceDirectory,worktreeSource} from './herdrCreate';
import {t,useUi} from './i18n/core';
import {captureUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import type {HerdrTree} from './useHerdrNavigation';
import './HerdrWorkspaceCreateDialog.css';

type AgentKind={kind:string;label:string;executable:string;prompt:boolean};
type Repository={root:string;main:string;head:string;detached:boolean;worktrees:string[]};
type Stage='worktree'|'workspace'|'agentCheck'|'agent';
type Step={stage:Stage;argv:string[];command:string};
type Outcome={worktree?:string;workspaceId?:string;paneId?:string;agent?:string;failure?:{stage:Stage;message:string}};
type Target={type:'directory';label:string;directory:string}|{type:'worktree';repository:string;branch:string;base:string;path:string};
type Request={target:Target;agent?:{kind:string;name:string;prompt?:string}};
type Shared={sessionId:string;server:string;lease:AccessLease;disabled:boolean;tree?:HerdrTree;reports?:ReportedSessionSource;onCreated:(workspace:string)=>void};
type Source={workspace_id:string;label:string;directory:string};
type Invalid='herdrCreateInvalidLabel'|'herdrCreateInvalidDirectory'|'herdrCreateNotRepository'|'herdrCreateInvalidBranch'|'herdrCreateInvalidBase'|'herdrCreateAgentRequired'|'herdrCreateInvalidPrompt';

const stageKeys={worktree:'herdrCreateStageWorktree',workspace:'herdrCreateStageWorkspace',agentCheck:'herdrCreateStageAgentCheck',agent:'herdrCreateStageAgent'} as const;

/** Opens the "New workspace" flow; nothing runs before the reviewed commands are confirmed. `agentFirst` opens it with "start an agent" already chosen. */
export function HerdrWorkspaceCreate({label,agentFirst,...props}:Shared&{label?:string;agentFirst?:boolean}) {
  useUi();
  const [open,setOpen]=useState(false);
  return <>
    <button className="subtle-button herdr-create-trigger" disabled={props.disabled} onClick={()=>setOpen(true)}><FolderPlus size={16} aria-hidden="true"/>{label??t('herdrCreateWorkspace')}</button>
    {open && <CreateFlow {...props} agentFirst={agentFirst} close={()=>setOpen(false)}/>}
  </>;
}
/** Opens the worktree flow of the focused workspace (else the first one that reported a directory) with "start an agent" already chosen; nothing runs before the reviewed commands are confirmed. */
export function HerdrWorktreeCreate({label,tree,...props}:Shared&{tree:HerdrTree;label:string}) {
  useUi();
  const [open,setOpen]=useState(false);
  const source=worktreeSource(tree);
  if(!source)return null;
  return <>
    <button type="button" className="subtle-button herdr-create-trigger" disabled={props.disabled} onClick={()=>setOpen(true)}><GitBranchPlus size={16} aria-hidden="true"/>{label}</button>
    {open && <CreateFlow {...props} tree={tree} source={source} agentFirst close={()=>setOpen(false)}/>}
  </>;
}
/** A space's overflow menu, opened by its button or a long press; "New worktree" needs a reported directory, which the dialog checks is in a Git repository. Escape is handled while capturing so the phone sidebar's own Escape (close the sidebar) never sees it. */
export function HerdrSpaceActions({workspace,open,onOpenChange,...props}:Shared&{tree:HerdrTree;workspace:{workspace_id:string;label:string};open:boolean;onOpenChange:(open:boolean)=>void}) {
  useUi();
  const [creating,setCreating]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  const change=useRef(onOpenChange);change.current=onOpenChange;
  useEffect(()=>{
    if(!open)return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const back=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();change.current(false);trigger.current?.focus();};
    window.addEventListener('lazysh-workspace-back',back,true);
    return()=>window.removeEventListener('lazysh-workspace-back',back,true);
  },[open]);
  const directory=workspaceDirectory(props.tree,workspace.workspace_id);
  if(!directory)return null;
  const name=t('herdrSpaceActions',{name:workspace.label});
  return <div className="herdr-space-actions" onBlur={event=>{if(open && !event.currentTarget.contains(event.relatedTarget))onOpenChange(false);}}
    onKeyDownCapture={event=>{if(open && event.key==='Escape'){event.preventDefault();event.stopPropagation();onOpenChange(false);trigger.current?.focus();}}}>
    <button ref={trigger} type="button" className="icon-button" title={name} aria-label={name} aria-haspopup="menu" aria-expanded={open} disabled={props.disabled} onClick={()=>onOpenChange(!open)}><Ellipsis size={18} aria-hidden="true"/></button>
    {open && <div ref={menu} className="herdr-space-menu" role="menu" aria-label={name}>
      <button type="button" role="menuitem" disabled={props.disabled} onClick={()=>{trigger.current?.focus();onOpenChange(false);setCreating(true);}}><GitBranchPlus size={17} aria-hidden="true"/>{t('herdrCreateWorktree',{name:workspace.label})}</button>
    </div>}
    {creating && <CreateFlow {...props} source={{...workspace,directory}} close={()=>setCreating(false)}/>}
  </div>;
}

export function Modal({title,close,step,children}:{title:string;close:()=>void;step:string;children:ReactNode}) {
  const ref=useRef<HTMLDivElement>(null);
  const heading=useRef<HTMLHeadingElement>(null);
  const first=useRef(true);
  // Each later step starts at the heading so a stray Enter never confirms.
  useEffect(()=>{if(first.current)first.current=false;else heading.current?.focus();},[step]);
  const closeRef=useRef(close);closeRef.current=close;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const node=ref.current!;
    const controls=()=>[...node.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(item=>!item.matches(':disabled') && item.getClientRects().length>0);
    (node.querySelector<HTMLElement>('input:not([type="radio"])')??controls()[0])?.focus();
    const topmost=()=>[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1)===node;
    const key=(event:KeyboardEvent)=>{
      if(!topmost())return;
      if(event.key==='Escape'){event.stopPropagation();closeRef.current();return;}
      if(event.key!=='Tab')return;
      const items=controls(),first=items[0],last=items.at(-1);
      const active=document.activeElement;
      if(!node.contains(active)){event.preventDefault();(event.shiftKey?last:first)?.focus();}
      else if(event.shiftKey && (active===first || active===heading.current)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && active===last){event.preventDefault();first?.focus();}
    };
    const back=(event:Event)=>{if(topmost()){event.preventDefault();closeRef.current();}};
    document.addEventListener('keydown',key);window.addEventListener('lazysh-workspace-back',back);
    return()=>{document.removeEventListener('keydown',key);window.removeEventListener('lazysh-workspace-back',back);previous?.focus();};
  },[]);
  return createPortal(<div className="dialog-backdrop herdr-create" data-mobile-presentation="sheet">
    <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog-heading"><h2 ref={heading} tabIndex={-1}>{title}</h2><button className="icon-button" aria-label={t('appCloseValue1',{value1:title})} onClick={close}><X size={19}/></button></div>
      {children}
    </div>
  </div>,document.body);
}

function CreateFlow({sessionId,server,lease,tree,reports,source,onCreated,close,agentFirst}:Shared&{source?:Source;close:()=>void;agentFirst?:boolean}) {
  useUi();
  const invoke=useMemo(()=>bindProtectedInvoke(lease),[lease]);
  const alive=useRef(true);
  useEffect(()=>()=>{alive.current=false;},[]);
  const owns=()=>alive.current && lease.current();
  const [phase,setPhase]=useState<'form'|'review'|'running'|'result'>('form');
  const [problem,setProblem]=useState<UiErrorCause>('');
  const [invalid,setInvalid]=useState<Invalid>();
  const [label,setLabel]=useState('');
  const [directory,setDirectory]=useState('');
  const [repository,setRepository]=useState<Load<Repository>>({state:'loading'});
  const [branch,setBranch]=useState('');
  const [base,setBase]=useState('');
  const [path,setPath]=useState('');
  const [pathEdited,setPathEdited]=useState(false);
  const [startAgent,setStartAgent]=useState(!!agentFirst);
  const [kinds,setKinds]=useState<Load<AgentKind[]>>();
  const [kind,setKind]=useState('');
  const [prompt,setPrompt]=useState('');
  const [review,setReview]=useState<{request:Request;steps:Step[]}>();
  const [outcome,setOutcome]=useState<Outcome>();
  // One Herdr agent name per kind, so reviewing again shows the same command.
  const names=useRef(new Map<string,string>());
  const nameFor=(kind:string)=>{const name=names.current.get(kind)??agentName(kind);names.current.set(kind,name);return name;};
  const selected=kinds?.state==='ready'?kinds.value.find(item=>item.kind===kind):undefined;
  const projects=reports?.available && reports.host===sessionId && reports.lease.current()?[...reports.rows].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).map(row=>row.project):[];
  const recent=knownDirectories(tree,projects);
  useEffect(()=>{
    if(!source)return;
    void invoke<Repository>('herdr_repository',{sessionId,directory:source.directory}).then(value=>{
      if(!owns())return;
      setRepository({state:'ready',value});
      const suggested=branchFromLabel(source.label,value.head);
      setBranch(suggested);setBase(value.head);setPath(suggestWorktreePath(value,suggested));
    },error=>{if(owns())setRepository({state:'failed',cause:captureUiError(error)});});
  },[]);
  function chooseAgent(value:boolean) {
    setStartAgent(value);setInvalid(undefined);
    if(!value || (kinds && kinds.state!=='failed'))return;
    setKinds({state:'loading'});
    void invoke<AgentKind[]>('herdr_agent_kinds',{sessionId}).then(value=>{if(owns())setKinds({state:'ready',value});},error=>{if(owns())setKinds({state:'failed',cause:captureUiError(error)});});
  }
  useEffect(()=>{if(agentFirst)chooseAgent(true);},[]);
  function target():Target|Invalid {
    if(!source) {
      if(!validLabel(label))return 'herdrCreateInvalidLabel';
      if(!validAbsolutePath(directory))return 'herdrCreateInvalidDirectory';
      return {type:'directory',label,directory};
    }
    if(repository.state!=='ready')return 'herdrCreateNotRepository';
    if(!validBranch(branch))return 'herdrCreateInvalidBranch';
    if(!validBase(base))return 'herdrCreateInvalidBase';
    if(!validAbsolutePath(path))return 'herdrCreateInvalidDirectory';
    return {type:'worktree',repository:repository.value.root,branch,base,path};
  }
  async function submit(event:FormEvent) {
    event.preventDefault();
    const value=target();
    const check=typeof value==='string'?value:startAgent && !selected?'herdrCreateAgentRequired':startAgent && selected?.prompt && !validPrompt(prompt)?'herdrCreateInvalidPrompt':undefined;
    setInvalid(check);
    if(check || typeof value==='string')return;
    const request:Request={target:value,...(startAgent && selected?{agent:{kind:selected.kind,name:nameFor(selected.kind),...(selected.prompt && prompt.trim()?{prompt}:{})}}:{})};
    setProblem('');
    try {
      const plan=await invoke<{steps:Step[]}>('herdr_workspace_plan',{name:server,request});
      if(owns()){setReview({request,steps:plan.steps});setPhase('review');}
    } catch(error){if(owns())setProblem(captureUiError(error));}
  }
  const running=useRef(false);
  async function confirm() {
    if(!review || phase!=='review' || running.current)return;
    running.current=true;setPhase('running');setProblem('');
    try {
      const result=await invoke<Outcome>('herdr_workspace_create',{sessionId,name:server,request:review.request});
      if(!owns())return;
      if(!result.failure && result.workspaceId){close();onCreated(result.workspaceId);return;}
      setOutcome(result);setPhase('result');
    } catch(error){if(owns()){setProblem(captureUiError(error));setPhase('review');}}
    finally{running.current=false;}
  }
  const title=source?t('herdrCreateWorktree',{name:source.label}):t('herdrNewWorkspace');
  const radios=<fieldset className="herdr-create-agent" disabled={phase!=='form'}>
    <legend>{t('herdrCreateAgentQuestion')}</legend>
    <label><input type="radio" name="herdr-create-agent" checked={!startAgent} onChange={()=>chooseAgent(false)}/>{t('herdrCreateAgentNo')}</label>
    <label><input type="radio" name="herdr-create-agent" checked={startAgent} onChange={()=>chooseAgent(true)}/>{t('herdrCreateAgentYes')}</label>
    {startAgent && kinds?.state==='loading' && <p role="status">{t('herdrCreateDetecting')}</p>}
    {startAgent && kinds?.state==='failed' && <p className="inline-error" role="alert">{uiErrorText(kinds.cause)}</p>}
    {startAgent && kinds?.state==='ready' && (kinds.value.length===0?<p role="status">{t('herdrCreateNoAgents')}</p>:<>
      <label>{t('herdrCreateAgent')}<select required value={kind} onChange={event=>{setKind(event.target.value);setInvalid(undefined);}}><option value="">{t('herdrCreateChooseAgent')}</option>{kinds.value.map(item=><option key={item.kind} value={item.kind}>{item.label} ({item.executable})</option>)}</select></label>
      {selected?.prompt && <label>{t('herdrCreatePrompt')}<input value={prompt} maxLength={2000} onChange={event=>setPrompt(event.target.value)}/></label>}
    </>)}
  </fieldset>;
  // Closing while the host runs would hide what was created, so wait for the outcome.
  return <Modal title={title} close={()=>{if(!running.current)close();}} step={phase}>
    {phase==='form' && <form className="form-stack herdr-create-form" onSubmit={event=>void submit(event)} noValidate>
      {!source && <>
        <label>{t('herdrLabel')}<input value={label} maxLength={200} onChange={event=>setLabel(event.target.value)}/></label>
        <DirectoryPicker sessionId={sessionId} invoke={invoke} owns={owns} value={directory} onChange={setDirectory} recent={recent}/>
      </>}
      {source && <>
        <p className="muted">{t('herdrCreateSource')} <code>{source.directory}</code></p>
        {repository.state==='loading' && <p role="status">{t('herdrCreateReadingRepository')}</p>}
        {repository.state==='failed' && <div role="alert"><p>{t('herdrCreateNotRepository')}</p><pre className="herdr-create-output">{uiErrorText(repository.cause)}</pre></div>}
        {repository.state==='ready' && <>
          <p className="muted">{t('herdrCreateRepository')} <code>{repository.value.root}</code></p>
          <label>{t('herdrCreateBranch')}<input value={branch} maxLength={200} onChange={event=>{setBranch(event.target.value);if(!pathEdited)setPath(suggestWorktreePath(repository.value,event.target.value));}}/></label>
          <label>{t('herdrCreateBase')}<input value={base} maxLength={256} onChange={event=>setBase(event.target.value)}/></label>
          <label>{t('herdrCreatePath')}<input value={path} maxLength={4096} onChange={event=>{setPath(event.target.value);setPathEdited(true);}}/></label>
        </>}
      </>}
      {radios}
      {(invalid || problem) && <p className="inline-error" role="alert">{invalid?t(invalid):uiErrorText(problem)}</p>}
      <div className="dialog-actions"><button type="button" className="subtle-button" onClick={close}>{t('appCancel')}</button><button type="submit" className="primary-button" disabled={!!source && repository.state!=='ready'}>{t('herdrCreateReview')}</button></div>
    </form>}
    {(phase==='review' || phase==='running') && review && <div className="form-stack herdr-create-review">
      <p>{t('herdrCreateConfirmIntro')}</p>
      <ol>{review.steps.map((step,index)=><li key={index}><strong>{t(stageKeys[step.stage])}</strong><pre className="herdr-create-output"><code>{step.command}</code></pre></li>)}</ol>
      {review.request.agent?<p className="muted">{t('herdrCreatePanePlaceholder')}</p>:<p><strong>{t('herdrCreateNoAgentNote')}</strong></p>}
      {phase==='running' && <p role="status">{t('herdrCreateRunning')}</p>}
      {problem && <div role="alert"><p>{t('herdrCreateFailedNothing')}</p><pre className="herdr-create-output">{uiErrorText(problem)}</pre></div>}
      <div className="dialog-actions"><button type="button" className="subtle-button" disabled={phase==='running'} onClick={()=>{setPhase('form');setProblem('');}}>{t('navigationBack')}</button><button type="button" className="primary-button" disabled={phase==='running'} onClick={()=>void confirm()}>{t(review.request.agent?'herdrCreateConfirmAgent':'herdrCreateConfirm')}</button></div>
    </div>}
    {phase==='result' && outcome?.failure && <div className="form-stack herdr-create-review" role="alert">
      {outcome.worktree && <p>{t('herdrCreateKeptWorktree',{path:outcome.worktree})}</p>}
      {outcome.workspaceId && <p>{t('herdrCreateKeptWorkspace')}</p>}
      <p><strong>{t(stageKeys[outcome.failure.stage])}</strong> · {t('herdrCreateStageFailed')}</p>
      <pre className="herdr-create-output">{outcome.failure.message}</pre>
      <p className="muted">{t('herdrCreateNothingRemoved')}</p>
      <div className="dialog-actions"><button type="button" className="subtle-button" onClick={close}>{t('herdrCreateClose')}</button>{outcome.workspaceId && <button type="button" className="primary-button" onClick={()=>{close();onCreated(outcome.workspaceId!);}}>{t('herdrCreateOpen')}</button>}</div>
    </div>}
  </Modal>;
}
