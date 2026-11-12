import {useEffect,useRef,useState,type RefObject} from 'react';
import {useAccessSnapshot,type AccessLease,type bindProtectedInvoke} from './access';
import {transcriptAgents,type TranscriptAgentId} from './transcriptSources';
import {errorMessage} from './i18n/localError';
import {t,useUi,formatNumber} from './i18n/core';

export type TerminalSource=Readonly<{path:string;view:'records'|'conversation';inlineImages:boolean} & (
  {agent:Exclude<TranscriptAgentId,'hermes'|'opencode'>;transcriptSessionId?:never}
  | {agent:'hermes'|'opencode';transcriptSessionId:string}
)>;
/** What the Agent view may send besides the composer's draft: an option digit of a dialog, its multi-select confirmation, and a free-text answer. */
export type DialogAnswer=Readonly<{kind:'select';option:number;of:number}|{kind:'submit';of:number}|{kind:'send';text:string}|{kind:'cycle_mode'}>;
/** Where Shift+Tab landed, as the agent's status line showed it; `unconfirmed` when the screen was not recognised. */
export const permissionModes=['default','acceptEdits','plan','auto','bypassPermissions','unconfirmed'] as const;
export type PermissionMode=typeof permissionModes[number];
export type DialogAnswerer=(answer:DialogAnswer)=>Promise<boolean>;
export type TerminalInputLabels=Readonly<{backend:'tmux'|'herdr';hostLabel:string;terminalLabel:string}>;
type Destination=Readonly<{generation:string;sessionId:string;windowId:string;paneId:string}>;
type Snapshot=Readonly<{kind:'destination';destination:Destination;sessionName:string;windowName:string;paneIndex:number}>;
type HerdrDestination=Readonly<{workspace:string;tab:string;pane:string;terminal:string;runtimeGeneration:string;viewport:Readonly<{x:number;y:number;width:number;height:number}>}>;
type Prepared=Readonly<{kind:'prepared';candidate:string;destination:HerdrDestination}>;
type Binding=Readonly<{receipt:string;destination?:Destination|HerdrDestination;nextOperation:number;/** Stock Herdr: nothing was prepared on the host, so there is no receipt to release. */stock?:true}>;
/** The agent a stock Herdr host is asked to type into; the host re-checks that the pane still shows this session. */
export type StockTarget=Readonly<{herdrSession:string;pane:string;terminal:string;agent:'claude'|'codex';agentSessionId:string}>;
type FailureKey='chatTerminalInvalidReply'|'chatTerminalInvalidDraft'|'chatTerminalInvalid'|'chatTerminalStale'|'chatTerminalBusy'|'chatHerdrUnavailable'|'chatHerdrUncertain'|'chatHerdrBlocked'|'chatHerdrRejected'|'chatHerdrOffline';
class InputFailure extends Error {constructor(readonly key:FailureKey,readonly raw?:string){super(key);}}
type Problem={key:FailureKey;raw?:string}|{raw:string};
/** Failures that prove nothing was written; after any other failure of a send, delivery is unknown. */
const refusals:readonly FailureKey[]=['chatTerminalInvalid','chatTerminalStale','chatTerminalBusy','chatHerdrBlocked','chatHerdrRejected','chatHerdrOffline'];
const offline=['disconnected','timeout','ssh_error','ssh_host_tools_closed','ssh_open_busy','app_locked'];
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
function herdrDestination(value:unknown):HerdrDestination {
  const row=record(value,['workspace','tab','pane','terminal','runtimeGeneration','viewport']);
  for(const key of ['workspace','tab','pane','terminal']) {
    const id=row[key];
    if(typeof id!=='string' || !id || !wellFormed(id) || utf8(id)>128 || /[\x00-\x1f\x7f-\x9f]/.test(id))throw invalid();
  }
  if(typeof row.runtimeGeneration!=='string' || !/^[1-9][0-9]{0,19}$/.test(row.runtimeGeneration) || BigInt(row.runtimeGeneration)>0xffffffffffffffffn)throw invalid();
  const viewport=record(row.viewport,['x','y','width','height']);
  if(Object.values(viewport).some(value=>!uint32(value) || value>65535) || viewport.width===0 || viewport.height===0)throw invalid();
  return Object.freeze({workspace:row.workspace as string,tab:row.tab as string,pane:row.pane as string,terminal:row.terminal as string,runtimeGeneration:row.runtimeGeneration,viewport:Object.freeze({x:viewport.x as number,y:viewport.y as number,width:viewport.width as number,height:viewport.height as number})});
}
export function parseHerdrPrepared(value:unknown):Prepared {
  const row=record(value,['kind','candidate','destination']);
  if(row.kind!=='prepared' || !uuid(row.candidate))throw invalid();
  return Object.freeze({kind:'prepared',candidate:row.candidate,destination:herdrDestination(row.destination)});
}
function available(value:unknown):boolean {
  const row=record(value,['kind','available']);
  if(row.kind!=='status' || typeof row.available!=='boolean')throw invalid();
  return row.available;
}
export function validTerminalSource(value:unknown):value is TerminalSource {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const source=value as Record<string,unknown>;
  if(typeof source.agent!=='string' || !Object.hasOwn(transcriptAgents,source.agent))return false;
  const database=source.agent==='hermes'||source.agent==='opencode';
  const keys=database?['agent','path','view','inlineImages','transcriptSessionId']:['agent','path','view','inlineImages'];
  if(Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))
    || typeof source.path!=='string' || !source.path || !wellFormed(source.path) || utf8(source.path)>4096 || /[\x00-\x1f\x7f-\x9f]/.test(source.path)
    || (source.view!=='records' && source.view!=='conversation') || typeof source.inlineImages!=='boolean')return false;
  if(source.view==='conversation' && source.agent!=='claude' && source.agent!=='grok-acp' && source.agent!=='opencode' && source.agent!=='codex')return false;
  if(source.inlineImages && !(source.agent==='claude' || (source.view==='records' && (source.agent==='codex'||source.agent==='grok-acp'))))return false;
  return !database || (typeof source.transcriptSessionId==='string' && !!source.transcriptSessionId && wellFormed(source.transcriptSessionId)
    && utf8(source.transcriptSessionId)<=256 && !/[\x00-\x1f\x7f-\x9f]/.test(source.transcriptSessionId));
}
/** What `send` takes in one command; a longer prompt is `send_long`, which only tmux has. */
export const SEND_BYTES=4096;
export const LONG_SEND_BYTES=65536;
/** The most a draft may hold for this backend: tmux can paste a long prompt when the caller allows it, a Herdr pane cannot. */
export const draftLimit=(backend:TerminalInputLabels['backend'],long:boolean)=>long && backend==='tmux'?LONG_SEND_BYTES:SEND_BYTES;
export function validTerminalDraft(text:string,limit=SEND_BYTES):boolean {
  // Validate UTF-16 before TextEncoder can replace an isolated surrogate.
  return !!text && wellFormed(text) && !/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(text) && utf8(text)<=limit;
}
export function parseTerminalSnapshot(value:unknown):Snapshot {
  const row=record(value,['kind','destination','sessionName','windowName','paneIndex']);
  if(row.kind!=='destination' || !uint32(row.paneIndex)
    || [row.sessionName,row.windowName].some(label=>typeof label!=='string' || !wellFormed(label) || utf8(label)>1024 || /[\x00-\x1f\x7f-\x9f]/.test(label)))throw invalid();
  return Object.freeze({kind:'destination',destination:destination(row.destination),sessionName:row.sessionName as string,windowName:row.windowName as string,paneIndex:row.paneIndex});
}
export function parseTerminalBinding(value:unknown,expected:Destination|HerdrDestination):Binding {
  const row=record(value,['kind','receipt','destination','nextOperation']);
  const target='runtimeGeneration' in expected?herdrDestination(row.destination):destination(row.destination);
  if(row.kind!=='bound' || !uuid(row.receipt) || row.nextOperation!==1 || JSON.stringify(target)!==JSON.stringify(expected))throw invalid();
  return Object.freeze({receipt:row.receipt,destination:target,nextOperation:1});
}
export function parseTerminalDelivered(value:unknown,operation:number):number {
  const row=record(value,['kind','nextOperation']);
  if(row.kind!=='delivered' || !uint32(operation) || operation<1 || operation>=0xffffffff || row.nextOperation!==operation+1)throw invalid();
  return row.nextOperation as number;
}
/** The reply to `cycle_mode`: a delivery that also names the mode read back. */
export function parseTerminalCycle(value:unknown,operation:number):{nextOperation:number;mode:PermissionMode} {
  const row=record(value,['kind','nextOperation','mode']);
  if(typeof row.mode!=='string' || !(permissionModes as readonly string[]).includes(row.mode))throw invalid();
  return {nextOperation:parseTerminalDelivered({kind:row.kind,nextOperation:row.nextOperation},operation),mode:row.mode as PermissionMode};
}
function nativeFailure(error:unknown,backend:TerminalInputLabels['backend'],stock=false):unknown {
  const kind=error && typeof error==='object' && 'kind' in error?error.kind:undefined;
  if(backend==='herdr' && kind==='herdr_chat_unavailable')return new InputFailure('chatHerdrUnavailable');
  if(backend==='herdr' && kind==='herdr_chat_uncertain')return new InputFailure('chatHerdrUncertain');
  const message=error && typeof error==='object' && 'message' in error && typeof error.message==='string'?error.message:undefined;
  if(backend==='herdr' && kind==='herdr_chat_blocked')return new InputFailure('chatHerdrBlocked');
  if(backend==='herdr' && kind==='herdr_chat_rejected')return new InputFailure('chatHerdrRejected',message);
  // Stock input reports a connection failure as such only before it sent anything; later ones arrive as `herdr_chat_uncertain`.
  if(stock && typeof kind==='string' && offline.includes(kind))return new InputFailure('chatHerdrOffline',message);
  const prefix=backend+'_chat_';
  return kind===prefix+'invalid'?new InputFailure('chatTerminalInvalid'):kind===prefix+'stale'?new InputFailure('chatTerminalStale'):kind===prefix+'busy'?new InputFailure('chatTerminalBusy'):error;
}

