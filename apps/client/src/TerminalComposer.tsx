import {ClipboardPaste,Eraser,FileText,GripHorizontal,Image as ImageIcon,Keyboard,KeyboardOff,Minimize2,Paperclip,PenLine,SendHorizontal,X} from 'lucide-react';
import {Fragment,useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type Ref} from 'react';
import {t,useUi} from './i18n/core';
import {shellPath} from './attachment';
import {useFloatingComposer} from './useFloatingComposer';
import {atomicComposerEdit,composerTokenSpans,composerTokenText,removeComposerToken,snapComposerSelection,type ComposerAttachment} from './composerTokens';
import './TerminalComposerSheet.css';

const appleShortcut = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** Send (with Enter) needs visible content; Insert (without Enter) accepts any nonempty draft. */
export function composerDraftReady(value: string, enter: boolean) {
  return enter ? value.trim().length > 0 : value.length > 0;
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

export default function TerminalComposer({value,onChange,onSubmit,onClose,disabled,sendEnter,textareaRef,onAttach,floating=false,onCollapse,cursorBand,keyboard,attachments=[]}:{
  /** `onSubmit(true)` is Send (text, then Enter); `onSubmit(false)` is Insert (text only). */
  value:string;onChange:(value:string)=>void;onSubmit:(enter:boolean)=>void;onClose:()=>void;disabled:boolean;
  /** Whether the Ctrl+Enter shortcut and the highlighted button send Enter; the other action stays one button or Shift away. */
  sendEnter:boolean;textareaRef?:Ref<HTMLTextAreaElement>;onAttach?:()=>void;
  /** A small movable panel over the terminal instead of a sheet that covers it; `onCollapse` runs once it folds into its handle. */
  floating?:boolean;onCollapse?:()=>void;
  /** The terminal's cursor row in viewport coordinates, so a first placement can keep clear of it. */
  cursorBand?:()=>{top:number;bottom:number}|null;
  /** The soft keyboard's real state and its toggle, on touch devices; a floating panel carries it in its header. */
  keyboard?:{open:boolean;toggle:()=>void};
  /** Uploaded files the draft references through inline tokens. */
  attachments?:readonly ComposerAttachment[];
}) {
  useUi();
  const editorId=useId(), hintId=useId(), previewId=useId();
  const sheet=useRef<HTMLDivElement>(null);
  const frame=useFloatingComposer(floating,sheet,cursorBand);
  const editor=useRef<HTMLTextAreaElement|null>(null);
  const mirror=useRef<HTMLDivElement>(null);
  const composing=useRef(false);
  // The draft and its tokens before an IME composition, checked once it commits.
  const composition=useRef<{value:string;attachments:readonly ComposerAttachment[]}|null>(null);
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
    // A floating panel lifts itself, from its terminal area rather than from its own edge.
    if(!viewport||floating)return;
    let frameId=0;
    const update=()=>{
      const element=sheet.current;
      if(!element)return;
      const covered=Math.max(0,Math.round(element.getBoundingClientRect().bottom-(viewport.offsetTop+viewport.height)));
      element.style.setProperty('--terminal-composer-keyboard',`${covered}px`);
    };
    const schedule=()=>{cancelAnimationFrame(frameId);frameId=requestAnimationFrame(update);};
    update();
    viewport.addEventListener('resize',schedule);viewport.addEventListener('scroll',schedule);
    return()=>{cancelAnimationFrame(frameId);viewport.removeEventListener('resize',schedule);viewport.removeEventListener('scroll',schedule);};
  },[floating]);
  const sendReady=!disabled&&composerDraftReady(value,true),insertReady=!disabled&&composerDraftReady(value,false);
  const characters=Array.from(value).length, lines=value?value.split('\n').length:0;
  const keys=`${appleShortcut()?'⌘':'Ctrl'}+Enter`,otherKeys=`${appleShortcut()?'⌘':'Ctrl'}+Shift+Enter`;
  const keyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}
    else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.altKey&&event.target===editor.current){
      event.preventDefault();
      const enter=sendEnter!==event.shiftKey;
      if(enter?sendReady:insertReady)onSubmit(enter);
    }
  };
  const edit=(next:string)=>{
    if(composing.current){onChange(next);return;}
    const corrected=atomicComposerEdit(value,next,attachments);
    if(corrected.caret!==undefined)caret.current=corrected.caret;
    onChange(corrected.value);
  };
  // IMEs (Android keyboards often recompose the word before the caret on
  // Backspace) edit freely while composing; a committed composition that
  // touched part of a token then removes the whole token.
  const compositionStart=()=>{composing.current=true;composition.current={value,attachments};};
  const compositionEnd=(committed:string)=>{
    composing.current=false;
    const before=composition.current;composition.current=null;
    if(!before)return;
    const corrected=atomicComposerEdit(before.value,committed,before.attachments);
    if(corrected.caret===undefined)return;
    caret.current=corrected.caret;
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
  const collapsed=floating&&frame.collapsed;
  const fold=(folded:boolean)=>{
    frame.setCollapsed(folded);
    if(folded){editor.current?.blur();onCollapse?.();}
    else requestAnimationFrame(()=>editor.current?.focus());
  };
  return <div ref={sheet} className={`terminal-compose terminal-draft-composer terminal-composer-sheet${floating?' terminal-composer-floating':''}`} data-collapsed={collapsed||undefined} onKeyDown={keyDown}>
    {collapsed&&<button type="button" className="icon-button terminal-composer-expand" title={t('terminalComposerExpand')} aria-label={t('terminalComposerExpand')} aria-expanded={false} onClick={()=>fold(false)}><PenLine size={20} aria-hidden="true"/></button>}
    <div className="terminal-composer-head">
      {floating&&<button type="button" className="icon-button terminal-composer-grip" title={t('terminalComposerMove')} aria-label={t('terminalComposerMove')} aria-describedby={`${hintId}-move`} {...frame.grip}><GripHorizontal size={20} aria-hidden="true"/></button>}
      <label htmlFor={editorId}>{t('terminalComposeText')}</label>
      <span className="terminal-composer-count">{t('terminalDraftCharacters',{count:characters})} · {t('terminalDraftLines',{count:lines})}</span>
      {floating&&<><span id={`${hintId}-move`} className="sr-only">{t('terminalComposerMoveHint')}</span>
        {keyboard&&<button type="button" className="icon-button" data-keyboard={keyboard.open?'open':'closed'} title={t(keyboard.open?'terminalHideKeyboard':'terminalShowKeyboard')} aria-label={t(keyboard.open?'terminalHideKeyboard':'terminalShowKeyboard')} onPointerDown={event=>event.preventDefault()} onClick={keyboard.toggle}>{keyboard.open?<KeyboardOff size={18} aria-hidden="true"/>:<Keyboard size={18} aria-hidden="true"/>}</button>}
        <button type="button" className="icon-button terminal-composer-fold" title={t('terminalComposerCollapse')} aria-label={t('terminalComposerCollapse')} aria-expanded={true} onClick={()=>fold(true)}><Minimize2 size={18} aria-hidden="true"/></button>
        <button type="button" className="icon-button" title={t('terminalCloseComposer')} aria-label={t('terminalCloseComposer')} onClick={onClose}><X size={18} aria-hidden="true"/></button></>}
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
      {/* The figure already carries the label; an empty alt keeps it from being read twice. */}
      {previewUrl&&<img src={previewUrl} alt=""/>}
      <figcaption><span>{previewed.name}</span><code>{shellPath(previewed.path)}</code></figcaption>
    </figure>}
    <div className="terminal-draft-editor">
      {spans.length>0&&<div ref={mirror} className="terminal-composer-mirror" aria-hidden="true">
        {spans.map((span,index)=><Fragment key={span.start}>{value.slice(index?spans[index-1].end:0,span.start)}<mark data-kind={span.attachment.kind}>{value.slice(span.start,span.end)}</mark></Fragment>)}{value.slice(spans.at(-1)!.end)}{' '}
      </div>}
      <textarea id={editorId} ref={setEditor} rows={floating?3:6} maxLength={65536} value={value} aria-describedby={hintId}
        onChange={event=>edit(event.target.value)} onSelect={select} onClick={pointerSelect}
        onScroll={event=>{if(mirror.current)mirror.current.scrollTop=event.currentTarget.scrollTop;}}
        onCompositionStart={compositionStart} onCompositionEnd={event=>compositionEnd(event.currentTarget.value)}/>
    </div>
    <span className="sr-only" role="status">{announcement}</span>
    <div className="terminal-compose-actions terminal-draft-actions">
      <div className="terminal-composer-secondary">
        {!floating&&<button type="button" className="icon-button" title={t('terminalCloseComposer')} aria-label={t('terminalCloseComposer')} onClick={onClose}><X size={20} aria-hidden="true"/></button>}
        <button type="button" className="icon-button" title={t('terminalClearDraft')} aria-label={t('terminalClearDraft')} disabled={!value} onClick={()=>{onChange('');editor.current?.focus();}}><Eraser size={20} aria-hidden="true"/></button>
        {onAttach&&<button type="button" className="icon-button" title={t('appAttach')} aria-label={t('appAttach')} onClick={onAttach}><Paperclip size={20} aria-hidden="true"/></button>}
      </div>
      <div className="terminal-composer-primary">
        <span id={hintId} className="terminal-composer-hint">{t(sendEnter?'terminalComposerSendHint':'terminalComposerPasteHint',{keys})} · {t(sendEnter?'terminalComposerPasteHint':'terminalComposerSendHint',{keys:otherKeys})}</span>
        <button type="button" className="terminal-draft-paste terminal-composer-send" data-primary={!sendEnter||undefined} aria-label={t('terminalPasteDraft')} title={t('terminalPasteDraftDescription')} disabled={!insertReady} onClick={()=>onSubmit(false)}>
          <ClipboardPaste size={18} aria-hidden="true"/><span>{t('terminalPasteDraft')}</span>
        </button>
        <button type="button" className="terminal-composer-send" data-primary={sendEnter||undefined} aria-label={t('terminalSendDraft')} title={t('terminalSendDraftDescription')} disabled={!sendReady} onClick={()=>onSubmit(true)}>
          <SendHorizontal size={18} aria-hidden="true"/><span>{t('terminalSendDraft')}</span>
        </button>
      </div>
    </div>
  </div>;
}
