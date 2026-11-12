import {t,useUi} from './i18n/core';
import type {SlashCommand} from './agentSlashCommands';

/** The slash commands matching what is typed, as a listbox above the text field. Choosing one only inserts its text. */
export default function AgentComposerPalette({id, items, active, onPick, onHover}: {
  id: string; items: readonly SlashCommand[]; active: number; onPick: (command: SlashCommand) => void; onHover: (index: number) => void;
}) {
  useUi();
  return <ul id={id} className="agent-composer-palette" role="listbox" aria-label={t('agentComposerCommands')}>
    {items.map((command, index) => <li key={command.name} id={`${id}-${command.name}`} role="option" aria-selected={index === active}>
      {/* A pointer or finger picks without taking focus from the text field, so the keyboard stays up. */}
      <button type="button" tabIndex={-1} onPointerDown={event => event.preventDefault()} onMouseEnter={() => onHover(index)} onClick={() => onPick(command)}>
        <code>/{command.name}</code>{command.picker && <small>{t('agentComposerOpensPicker')}</small>}
      </button>
    </li>)}
  </ul>;
}
