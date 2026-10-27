import {useEffect,useRef,useState,type RefObject} from 'react';
import {useAccessSnapshot,type AccessLease,type bindProtectedInvoke} from './access';
import {errorMessage} from './i18n/localError';
import {t,useUi,formatNumber} from './i18n/core';

export type ClaudeTerminalSource=Readonly<{agent:'claude';path:string;view:'records'|'conversation';inlineImages:boolean}>;
export type TerminalInputLabels=Readonly<{hostLabel:string;terminalLabel:string}>;
type Destination=Readonly<{generation:string;sessionId:string;windowId:string;paneId:string}>;
type Snapshot=Readonly<{kind:'destination';destination:Destination;sessionName:string;windowName:string;paneIndex:number}>;
type Binding=Readonly<{receipt:string;destination:Destination;nextOperation:number}>;
type FailureKey='chatTerminalInvalidReply'|'chatTerminalInvalidDraft'|'chatTerminalInvalid'|'chatTerminalStale'|'chatTerminalBusy';
class InputFailure extends Error {constructor(readonly key:FailureKey){super(key);}}
type Problem={key:FailureKey}|{raw:string};
const invalid=()=>new InputFailure('chatTerminalInvalidReply');
const wellFormed=(value:string)=>!/[\uD800-\uDFFF]/u.test(value);
const utf8=(value:string)=>new TextEncoder().encode(value).length;
const uuid=(value:unknown):value is string=>typeof value==='string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const uint32=(value:unknown):value is number=>typeof value==='number' && Number.isInteger(value) && value>=0 && value<=0xffffffff;
function record(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key)))throw invalid();
  return value as Record<string,unknown>;
}
function destination(value:unknown):Destination {
  const row=record(value,['generation','sessionId','windowId','paneId']);
  if(!uuid(row.generation) || typeof row.sessionId!=='string' || !/^\$\d{1,22}$/.test(row.sessionId) || typeof row.windowId!=='string' || !/^@\d{1,22}$/.test(row.windowId) || typeof row.paneId!=='string' || !/^%\d{1,22}$/.test(row.paneId))throw invalid();
  return Object.freeze({generation:row.generation,sessionId:row.sessionId,windowId:row.windowId,paneId:row.paneId});
}
export function validClaudeTerminalSource(value:unknown):value is ClaudeTerminalSource {
  if(!value || typeof value!=='object')return false;
  const source=value as ClaudeTerminalSource;
  return Object.keys(value).length===4 && ['agent','path','view','inlineImages'].every(key=>Object.hasOwn(value,key)) && source.agent==='claude' && typeof source.path==='string' && !!source.path && wellFormed(source.path)
    && utf8(source.path)<=4096 && !/[\x00-\x1f\x7f-\x9f]/.test(source.path) && ['records','conversation'].includes(source.view) && typeof source.inlineImages==='boolean';
}
export function validTerminalDraft(text:string):boolean {
  // Validate UTF-16 before TextEncoder can replace an isolated surrogate.
  return !!text && wellFormed(text) && !/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(text) && utf8(text)<=4096;
}
export function parseTerminalSnapshot(value:unknown):Snapshot {
  const row=record(value,['kind','destination','sessionName','windowName','paneIndex']);
  if(row.kind!=='destination' || !uint32(row.paneIndex)
    || [row.sessionName,row.windowName].some(label=>typeof label!=='string' || !wellFormed(label) || utf8(label)>1024 || /[\x00-\x1f\x7f-\x9f]/.test(label)))throw invalid();
  return Object.freeze({kind:'destination',destination:destination(row.destination),sessionName:row.sessionName as string,windowName:row.windowName as string,paneIndex:row.paneIndex});
}
export function parseTerminalBinding(value:unknown,expected:Destination):Binding {
  const row=record(value,['kind','receipt','destination','nextOperation']);
  const target=destination(row.destination);
  if(row.kind!=='bound' || !uuid(row.receipt) || row.nextOperation!==1 || Object.keys(expected).some(key=>target[key as keyof Destination]!==expected[key as keyof Destination]))throw invalid();
  return Object.freeze({receipt:row.receipt,destination:target,nextOperation:1});
}
export function parseTerminalDelivered(value:unknown,operation:number):number {
  const row=record(value,['kind','nextOperation']);
  if(row.kind!=='delivered' || !uint32(operation) || operation<1 || operation>=0xffffffff || row.nextOperation!==operation+1)throw invalid();
  return row.nextOperation as number;
}
function nativeFailure(error:unknown):unknown {
  const kind=error && typeof error==='object' && 'kind' in error?error.kind:undefined;
  return kind==='tmux_chat_invalid'?new InputFailure('chatTerminalInvalid'):kind==='tmux_chat_stale'?new InputFailure('chatTerminalStale'):kind==='tmux_chat_busy'?new InputFailure('chatTerminalBusy'):error;
}