export type TerminalDestination=Destination|HerdrDestination;
/** What an automatically bound input offers its caller; `send` and `stop` do nothing while `ready` is false. */
export type TerminalControl=Readonly<{ready:boolean;busy:boolean;/** Binding was refused or lost: only an explicit reconnect or Stage remains. */failed:boolean;send:()=>void;stop:()=>void;/** Bind again, then send the draft once. */retry:()=>void;/** One dialog key sequence through the same receipt, one guarded input at a time; false when nothing was sent. */answer:DialogAnswerer;/** One Shift+Tab; the mode the agent's status line showed afterwards, undefined when nothing was sent. */cycleMode:()=>Promise<PermissionMode|undefined>;
  /** Why the last bind or send failed, for the caller to present; `uncertain` once writing may have begun. */problem?:TerminalProblem}>;
export type TerminalProblem=Readonly<{key:FailureKey|'agentComposerWrongPane';raw?:string;uncertain:''|'keys'|'paste'}>;

/** `notes` false keeps the heading and disclaimer behind the composer's info button.
 * `proves` turns on automatic binding: the destination is chosen on mount and confirmed without a click only when it
 * returns true (evidence the caller already holds, such as the pane a hook report names). A destination it rejects is
 * never confirmed, and Send and Stop move to the caller through `onControl`. Without `proves` the explicit Choose and
 * Confirm steps stay. */
