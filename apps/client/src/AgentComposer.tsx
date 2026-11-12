import {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {ArrowLeft,Paperclip,SendHorizontal,Square} from 'lucide-react';
import AttachmentPanel from './AttachmentPanel';
import {shellPath} from './attachment';
import ChatTerminalInput,{validTerminalDraft,validTerminalSource,type TerminalControl,type TerminalDestination,type TerminalInputLabels,type TerminalSource} from './ChatTerminalInput';
import type {BoundConversation} from './ChatPanel';
import type {AccessLease,bindProtectedInvoke} from './access';
import {t,useUi} from './i18n/core';
import AgentComposerPalette,{type Suggestion} from './AgentComposerPalette';
import {promptsOf,recall,rememberPrompt,type Recall} from './agentComposerHistory';
import {matchSlash,pickerCommand,promptMode,slashText,type SlashCommand} from './agentSlashCommands';
import {mentionAt,mentionText} from './agentFileMention';
import {useAgentFileSuggestions} from './useAgentFileSuggestions';
import {canRetry,promptsLike,receiptState,type SendPhase} from './agentSendReceipt';
import {useNow} from './relativeTime';
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
export default function AgentComposer({sessionId,conversation,access,invoke,shown,labels,proof,stage,prompts=[],cwd}:{
  sessionId:string;conversation:BoundConversation;access:AccessLease;invoke:ReturnType<typeof bindProtectedInvoke>;shown:boolean;
  labels?:TerminalInputLabels;proof?:ComposerProof;stage:boolean;
  /** What the conversation already holds as the person's prompts, so a receipt settles from the transcript. */
  prompts?:readonly string[];
  /** The host folder the agent works in: the root of `@` file mentions. Without it there is no file picker. */
  cwd?:string;
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
  const paletteId=useId();
  const walk=useRef<Recall>({index:null,text:''});
  const [slashIndex,setSlashIndex]=useState(0),[slashClosed,setSlashClosed]=useState(false),[caret,setCaret]=useState(0);
  const wantCaret=useRef<number|undefined>(undefined);
  const [receipt,setReceipt]=useState<{text:string;phase:SendPhase;at:number;before:number}>();
  const [stopArmed,setStopArmed]=useState(false);
  const edit=useCallback((next:string)=>{
    revision.current++;setDraft(next);setStaged(false);setSlashClosed(false);setSlashIndex(0);
    if(next)drafts.set(current.current,next);else drafts.delete(current.current);
  },[]);
  useEffect(()=>{
    if(!stopArmed)return;
    const timer=setTimeout(()=>setStopArmed(false),4000);
    return ()=>clearTimeout(timer);
  },[stopArmed]);
  useEffect(()=>{
    current.current=key;revision.current++;composing.current=false;
    setCompositionActive(false);setAttachmentOpen(false);setStaged(false);setDraft(drafts.get(key)??'');setReceipt(undefined);setStopArmed(false);walk.current={index:null,text:''};
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
  const agent=conversation.agent;
  const slash=!slashClosed && !compositionActive ? matchSlash(agent,draft) : undefined;
  const mode=promptMode(agent,draft),picker=pickerCommand(agent,draft);
  const mention=!slash && !slashClosed && !compositionActive && cwd ? mentionAt(draft,caret) : undefined;
  const files=useAgentFileSuggestions({sessionId,invoke,cwd,mention});
  // One list for both kinds of suggestion, so the keys and the listbox behave the same.
  const popup:{label:string;items:Suggestion[];pick:(index:number)=>void}|undefined=slash?{label:t('agentComposerCommands'),
      items:slash.map(command=>({key:command.name,label:`/${command.name}`,hint:command.picker?t('agentComposerOpensPicker'):undefined})),pick:index=>pick(slash[index])}
    : mention && files.length ? {label:t('agentComposerFiles'),items:files.map(entry=>({key:entry.name,label:entry.isDir?`${entry.name}/`:entry.name})),
      pick:index=>{
        const text=mentionText(mention,files[index]);
        wantCaret.current=mention.start+text.length;edit(draft.slice(0,mention.start)+text+draft.slice(caret));field.current?.focus({preventScroll:true});
      }} : undefined;
  useEffect(()=>{
    if(wantCaret.current===undefined)return;
    field.current?.setSelectionRange(wantCaret.current,wantCaret.current);setCaret(wantCaret.current);wantCaret.current=undefined;
  },[draft]);
  const pick=(command:SlashCommand)=>{edit(slashText(command));field.current?.focus({preventScroll:true});};
  const now=useNow(1000,receipt?.phase==='accepted');
  const state=receipt && receiptState({phase:receipt.phase,text:receipt.text,before:receipt.before,prompts,queued:[],elapsedMs:now-receipt.at});
  function submit() {
    if(composing.current)return;
    if(sendable){
      setReceipt({text:draft,phase:'pending',at:Date.now(),before:promptsLike(prompts,draft)});
      control!.send();return;
    }
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
    {popup && <AgentComposerPalette id={paletteId} label={popup.label} items={popup.items} active={Math.min(slashIndex,popup.items.length-1)} onPick={popup.pick} onHover={setSlashIndex}/>}
    {mode && <span className="agent-composer-mode" data-mode={mode}>{t(mode==='bash'?'agentModeBash':'agentModeMemory')}</span>}
    <form className="agent-composer-row" aria-label={t('chatDraft')} onSubmit={event=>{event.preventDefault();submit();}}>
      <button type="button" className="icon-button" disabled={!access.current()} aria-expanded={attachmentOpen} aria-label={t(attachmentOpen?'chatCloseAttachment':'chatAddAttachment')} title={t(attachmentOpen?'chatCloseAttachment':'chatAddAttachment')} onClick={()=>setAttachmentOpen(open=>!open)}><Paperclip size={18} aria-hidden="true"/></button>
      <textarea ref={field} rows={Math.max(1,Math.min(6,draft.split('\n').length))} maxLength={LIMIT} value={draft} aria-label={t('chatDraftLabel')} placeholder={t('agentComposerLabel')}
        onChange={event=>{setCaret(event.target.selectionStart);edit(event.target.value);}} onSelect={event=>setCaret(event.currentTarget.selectionStart)}
        onCompositionStart={()=>{composing.current=true;setCompositionActive(true);}} onCompositionEnd={()=>{composing.current=false;setCompositionActive(false);}}
        // Enter sends with a hardware keyboard; a touch keyboard keeps Enter as a new line and sends with the button.
        aria-controls={popup?paletteId:undefined} aria-activedescendant={popup?`${paletteId}-${Math.min(slashIndex,popup.items.length-1)}`:undefined}
        onKeyDown={event=>{
          if(event.nativeEvent.isComposing || composing.current)return;
          if(popup){
            const active=Math.min(slashIndex,popup.items.length-1);
            if(event.key==='ArrowDown' || event.key==='ArrowUp'){event.preventDefault();setSlashIndex((active+(event.key==='ArrowDown'?1:popup.items.length-1))%popup.items.length);return;}
            if(event.key==='Tab' || (event.key==='Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey)){event.preventDefault();popup.pick(active);return;}
            if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setSlashClosed(true);return;}
          }
          if((event.key==='ArrowUp' || event.key==='ArrowDown') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey){
            const next=recall(promptsOf(key),walk.current,draft,event.key==='ArrowUp'?'up':'down');
            if(next){event.preventDefault();walk.current=next;edit(next.text);}
            return;
          }
          if(event.key==='Enter' && !event.shiftKey && (event.metaKey || event.ctrlKey || !coarse())){event.preventDefault();submit();}
        }}/>
      {ready && <button type="button" className="icon-button" data-armed={stopArmed || undefined} disabled={control!.busy || compositionActive || !access.current()} aria-label={t(stopArmed?'agentComposerStopConfirm':'chatTerminalStop')} title={t(stopArmed?'agentComposerStopConfirm':'chatTerminalStop')} onClick={()=>{if(stopArmed){setStopArmed(false);control!.stop();}else setStopArmed(true);}}><Square size={16} aria-hidden="true"/></button>}
      {(automatic || staging) && <button type="submit" className="primary-button agent-composer-send" disabled={!canSubmit || !access.current()} aria-label={t(sendable || bindingPending ? 'agentComposerSend' : 'chatStage')} title={t(sendable || bindingPending ? 'agentComposerSend' : 'chatStage')}><SendHorizontal size={18} aria-hidden="true"/></button>}
    </form>
    {live && labels && source && <ChatTerminalInput sessionId={sessionId} source={source} labels={labels} notes={false} access={access} invoke={invoke}
      draft={draft} draftRevision={revision.current} composing={composing} compositionActive={compositionActive}
      proves={proofCheck} onControl={proofCheck?setControl:undefined}
      onSent={(text,sentRevision)=>{
        rememberPrompt(key,text);walk.current={index:null,text:''};
        setReceipt(previous=>previous && previous.text===text?{...previous,phase:'accepted',at:Date.now()}:previous);
        if(revision.current===sentRevision)edit('');
      }}
      onFailed={kind=>setReceipt(previous=>previous?{...previous,phase:kind}:previous)}/>}
    {picker && <p className="agent-composer-note">{t('agentComposerPickerNote',{command:`/${picker.name}`})}</p>}
    {state && <p role="status" className="agent-composer-receipt" data-state={state}>{t(({sending:'agentReceiptSending',sent:'agentReceiptSent',queued:'agentReceiptQueued',unconfirmed:'agentReceiptUnconfirmed',notSent:'agentReceiptNotSent',uncertain:'agentReceiptUncertain'} as const)[state])}
      {canRetry(state) && control && <> <button type="button" className="subtle-button" disabled={control.busy} onClick={()=>{if(draft!==receipt!.text){edit(receipt!.text);return;}setReceipt({...receipt!,phase:'pending',at:Date.now()});control.retry();}}>{t('agentReceiptRetry')}</button></>}</p>}
    {tooLong && <p role="status" className="agent-composer-note">{t('agentComposerTooLong')}</p>}
    {staged && <p role="status" className="agent-composer-note">{t('chatDraftStaged')}</p>}
    {!labels && stage && <p className="agent-composer-note">{t('agentViewStageOnly')}</p>}
  </section>;
}
