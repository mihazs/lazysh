import {ClipboardPaste,Eraser,FileText,Image as ImageIcon,Paperclip,SendHorizontal,X} from 'lucide-react';
import {Fragment,useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type Ref} from 'react';
import {t,useUi} from './i18n/core';
import {shellPath} from './attachment';
import {atomicComposerEdit,composerTokenSpans,composerTokenText,removeComposerToken,snapComposerSelection,type ComposerAttachment} from './composerTokens';
import './TerminalComposerSheet.css';

const appleShortcut = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** Send needs visible content; paste-only keeps accepting any nonempty draft. */
export function composerDraftReady(value: string, sendEnter: boolean) {
  return sendEnter ? value.trim().length > 0 : value.length > 0;
}

/**
 * The draft sheet covers the terminal output while it is open. The caller
 * retains the session, draft and literal-paste authority.
 */
const spokenLabel=(attachment:ComposerAttachment)=>t(attachment.kind==='image'?'terminalComposerImage':'terminalComposerFile',{number:attachment.number});

/** Object URL for the previewed image, released when the preview closes. */
function usePreviewUrl(blob:Blob|undefined) {
  const [url,setUrl]=useState<string|null>(null);
  useEffect(()=>{
    if(!blob||typeof URL.createObjectURL!=='function'){setUrl(null);return;}
    const next=URL.createObjectURL(blob);setUrl(next);
    return()=>URL.revokeObjectURL(next);
  },[blob]);
  return url;
}

