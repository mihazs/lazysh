import {t, useUi} from './i18n/core';

/** Two quick inserts for a touch keyboard, where `/` and `@` sit on a second page: the slash commands and the file mentions.
 * They only put the character in the text field; the palette that opens is the one a typed character opens. */
export default function AgentComposerInsert({commands, files, onCommand, onFile}: {commands: boolean; files: boolean; onCommand: () => void; onFile: () => void}) {
  useUi();
  if (!commands && !files) return null;
  // A finger picks without taking focus from the text field, so the keyboard stays up.
  const keep = (event: {preventDefault: () => void}) => event.preventDefault();
  return <div className="agent-composer-insert" role="group" aria-label={t('agentComposerInsert')}>
    {commands && <button type="button" onPointerDown={keep} onClick={onCommand}><span aria-hidden="true">/</span>{t('agentComposerChipCommands')}</button>}
    {files && <button type="button" onPointerDown={keep} onClick={onFile}><span aria-hidden="true">@</span>{t('agentComposerChipFiles')}</button>}
  </div>;
}
