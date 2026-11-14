import {FileText,Image as ImageIcon,X} from 'lucide-react';
import {composerTokenText,type ComposerAttachment} from './composerTokens';
import {t} from './i18n/core';

/** The files the draft refers to, one chip each: the token as it will read to the agent, the file name, and a way to drop it. */
export default function AgentComposerChips({attachments,onRemove}:{attachments:readonly ComposerAttachment[];onRemove:(attachment:ComposerAttachment)=>void}) {
  return <ul className="agent-composer-chips" aria-label={t('terminalComposerAttachments')}>
    {attachments.map(attachment=>{
      const label=t(attachment.kind==='image'?'terminalComposerImage':'terminalComposerFile',{number:attachment.number});
      return <li key={attachment.number} data-kind={attachment.kind}>
        {attachment.kind==='image'?<ImageIcon size={14} aria-hidden="true"/>:<FileText size={14} aria-hidden="true"/>}
        <span title={attachment.name}>{composerTokenText(attachment)} {attachment.name}</span>
        <button type="button" className="subtle-button" aria-label={t('terminalComposerRemoveAttachment',{label})} title={t('terminalComposerRemoveAttachment',{label})} onClick={()=>onRemove(attachment)}><X size={14} aria-hidden="true"/></button>
      </li>;
    })}
  </ul>;
}
