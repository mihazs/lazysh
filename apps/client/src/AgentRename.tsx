import {useState} from 'react';
import {Pencil} from 'lucide-react';
import {t} from './i18n/core';
import {maxTitle, reportKey, type AgentSession} from './agentReports';
import {saveName, useNames} from './agentSessionNames';

/** Names a session on this device: the name replaces the reported title everywhere, and saving it empty brings the title back. */
export default function AgentRename({row, host}: {row: AgentSession; host: string}) {
  const own = useNames(host)[reportKey(row)];
  const [draft, setDraft] = useState<string>();
  if (draft === undefined) return <button type="button" className="subtle-button agent-report-rename" onClick={() => setDraft(own ?? row.title ?? '')}><Pencil size={15} aria-hidden="true"/>{t('agentsRename')}</button>;
  return <form className="agent-rename" onSubmit={event => {event.preventDefault(); saveName(host, row, draft); setDraft(undefined);}}>
    <label>{t('agentsRenameLabel')}<input value={draft} maxLength={maxTitle} autoFocus onChange={event => setDraft(event.target.value)} onKeyDown={event => {if (event.key === 'Escape') {event.stopPropagation(); setDraft(undefined);}}}/></label>
    <p className="agent-note">{t('agentsRenameHint')}</p>
    <button type="submit" className="subtle-button">{t('agentsRenameSave')}</button>
    <button type="button" className="subtle-button" onClick={() => setDraft(undefined)}>{t('agentsRenameCancel')}</button>
  </form>;
}
