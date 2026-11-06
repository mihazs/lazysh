import {attachmentPathText} from './attachmentPaste';

/** One uploaded file referenced by an inline `[Image #n]` or `[File #n]` draft token. */
export type ComposerAttachment = {readonly number:number;readonly kind:'image'|'file';readonly path:string;readonly name:string;readonly preview?:Blob};
export type ComposerTokenSpan = {readonly start:number;readonly end:number;readonly attachment:ComposerAttachment};

/** The token text matches the inline references agent CLIs show, independent of the interface language. */
export function composerTokenText(attachment:Pick<ComposerAttachment,'kind'|'number'>) {
  return `[${attachment.kind==='image'?'Image':'File'} #${attachment.number}]`;
}

/** Every occurrence of a known attachment token, in draft order. */
export function composerTokenSpans(value:string,attachments:readonly ComposerAttachment[]):ComposerTokenSpan[] {
  const spans:ComposerTokenSpan[]=[];
  for(const attachment of attachments){
    const text=composerTokenText(attachment);
    for(let start=value.indexOf(text);start>=0;start=value.indexOf(text,start+text.length))spans.push({start,end:start+text.length,attachment});
  }
  return spans.sort((a,b)=>a.start-b.start);
}

/** Attachments whose token is still in the draft; deleting a token releases its attachment. */
export function liveComposerAttachments(value:string,attachments:readonly ComposerAttachment[]) {
  return attachments.filter(attachment=>value.includes(composerTokenText(attachment)));
}

/**
 * Numbering restarts with each draft and never reuses a number within it. A
 * number whose token text the draft already holds literally (for example text
 * copied from an agent CLI) is skipped, so a new token never captures it.
 */
export function nextComposerAttachmentNumber(value:string,attachments:readonly ComposerAttachment[]) {
  let number=attachments.reduce((highest,attachment)=>Math.max(highest,attachment.number),0)+1;
  while((['image','file'] as const).some(kind=>value.includes(composerTokenText({kind,number}))))number++;
  return number;
}

const inside=(span:ComposerTokenSpan,position:number)=>span.start<position&&position<span.end;

/**
 * Keep tokens atomic across any editor input: an edit that touches part of a
 * token removes the whole token, and text typed inside one lands after it.
 * Returns the caret to restore when the browser value had to be corrected.
 */
export function atomicComposerEdit(previous:string,next:string,attachments:readonly ComposerAttachment[]):{value:string;caret?:number} {
  if(previous===next)return {value:next};
  const spans=composerTokenSpans(previous,attachments);
  if(!spans.length)return {value:next};
  const shortest=Math.min(previous.length,next.length);
  let prefix=0;
  while(prefix<shortest&&previous[prefix]===next[prefix])prefix++;
  let suffix=0;
  while(suffix<shortest-prefix&&previous[previous.length-1-suffix]===next[next.length-1-suffix])suffix++;
  const inserted=next.slice(prefix,next.length-suffix);
  let start=prefix,end=previous.length-suffix;
  for(const span of spans){
    if(end>start){if(span.start<end&&span.end>start){start=Math.min(start,span.start);end=Math.max(end,span.end);}}
    else if(inside(span,start))start=end=span.end;
  }
  if(start===prefix&&end===previous.length-suffix)return {value:next};
  return {value:previous.slice(0,start)+inserted+previous.slice(end),caret:start+inserted.length};
}

/** Keep the caret and selection edges outside tokens, moving in the direction of travel. */
export function snapComposerSelection(value:string,attachments:readonly ComposerAttachment[],start:number,end:number,previous?:number):{start:number;end:number} {
  for(const span of composerTokenSpans(value,attachments)){
    if(start===end&&inside(span,start)){
      const position=previous!==undefined&&previous>=span.end?span.start:span.end;
      return {start:position,end:position};
    }
    if(inside(span,start))start=span.start;
    if(inside(span,end))end=span.end;
  }
  return {start,end};
}

/** Insert a token at the caret, separated from neighbouring text by single spaces. */
export function insertComposerToken(value:string,caret:number,attachment:ComposerAttachment,attachments:readonly ComposerAttachment[]):{value:string;caret:number} {
  const position=snapComposerSelection(value,attachments,caret,caret).start;
  const before=value.slice(0,Math.max(0,Math.min(position,value.length))),after=value.slice(before.length);
  const text=`${before&&!/\s$/.test(before)?' ':''}${composerTokenText(attachment)}${/^\s/.test(after)?'':' '}`;
  return {value:before+text+after,caret:before.length+text.length};
}

/** Remove every occurrence of a token together with the separator inserted after it. */
export function removeComposerToken(value:string,attachment:ComposerAttachment) {
  const text=composerTokenText(attachment);
  return value.split(text).reduce((result,part,index)=>index===0?part:result+(part.startsWith(' ')&&(result===''||/\s$/.test(result))?part.slice(1):part),'');
}

/** On send, each token becomes the shell-quoted path the upload returned, validated like a direct paste. */
export function expandComposerDraft(value:string,attachments:readonly ComposerAttachment[]) {
  let result='',offset=0;
  for(const span of composerTokenSpans(value,attachments)){
    result+=value.slice(offset,span.start)+attachmentPathText(span.attachment.path);
    offset=span.end;
  }
  return result+value.slice(offset);
}

export type StagedComposerAttachment = Omit<ComposerAttachment,'number'>;
const STAGE_EVENT='lazysh-composer-attachment';

/**
 * Hand an uploaded file to the terminal composer that requested it. A path the
 * terminal could not receive literally is refused before any token exists.
 */
export function stageComposerAttachment(sessionId:string,attachment:StagedComposerAttachment) {
  attachmentPathText(attachment.path);
  window.dispatchEvent(new CustomEvent(STAGE_EVENT,{detail:{sessionId,attachment}}));
}

/** Receive uploads staged for one session's composer; returns the unsubscribe function. */
export function onComposerAttachment(sessionId:string,receive:(attachment:StagedComposerAttachment)=>void) {
  const listener=(event:Event)=>{
    const detail:unknown=(event as CustomEvent).detail;
    if(!detail||typeof detail!=='object')return;
    const {sessionId:target,attachment}=detail as {sessionId?:unknown;attachment?:Partial<StagedComposerAttachment>};
    if(target!==sessionId||!attachment||typeof attachment.path!=='string'||typeof attachment.name!=='string'
      ||(attachment.kind!=='image'&&attachment.kind!=='file')||(attachment.preview!==undefined&&!(attachment.preview instanceof Blob)))return;
    receive({kind:attachment.kind,path:attachment.path,name:attachment.name,preview:attachment.preview});
  };
  window.addEventListener(STAGE_EVENT,listener);
  return()=>window.removeEventListener(STAGE_EVENT,listener);
}