export default function TerminalComposer({value,onChange,onSubmit,onClose,disabled,sendEnter,textareaRef,onAttach,attachments=[]}:{
  value:string;onChange:(value:string)=>void;onSubmit:()=>void;onClose:()=>void;disabled:boolean;sendEnter:boolean;textareaRef?:Ref<HTMLTextAreaElement>;onAttach?:()=>void;
  /** Uploaded files the draft references through inline tokens. */
  attachments?:readonly ComposerAttachment[];
}) {
  useUi();
  const editorId=useId(), hintId=useId(), previewId=useId();
  const sheet=useRef<HTMLDivElement>(null);
  const editor=useRef<HTMLTextAreaElement|null>(null);
  const mirror=useRef<HTMLDivElement>(null);
  const composing=useRef(false);
  const caret=useRef<number|null>(null);
  const lastCaret=useRef<number|undefined>(undefined);
  const [previewNumber,setPreviewNumber]=useState<number|null>(null);
  const [announcement,setAnnouncement]=useState('');
  const spans=composerTokenSpans(value,attachments);
  const previewed=attachments.find(attachment=>attachment.number===previewNumber);
  const previewUrl=usePreviewUrl(previewed?.kind==='image'?previewed.preview:undefined);
  // Announce chip changes and place the caret after a newly inserted token.
  const known=useRef(attachments);
  useLayoutEffect(()=>{
    const before=known.current;known.current=attachments;
    if(before===attachments)return;
    const added=attachments.filter(attachment=>!before.includes(attachment)),removed=before.filter(attachment=>!attachments.includes(attachment));
    if(added.length){
      const end=composerTokenSpans(value,added).at(-1)?.end;
      if(end!==undefined&&editor.current){const position=value[end]===' '?end+1:end;editor.current.setSelectionRange(position,position);lastCaret.current=position;}
    }
    if(previewNumber!==null&&removed.some(attachment=>attachment.number===previewNumber))setPreviewNumber(null);
    const changed=added.at(-1)??removed.at(-1);
    if(changed)setAnnouncement(t(added.length?'terminalComposerAttachmentAdded':'terminalComposerAttachmentRemoved',{label:spokenLabel(changed)}));
  },[attachments,value,previewNumber]);
  // A corrected value would otherwise move the caret to the end of the editor.
  useLayoutEffect(()=>{
    const position=caret.current;caret.current=null;
    if(position!==null&&editor.current){editor.current.setSelectionRange(position,position);lastCaret.current=position;}
  },[value]);
  // The highlight mirror tracks the editor's text box, excluding its scrollbar.
  useLayoutEffect(()=>{
    const element=editor.current,copy=mirror.current;
    if(!element||!copy)return;
    const sync=()=>{copy.style.width=`${element.clientWidth}px`;copy.style.height=`${element.clientHeight}px`;copy.scrollTop=element.scrollTop;};
    sync();
    if(typeof ResizeObserver!=='function')return;
    const observer=new ResizeObserver(sync);observer.observe(element);
    return()=>observer.disconnect();
  },[value,spans.length>0]);
  // WebKit keeps the layout viewport under the soft keyboard; reserve the covered part.
  useEffect(()=>{
    const viewport=window.visualViewport;
    if(!viewport)return;
    let frame=0;
    const update=()=>{
      const element=sheet.current;
      if(!element)return;
      const covered=Math.max(0,Math.round(element.getBoundingClientRect().bottom-(viewport.offsetTop+viewport.height)));
      element.style.setProperty('--terminal-composer-keyboard',`${covered}px`);
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
    update();
    viewport.addEventListener('resize',schedule);viewport.addEventListener('scroll',schedule);
    return()=>{cancelAnimationFrame(frame);viewport.removeEventListener('resize',schedule);viewport.removeEventListener('scroll',schedule);};
  },[]);
  const ready=!disabled&&composerDraftReady(value,sendEnter);
  const characters=Array.from(value).length, lines=value?value.split('\n').length:0;
  const keys=`${appleShortcut()?'⌘':'Ctrl'}+Enter`;
  const keyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}
    else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&event.target===editor.current){
      event.preventDefault();
      if(ready)onSubmit();
    }
  };
  const edit=(next:string)=>{
    if(composing.current){onChange(next);return;}
    const corrected=atomicComposerEdit(value,next,attachments);
    if(corrected.caret!==undefined)caret.current=corrected.caret;
    onChange(corrected.value);
  };
  const select=()=>{
    const element=editor.current;
    if(!element||composing.current||!spans.length){lastCaret.current=element?.selectionEnd;return;}
    const snapped=snapComposerSelection(element.value,attachments,element.selectionStart,element.selectionEnd,lastCaret.current);
    if(snapped.start!==element.selectionStart||snapped.end!==element.selectionEnd)element.setSelectionRange(snapped.start,snapped.end);
    lastCaret.current=snapped.end;
  };
  // A tap inside a token keeps the caret out of it and shows that attachment.
  const pointerSelect=()=>{
    const element=editor.current;
    if(!element||composing.current||element.selectionStart!==element.selectionEnd)return;
    const tapped=spans.find(span=>span.start<element.selectionStart&&element.selectionStart<span.end);
    if(tapped)setPreviewNumber(tapped.attachment.number);
    lastCaret.current=undefined;select();
  };
  const remove=(attachment:ComposerAttachment)=>{
    onChange(removeComposerToken(value,attachment));
    editor.current?.focus();
  };
  const setEditor=(element:HTMLTextAreaElement|null)=>{
    editor.current=element;
    if(typeof textareaRef==='function')textareaRef(element);
    else if(textareaRef)textareaRef.current=element;
  };
  return <div ref={sheet} className="terminal-compose terminal-draft-composer terminal-composer-sheet" onKeyDown={keyDown}>
    <div className="terminal-composer-head">
      <label htmlFor={editorId}>{t('terminalComposeText')}</label>
      <span className="terminal-composer-count">{t('terminalDraftCharacters',{count:characters})} · {t('terminalDraftLines',{count:lines})}</span>
    </div>
    {attachments.length>0&&<ul className="terminal-composer-attachments" aria-label={t('terminalComposerAttachments')}>
      {attachments.map(attachment=>{
        const label=spokenLabel(attachment);
        return <li key={attachment.number} className="terminal-composer-chip" data-kind={attachment.kind}>
          <button type="button" className="terminal-composer-chip-open" aria-label={t('terminalComposerChip',{label,name:attachment.name})} aria-expanded={previewNumber===attachment.number} aria-controls={previewNumber===attachment.number?previewId:undefined}
            onClick={()=>setPreviewNumber(current=>current===attachment.number?null:attachment.number)}>
            {attachment.kind==='image'?<ImageIcon size={14} aria-hidden="true"/>:<FileText size={14} aria-hidden="true"/>}<span aria-hidden="true">{composerTokenText(attachment)}</span>
          </button>
          <button type="button" className="terminal-composer-chip-remove" aria-label={t('terminalComposerRemoveAttachment',{label})} title={t('terminalComposerRemoveAttachment',{label})} onClick={()=>remove(attachment)}><X size={14} aria-hidden="true"/></button>
        </li>;
      })}
    </ul>}
    {previewed&&<figure id={previewId} className="terminal-composer-preview" aria-label={t('terminalComposerPreview',{label:spokenLabel(previewed)})}>
      {previewUrl&&<img src={previewUrl} alt={t('terminalComposerPreview',{label:spokenLabel(previewed)})}/>}
      <figcaption><span>{previewed.name}</span><code>{shellPath(previewed.path)}</code></figcaption>
    </figure>}
    <div className="terminal-draft-editor">
      {spans.length>0&&<div ref={mirror} className="terminal-composer-mirror" aria-hidden="true">
        {spans.map((span,index)=><Fragment key={span.start}>{value.slice(index?spans[index-1].end:0,span.start)}<mark data-kind={span.attachment.kind}>{value.slice(span.start,span.end)}</mark></Fragment>)}{value.slice(spans.at(-1)!.end)}{' '}
      </div>}
      <textarea id={editorId} ref={setEditor} rows={6} maxLength={65536} value={value} aria-describedby={hintId}
        onChange={event=>edit(event.target.value)} onSelect={select} onClick={pointerSelect}
        onScroll={event=>{if(mirror.current)mirror.current.scrollTop=event.currentTarget.scrollTop;}}
        onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}/>
    </div>
    <span className="sr-only" role="status">{announcement}</span>
    <div className="terminal-compose-actions terminal-draft-actions">
      <div className="terminal-composer-secondary">
        <button type="button" className="icon-button" title={t('terminalCloseComposer')} aria-label={t('terminalCloseComposer')} onClick={onClose}><X size={20} aria-hidden="true"/></button>
        <button type="button" className="icon-button" title={t('terminalClearDraft')} aria-label={t('terminalClearDraft')} disabled={!value} onClick={()=>{onChange('');editor.current?.focus();}}><Eraser size={20} aria-hidden="true"/></button>
        {onAttach&&<button type="button" className="icon-button" title={t('appAttach')} aria-label={t('appAttach')} onClick={onAttach}><Paperclip size={20} aria-hidden="true"/></button>}
      </div>
      <div className="terminal-composer-primary">
        <span id={hintId} className="terminal-composer-hint">{t(sendEnter?'terminalComposerSendHint':'terminalComposerPasteHint',{keys})}</span>
        <button type="button" className="terminal-draft-paste terminal-composer-send" aria-label={t(sendEnter?'terminalSendDraft':'terminalPasteDraft')} title={t(sendEnter?'terminalSendDraftDescription':'terminalPasteDraftDescription')} disabled={!ready} onClick={onSubmit}>
          {sendEnter?<SendHorizontal size={18} aria-hidden="true"/>:<ClipboardPaste size={18} aria-hidden="true"/>}<span>{t(sendEnter?'terminalSendDraft':'terminalPasteDraft')}</span>
        </button>
      </div>
    </div>
  </div>;
}