export default function ChatTerminalInput({sessionId,source,labels,access,invoke,draft,draftRevision,composing,compositionActive,onSent}:{
  sessionId:string;source:ClaudeTerminalSource;labels:TerminalInputLabels;access:AccessLease;invoke:ReturnType<typeof bindProtectedInvoke>;
  draft:string;draftRevision:number;composing:RefObject<boolean>;compositionActive:boolean;onSent:(text:string,revision:number)=>void;
}) {
  useUi();
  const accessState=useAccessSnapshot();
  const context=JSON.stringify([sessionId,source,labels]);
  const latest=useRef(context);latest.current=context;
  const alive=useRef(false),flight=useRef(false);
  const owned=useRef<Binding|undefined>(undefined);
  const [binding,setBinding]=useState<Binding>();
  const [snapshot,setSnapshot]=useState<Snapshot>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<Problem>();
  const [uncertain,setUncertain]=useState<''|'keys'|'paste'>('');
  const [status,setStatus]=useState<''|'chatTerminalSent'|'chatTerminalStopRequested'>('');
  const sourceValid=validClaudeTerminalSource(source);
  const current=(original:string)=>alive.current && latest.current===original && access.current();
  async function call(action:Record<string,unknown>):Promise<unknown> {
    // Only this actual native await may interpret native error kinds.
    return invoke('tmux_chat',{sessionId,action}).catch(error=>{throw nativeFailure(error);});
  }
  function release(receipt:string) {
    void invoke('tmux_chat',{sessionId,action:{kind:'release',receipt}}).catch(()=>{});
  }
  function retire() {
    const previous=owned.current;owned.current=undefined;
    if(previous)release(previous.receipt);
  }
  useEffect(()=>{
    alive.current=true;setBinding(undefined);setSnapshot(undefined);setError(undefined);setUncertain('');setStatus('');setBusy(false);
    return()=>{alive.current=false;retire();};
  },[context,access,invoke,accessState.epoch]);
  function failed(error:unknown,original:string,afterInput=false,pasted=false) {
    if(current(original)) {
      retire();
      setBinding(undefined);setSnapshot(undefined);setStatus('');
      setUncertain(afterInput && !(error instanceof InputFailure && ['chatTerminalInvalid','chatTerminalStale','chatTerminalBusy'].includes(error.key)) ? pasted?'paste':'keys' : '');
      setError(error instanceof InputFailure?{key:error.key}:{raw:errorMessage(error)});
    }
  }
  async function choose() {
    if(flight.current || !sourceValid || !access.current())return;
    const original=context;flight.current=true;retire();setBinding(undefined);setSnapshot(undefined);setError(undefined);setUncertain('');setStatus('');setBusy(true);
    try {
      const value=parseTerminalSnapshot(await call({kind:'snapshot'}));
      if(current(original))setSnapshot(value);
    } catch(error) {failed(error,original);}
    finally {flight.current=false;if(current(original))setBusy(false);}
  }
  async function confirm() {
    if(flight.current || !snapshot || !sourceValid || !access.current())return;
    const original=context,target=snapshot.destination;flight.current=true;setBusy(true);setError(undefined);
    let candidate:string|undefined;
    try {
      const reply=await call({kind:'bind',destination:target,source});
      if(reply && typeof reply==='object' && 'receipt' in reply && uuid(reply.receipt))candidate=reply.receipt;
      const value=parseTerminalBinding(reply,target);
      if(!current(original)){release(value.receipt);return;}
      owned.current=value;setBinding(value);candidate=undefined;
    } catch(error) {if(candidate)release(candidate);failed(error,original);}
    finally {flight.current=false;if(current(original))setBusy(false);}
  }
  async function input(kind:'send'|'request_stop') {
    const permission=owned.current;
    if(flight.current || !permission || !access.current() || composing.current)return;
    if(kind==='send' && !validTerminalDraft(draft)){setError({key:'chatTerminalInvalidDraft'});return;}
    const original=context,text=draft,revision=draftRevision;
    flight.current=true;setBusy(true);setError(undefined);setStatus('');
    try {
      const nextOperation=parseTerminalDelivered(await call({kind:'input',receipt:permission.receipt,source,operation:permission.nextOperation,input:kind==='send'?{kind,text}:{kind}}),permission.nextOperation);
      if(!current(original))return;
      if(nextOperation===0xffffffff){retire();setBinding(undefined);}
      else {const next=Object.freeze({...permission,nextOperation});owned.current=next;setBinding(next);}
      setStatus(kind==='send'?'chatTerminalSent':'chatTerminalStopRequested');
      if(kind==='send')onSent(text,revision);
    } catch(error) {failed(error,original,true,kind==='send' && /[\n\t]/.test(text));}
    finally {flight.current=false;if(current(original))setBusy(false);}
  }
  return <section aria-label={t('chatTerminalTitle')} style={{overflowWrap:'anywhere'}}>
    <h4>{t('chatTerminalTitle')}</h4><p>{t('chatTerminalExplanation')}</p>
    <p>{t('chatTerminalPasteNote')}</p>
    <button type="button" disabled={busy || !sourceValid || !access.current()} onClick={()=>void choose()}>{t('chatTerminalChoose')}</button>
    {snapshot && <div>
      <dl><dt>{t('chatTerminalHost')}</dt><dd>{labels.hostLabel}</dd><dt>{t('chatTerminalTab')}</dt><dd>{labels.terminalLabel}</dd><dt>{t('chatTerminalSession')}</dt><dd>{snapshot.sessionName}</dd><dt>{t('chatTerminalWindow')}</dt><dd>{snapshot.windowName}</dd><dt>{t('chatTerminalPane')}</dt><dd>{formatNumber(snapshot.paneIndex)}</dd></dl>
      {!binding && <button type="button" disabled={busy || !access.current()} onClick={()=>void confirm()}>{t('chatTerminalConfirm')}</button>}
      {!binding && <button type="button" disabled={busy} onClick={()=>setSnapshot(undefined)}>{t('chatTerminalCancel')}</button>}
    </div>}
    {binding && <div className="button-row" style={{flexWrap:'wrap'}}>
      <button type="button" disabled={busy || !validTerminalDraft(draft) || compositionActive || !access.current()} onClick={()=>void input('send')}>{t('chatTerminalSend')}</button>
      <button type="button" disabled={busy || compositionActive || !access.current()} onClick={()=>void input('request_stop')}>{t('chatTerminalStop')}</button>
      <button type="button" disabled={busy} onClick={()=>{retire();setBinding(undefined);setSnapshot(undefined);setStatus('');}}>{t('chatTerminalClear')}</button>
    </div>}
    {!sourceValid && <p>{t('chatTerminalInvalid')}</p>}
    {binding && !validTerminalDraft(draft) && <p>{t('chatTerminalInvalidDraft')}</p>}
    {busy && <p role="status">{t('chatTerminalPending')}</p>}
    {status && <p role="status">{t(status)}</p>}
    {error && <div><p role="alert">{'key' in error?t(error.key):error.raw}</p><p>{t(uncertain==='paste'?'chatTerminalPasteUncertain':uncertain?'chatTerminalUncertain':'chatTerminalFallback')}</p></div>}
    <p>{t('chatTerminalCloseHint')}</p>
  </section>;
}