export default function ChatTerminalInput({sessionId,source,labels,access,invoke,draft,draftRevision,composing,compositionActive,onSent,notes=true,long=false,proves,onControl,onFailed,stock}:{
  sessionId:string;source:TerminalSource;labels:TerminalInputLabels;access:AccessLease;invoke:ReturnType<typeof bindProtectedInvoke>;
  draft:string;draftRevision:number;composing:RefObject<boolean>;compositionActive:boolean;onSent:(text:string,revision:number)=>void;notes?:boolean;
  /** Let a tmux terminal take a prompt of up to 64 KiB, sent as one bounded paste past the 4 KiB `send` takes. */
  long?:boolean;
  proves?:(destination:TerminalDestination)=>boolean;onControl?:(control:TerminalControl|undefined)=>void;
  /** A send ended without delivery: `refused` when nothing was written, `unknown` once writing began. */
  onFailed?:(kind:'refused'|'unknown')=>void;
  /** Without a guarded display, input goes through the host's own Herdr commands to this agent's pane instead. */
  stock?:StockTarget;
}) {
  useUi();
  const accessState=useAccessSnapshot();
  const context=JSON.stringify([sessionId,source,labels,stock]);
  const latest=useRef(context);latest.current=context;
  const alive=useRef(false),flight=useRef(false);
  const owned=useRef<Binding|undefined>(undefined);
  const [binding,setBinding]=useState<Binding>();
  const [snapshot,setSnapshot]=useState<Snapshot|Prepared>();
  const command=labels.backend==='herdr'?'herdr_chat':'tmux_chat';
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<Problem>();
  const [uncertain,setUncertain]=useState<''|'keys'|'paste'>('');
  const [status,setStatus]=useState<''|'chatTerminalSent'|'chatTerminalStopRequested'|'chatHerdrSent'|'chatHerdrStopRequested'>('');
  const sourceValid=validTerminalSource(source);
  const current=(original:string)=>alive.current && latest.current===original && access.current();
  async function call(action:Record<string,unknown>):Promise<unknown> {
    // Only this actual native await may interpret native error kinds.
    return invoke(command,{sessionId,action}).catch(error=>{throw nativeFailure(error,labels.backend);});
  }
  function release(receipt:string) {
    if(!uuid(receipt))return;
    void invoke(command,{sessionId,action:{kind:'release',receipt}}).catch(()=>{});
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
      // Stock input holds nothing on the host, so a failed send leaves the input ready for an explicit second try.
      if(!(afterInput && owned.current?.stock)){retire();setBinding(undefined);}
      setSnapshot(undefined);setStatus('');
      setUncertain(afterInput && !(error instanceof InputFailure && refusals.includes(error.key)) ? pasted?'paste':'keys' : '');
      setError(error instanceof InputFailure?{key:error.key,raw:error.raw}:{raw:errorMessage(error)});
    }
  }
  /** Stock Herdr: one host call per message, addressed to the pane of the followed agent. */
  async function stockInput(input:Record<string,unknown>) {
    if(!stock)throw new InputFailure('chatHerdrUnavailable');
    return invoke('herdr_agent_input',{sessionId,target:stock,input}).catch(error=>{throw nativeFailure(error,'herdr',true);});
  }
  async function choose() {
    if(flight.current || !sourceValid || !access.current())return;
    const original=context;flight.current=true;retire();setBinding(undefined);setSnapshot(undefined);setError(undefined);setUncertain('');setStatus('');setBusy(true);
    try {
      if(labels.backend==='herdr') {
        if(!available(await call({kind:'status'}))) {
          // No guard on this host: the exact pane of the followed agent takes the input, and the host re-checks it on every send.
          if(!stock)throw new InputFailure('chatHerdrUnavailable');
          if(!current(original))return;
          const next=Object.freeze({receipt:'stock',nextOperation:1,stock:true as const});owned.current=next;setBinding(next);
          return;
        }
        if(!current(original))return;
        const reply=await call({kind:'prepare',source});
        const candidate=reply && typeof reply==='object' && 'candidate' in reply && uuid(reply.candidate)?reply.candidate:undefined;
        try {
          const value=parseHerdrPrepared(reply);
          if(!current(original)){release(value.candidate);return;}
          owned.current={receipt:value.candidate,destination:value.destination,nextOperation:0};
          setSnapshot(value);
        } catch(error) {if(candidate)release(candidate);throw error;}
      } else {
        const value=parseTerminalSnapshot(await call({kind:'snapshot'}));
        if(current(original))setSnapshot(value);
      }
    } catch(error) {failed(error,original);}
    finally {flight.current=false;if(current(original))setBusy(false);}
  }
  async function confirm() {
    if(flight.current || !snapshot || !sourceValid || !access.current())return;
    const original=context,target=snapshot.destination;flight.current=true;setBusy(true);setError(undefined);
    let candidate:string|undefined;
    try {
      const reply=await call(snapshot.kind==='prepared'?{kind:'confirm',candidate:snapshot.candidate,source}:{kind:'bind',destination:target,source});
      if(reply && typeof reply==='object' && 'receipt' in reply && uuid(reply.receipt))candidate=reply.receipt;
      const value=parseTerminalBinding(reply,target);
      if(!current(original)){release(value.receipt);return;}
      owned.current=value;setBinding(value);candidate=undefined;
    } catch(error) {if(candidate)release(candidate);failed(error,original);}
    finally {flight.current=false;if(current(original))setBusy(false);}
  }
  const auto=!!proves,proven=!!proves && !!snapshot && proves(snapshot.destination);
  // Automatic binding runs once per context; after a failure only the explicit Reconnect button tries again.
  useEffect(()=>{if(auto && sourceValid && !snapshot && !binding && !error && !busy && !flight.current)void choose();});
  useEffect(()=>{if(proven && !binding && !busy && !error)void confirm();});
  const latestInput=useRef<(kind:'send'|'request_stop'|DialogAnswer)=>Promise<boolean>>(async()=>false);
  const landed=useRef<PermissionMode|undefined>(undefined);
  // Retry is one explicit request: bind again, and send the draft once as soon as that binding exists.
  const retrying=useRef(false);
  useEffect(()=>{if(retrying.current && binding && !busy){retrying.current=false;if(validTerminalDraft(draft,draftLimit(labels.backend,long)))void input('send');}});
  useEffect(()=>{if(retrying.current && error)retrying.current=false;},[error]);
  const ready=!!binding,mismatch=auto && !!snapshot && !proven && !binding,refused=!binding && !busy && (!!error || mismatch);
  const problem:TerminalProblem|undefined=error?{key:'key' in error?error.key:'chatHerdrRejected',raw:error.raw,uncertain}:mismatch?{key:'agentComposerWrongPane',uncertain:''}:undefined;
  const problemKey=problem&&JSON.stringify(problem);
  useEffect(()=>{onControl?.({ready,busy,failed:refused,problem,send:()=>void latestInput.current('send'),stop:()=>void latestInput.current('request_stop'),answer:body=>latestInput.current(body),cycleMode:async()=>{landed.current=undefined;return await latestInput.current({kind:'cycle_mode'})?landed.current:undefined;},retry:()=>{retrying.current=true;void choose();}});},[onControl,ready,busy,refused,problemKey]);
  useEffect(()=>()=>onControl?.(undefined),[onControl]);
  async function input(kind:'send'|'request_stop'|DialogAnswer):Promise<boolean> {
    const permission=owned.current,body=typeof kind==='string'?kind==='send'?{kind,text:draft}:{kind}:kind;
    if(flight.current || !permission || !access.current() || composing.current)return false;
    if(body.kind==='send' && !validTerminalDraft(body.text,draftLimit(labels.backend,long))){setError({key:'chatTerminalInvalidDraft'});return false;}
    const original=context,text=body.kind==='send'?body.text:'',revision=draftRevision;
    flight.current=true;setBusy(true);setError(undefined);setStatus('');
    try {
      const reply=permission.stock?(await stockInput(body),undefined):await call({kind:'input',receipt:permission.receipt,source,operation:permission.nextOperation,input:body.kind==='send' && utf8(text)>SEND_BYTES?{kind:'send_long',text}:body});
      const cycled=body.kind==='cycle_mode' && !permission.stock?parseTerminalCycle(reply,permission.nextOperation):undefined;
      const nextOperation=permission.stock?permission.nextOperation:cycled?cycled.nextOperation:parseTerminalDelivered(reply,permission.nextOperation);
      if(!current(original))return false;
      landed.current=cycled?.mode;
      if(nextOperation===0xffffffff){retire();setBinding(undefined);}
      else {const next=Object.freeze({...permission,nextOperation});owned.current=next;setBinding(next);}
      const stop=body.kind==='request_stop';
      setStatus(labels.backend==='herdr'?(stop?'chatHerdrStopRequested':'chatHerdrSent'):(stop?'chatTerminalStopRequested':'chatTerminalSent'));
      if(kind==='send')onSent(text,revision);
      return true;
    } catch(error) {
      failed(error,original,true,labels.backend==='tmux' && body.kind==='send' && (utf8(text)>SEND_BYTES || /[\n\t]/.test(text)));
      if(kind==='send' && current(original))onFailed?.(error instanceof InputFailure && refusals.includes(error.key)?'refused':'unknown');
      return false;
    }
    finally {flight.current=false;if(current(original))setBusy(false);}
  }
  latestInput.current=input;
  return <section aria-label={t('chatTerminalTitle')} style={{overflowWrap:'anywhere'}}>
    <h4 hidden={!notes}>{t('chatTerminalTitle')}</h4><p hidden={!notes}>{t(labels.backend==='herdr'?'chatHerdrExplanation':'chatTerminalExplanation')}</p>
    <p hidden={!notes}>{t(labels.backend==='herdr'?'chatHerdrPasteNote':'chatTerminalPasteNote')}</p>
    {!auto && <button type="button" disabled={busy || !sourceValid || !access.current()} onClick={()=>void choose()}>{t('chatTerminalChoose')}</button>}
    {snapshot && !auto && <div>
      <dl><dt>{t('chatTerminalHost')}</dt><dd>{labels.hostLabel}</dd><dt>{t('chatTerminalTab')}</dt><dd>{labels.terminalLabel}</dd>{snapshot.kind==='destination'?<><dt>{t('chatTerminalSession')}</dt><dd>{snapshot.sessionName}</dd><dt>{t('chatTerminalWindow')}</dt><dd>{snapshot.windowName}</dd><dt>{t('chatTerminalPane')}</dt><dd>{formatNumber(snapshot.paneIndex)}</dd></>:<>{(['workspace','tab','pane','terminal'] as const).map(key=><div key={key}><dt>{t(key==='workspace'?'chatHerdrWorkspace':key==='tab'?'chatHerdrTab':key==='pane'?'chatTerminalPane':'chatTerminalTab')}</dt><dd>{snapshot.destination[key]}</dd></div>)}<dt>{t('chatHerdrViewport')}</dt><dd>{Object.values(snapshot.destination.viewport).map(value=>formatNumber(value)).join(' × ')}</dd></>}</dl>
      {!binding && <button type="button" disabled={busy || !access.current()} onClick={()=>void confirm()}>{t('chatTerminalConfirm')}</button>}
      {!binding && <button type="button" disabled={busy} onClick={()=>{retire();setSnapshot(undefined);}}>{t('chatTerminalCancel')}</button>}
    </div>}
    {binding && !auto && <div className="button-row" style={{flexWrap:'wrap'}}>
      <button type="button" disabled={busy || !validTerminalDraft(draft) || compositionActive || !access.current()} onClick={()=>void input('send')}>{t('chatTerminalSend')}</button>
      <button type="button" disabled={busy || compositionActive || !access.current()} onClick={()=>void input('request_stop')}>{t('chatTerminalStop')}</button>
      <button type="button" disabled={busy} onClick={()=>{retire();setBinding(undefined);setSnapshot(undefined);setStatus('');}}>{t('chatTerminalClear')}</button>
    </div>}
    {!sourceValid && <p>{t('chatTerminalInvalid')}</p>}
    {binding && !auto && !validTerminalDraft(draft) && <p>{t('chatTerminalInvalidDraft')}</p>}
    {busy && (!auto || binding) && <p role="status">{t('chatTerminalPending')}</p>}
    {status && !(auto && (status==='chatTerminalSent' || status==='chatHerdrSent')) && <p role="status">{t(status)}</p>}
    {!auto && mismatch && !error && <p role="alert">{t('agentComposerWrongPane')}</p>}
    {!auto && error && <div><p role="alert">{'key' in error?t(error.key):error.raw}</p><p>{t(uncertain==='paste'?'chatTerminalPasteUncertain':uncertain?'chatTerminalUncertain':'chatTerminalFallback')}</p></div>}
    <p hidden={!notes}>{t('chatTerminalCloseHint')}</p>
  </section>;
}
