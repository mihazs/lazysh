import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,Paperclip,SendHorizontal,Square} from 'lucide-react';
import AttachmentPanel from './AttachmentPanel';
import {shellPath} from './attachment';
import ChatTerminalInput,{validTerminalDraft,validTerminalSource,type TerminalControl,type TerminalDestination,type TerminalInputLabels,type TerminalSource} from './ChatTerminalInput';
import type {BoundConversation} from './ChatPanel';
import type {AccessLease,bindProtectedInvoke} from './access';
import {t,useUi} from './i18n/core';
import './AgentComposer.css';

/** Evidence, already held by the view, of the terminal pane the followed conversation runs in. */
export type ComposerProof={kind:'tmux';paneId:string}|{kind:'herdr';pane:string;terminal:string};
const LIMIT=65536;
/** Unsent drafts by conversation: they outlive the view switching to the terminal and back, never a reload. */
const drafts=new Map<string,string>();
const proves=(proof:ComposerProof)=>(destination:TerminalDestination)=>proof.kind==='tmux'
  ? 'paneId' in destination && destination.paneId===proof.paneId
  : 'pane' in destination && destination.pane===proof.pane && destination.terminal===proof.terminal;

/** The message box of the Agent view: always present under a followed conversation.
 * With a proof the input binds itself to the proven pane and Send goes straight to the agent's terminal; without one
 * the explicit destination confirmation stays. Stage in terminal is the path of a session that takes no confirmed input. */
