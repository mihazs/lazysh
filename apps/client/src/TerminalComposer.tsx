import {ClipboardPaste,Paperclip,X} from 'lucide-react';
import {useId,type Ref} from 'react';
import {t,useUi} from './i18n/core';
import './TerminalComposer.css';

/** The caller retains the session, draft and literal-paste authority. */
export default function TerminalComposer({value,onChange,onPaste,onClose,disabled,textareaRef,onAttach}:{
  value:string;onChange:(value:string)=>void;onPaste:()=>void;onClose:()=>void;disabled:boolean;textareaRef?:Ref<HTMLTextAreaElement>;onAttach?:()=>void;
}) {
  useUi();
  const editorId=useId();
  return <div className="terminal-compose terminal-draft-composer">
    <div className="terminal-draft-editor"><label className="sr-only" htmlFor={editorId}>{t('terminalComposeText')}</label><textarea id={editorId} ref={textareaRef} rows={2} maxLength={65536} value={value} onChange={event=>onChange(event.target.value)}/></div>
    <div className="terminal-compose-actions terminal-draft-actions"><div>{onAttach&&<button type="button" className="icon-button" title={t('appAttach')} aria-label={t('appAttach')} onClick={onAttach}><Paperclip size={18} aria-hidden="true"/></button>}
      <button type="button" className="icon-button" title={t('terminalCloseComposer')} aria-label={t('terminalCloseComposer')} onClick={onClose}><X size={18} aria-hidden="true"/></button></div>
      <button type="button" className="icon-button terminal-draft-paste" title={t('terminalPasteDraft')} aria-label={t('terminalPasteDraft')} disabled={disabled} onClick={onPaste}><ClipboardPaste size={18} aria-hidden="true"/></button>
    </div>
  </div>;
}
