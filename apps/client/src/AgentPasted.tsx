import {useState} from 'react';
import {ClipboardPaste} from 'lucide-react';
import {CopyButton} from './AgentToolCard';
import {t} from './i18n/core';

const HEAD_LINES = 3, HEAD_CHARS = 280;

/** Text the person pasted into the prompt: a collapsed preview of its first lines, with Show all and Copy, instead of a wall of text. */
export default function AgentPasted({text}: {text: string}) {
  const [all, setAll] = useState(false);
  const head = text.split('\n').slice(0, HEAD_LINES).join('\n').slice(0, HEAD_CHARS), long = head !== text;
  return <section className="agent-pasted" aria-label={t('agentPastedTitle')}>
    <h5><ClipboardPaste size={14} aria-hidden="true" />{t('agentPastedTitle')}</h5>
    <pre>{all || !long ? text : `${head}…`}</pre>
    <div className="agent-tool-actions">
      {long && <button type="button" className="subtle-button" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? t('agentToolFewer') : t('agentToolShowAll')}</button>}
      <CopyButton text={text} label="agentPastedCopy" />
    </div>
  </section>;
}