export default function AgentComposer({sessionId,conversation,access,invoke,shown,labels,proof,stage}:{
  sessionId:string;conversation:BoundConversation;access:AccessLease;invoke:ReturnType<typeof bindProtectedInvoke>;shown:boolean;
  labels?:TerminalInputLabels;proof?:ComposerProof;stage:boolean;
}) {
  useUi();
  // The agent's own session names the conversation, so a transcript that moves to a new file keeps its draft.
  const key=JSON.stringify([sessionId,conversation.agent,conversation.report?.sessionId??conversation.path]);
  const [draft,setDraft]=useState(()=>drafts.get(key)??'');
  const revision=useRef(0),composing=useRef(false),current=useRef(key);
  const [compositionActive,setCompositionActive]=useState(false);
  const [attachmentOpen,setAttachmentOpen]=useState(false);
  const [control,setControl]=useState<TerminalControl>();
  const [staged,setStaged]=useState(false);
  const field=useRef<HTMLTextAreaElement>(null);
  const edit=useCallback((next:string)=>{
    revision.current++;setDraft(next);setStaged(false);
    if(next)drafts.set(current.current,next);else drafts.delete(current.current);
  },[]);
  useEffect(()=>{
    current.current=key;revision.current++;composing.current=false;
    setCompositionActive(false);setAttachmentOpen(false);setStaged(false);setDraft(drafts.get(key)??'');
  },[key]);
  const source=useMemo<TerminalSource|undefined>(()=>{
    const value={agent:conversation.agent,path:conversation.path,view:'conversation' as const,inlineImages:false};
    return validTerminalSource(value)?Object.freeze(value):undefined;
  },[conversation.agent,conversation.path]);
  const automatic=!!proof && !!labels && proof.kind===labels.backend;
  const proofKey=JSON.stringify(proof);
  const proofCheck=useMemo(()=>automatic?proves(proof!):undefined,[automatic,proofKey]);
  const live=shown && !!labels && !!source && access.current();
  const ready=!!control?.ready;
  const sendable=ready && validTerminalDraft(draft) && !control!.busy && !compositionActive;
  const tooLong=ready && !!draft && !validTerminalDraft(draft);
  function submit() {
    if(composing.current)return;
    if(sendable){control!.send();return;}
    if(staging && draft.trim() && draft.length<=LIMIT){
      window.dispatchEvent(new CustomEvent('lazysh-prompt-draft',{detail:{sessionId,text:draft}}));setStaged(true);
    }
  }
  const coarse=()=>!!window.matchMedia?.('(pointer: coarse)').matches;
  // Automatic binding is given a chance first; Stage is the way out once it was refused or lost.
  const bindingPending=live && automatic && !control?.failed;
  const staging=!ready && stage && !bindingPending;
  const canSubmit=sendable || (staging && !!draft.trim() && draft.length<=LIMIT);
  // A conversation that can neither take input nor be staged has nothing to compose; the options menu says why.
  if(!labels && !stage)return null;
  return <section className="agent-composer" data-attachment-open={attachmentOpen || undefined} aria-label={t('agentComposerTitle')}>
    {attachmentOpen && access.current() && <div className="agent-composer-attach">
      <button type="button" className="subtle-button" onClick={()=>setAttachmentOpen(false)}><ArrowLeft size={18} aria-hidden="true"/>{t('navigationBack')}</button>
      <p>{t('chatAttachmentScope')}</p>
      <AttachmentPanel key={sessionId} sessionId={sessionId} onAttach={path=>{
        if(!access.current() || current.current!==key || composing.current)return;
        const next=draft?`${draft}\n${shellPath(path)}`:shellPath(path);
        if(next.length>LIMIT)return;
        edit(next);setAttachmentOpen(false);field.current?.focus({preventScroll:true});
      }}/>
    </div>}
    <form className="agent-composer-row" aria-label={t('chatDraft')} onSubmit={event=>{event.preventDefault();submit();}}>
      <button type="button" className="icon-button" disabled={!access.current()} aria-expanded={attachmentOpen} aria-label={t(attachmentOpen?'chatCloseAttachment':'chatAddAttachment')} title={t(attachmentOpen?'chatCloseAttachment':'chatAddAttachment')} onClick={()=>setAttachmentOpen(open=>!open)}><Paperclip size={18} aria-hidden="true"/></button>
      <textarea ref={field} rows={Math.max(1,Math.min(6,draft.split('\n').length))} maxLength={LIMIT} value={draft} aria-label={t('chatDraftLabel')} placeholder={t('agentComposerLabel')}
        onChange={event=>edit(event.target.value)}
        onCompositionStart={()=>{composing.current=true;setCompositionActive(true);}} onCompositionEnd={()=>{composing.current=false;setCompositionActive(false);}}
        // Enter sends with a hardware keyboard; a touch keyboard keeps Enter as a new line and sends with the button.
        onKeyDown={event=>{if(event.key==='Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && (event.metaKey || event.ctrlKey || !coarse())){event.preventDefault();submit();}}}/>
      {ready && <button type="button" className="icon-button" disabled={control!.busy || compositionActive || !access.current()} aria-label={t('chatTerminalStop')} title={t('chatTerminalStop')} onClick={()=>control!.stop()}><Square size={16} aria-hidden="true"/></button>}
      {(automatic || staging) && <button type="submit" className="primary-button agent-composer-send" disabled={!canSubmit || !access.current()} aria-label={t(sendable || bindingPending ? 'agentComposerSend' : 'chatStage')} title={t(sendable || bindingPending ? 'agentComposerSend' : 'chatStage')}><SendHorizontal size={18} aria-hidden="true"/></button>}
    </form>
    {live && labels && source && <ChatTerminalInput sessionId={sessionId} source={source} labels={labels} notes={false} access={access} invoke={invoke}
      draft={draft} draftRevision={revision.current} composing={composing} compositionActive={compositionActive}
      proves={proofCheck} onControl={proofCheck?setControl:undefined}
      onSent={(text,sentRevision)=>{if(revision.current===sentRevision)edit('');}}/>}
    {tooLong && <p role="status" className="agent-composer-note">{t('agentComposerTooLong')}</p>}
    {staged && <p role="status" className="agent-composer-note">{t('chatDraftStaged')}</p>}
    {!labels && stage && <p className="agent-composer-note">{t('agentViewStageOnly')}</p>}
  </section>;
}
