import {ClipboardPaste,Eraser,Paperclip,SendHorizontal,X} from 'lucide-react';
import {useEffect,useId,useRef,type KeyboardEvent,type Ref} from 'react';
import {t,useUi} from './i18n/core';
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
export default function TerminalComposer({value,onChange,onSubmit,onClose,disabled,sendEnter,textareaRef,onAttach}:{
  value:string;onChange:(value:string)=>void;onSubmit:()=>void;onClose:()=>void;disabled:boolean;sendEnter:boolean;textareaRef?:Ref<HTMLTextAreaElement>;onAttach?:()=>void;
}) {
  useUi();
  const editorId=useId(), hintId=useId();
  const sheet=useRef<HTMLDivElement>(null);
  const editor=useRef<HTMLTextAreaElement|null>(null);
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
    <div className="terminal-draft-editor"><textarea id={editorId} ref={setEditor} rows={6} maxLength={65536} value={value} aria-describedby={hintId} onChange={event=>onChange(event.target.value)}/></div>
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
