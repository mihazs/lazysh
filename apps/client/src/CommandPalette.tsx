import {t, useUi} from './i18n/core';
import {useEffect, useId, useRef, useState, type KeyboardEvent} from 'react';
import {Search, Server, TerminalSquare, Wrench, Zap} from 'lucide-react';
import {paletteShortcut} from './keyboard';
import {filterPalette, firstEnabled, movePaletteSelection, type PaletteCommand, type PaletteGroup} from './paletteModel';
import './CommandPalette.css';

const groupIcons = {host: Server, session: TerminalSquare, tool: Wrench, action: Zap} as const;
const groupLabel = (group: PaletteGroup) => t(group === 'host' ? 'paletteGroupHost' : group === 'session' ? 'paletteGroupSession' : group === 'tool' ? 'paletteGroupTool' : 'paletteGroupAction');

/** Keyboard-first combobox over hosts, sessions, workspace tools and actions. */
export default function CommandPalette({commands, query, onQuery, onDone, note}: {
  commands: readonly PaletteCommand[];
  query: string;
  onQuery: (query: string) => void;
  /** Closes the palette before the chosen command runs. */
  onDone: () => void;
  note?: string;
}) {
  useUi();
  const id = useId();
  const shown = filterPalette(commands, query);
  const [selection, setSelection] = useState<{query: string; index: number}>();
  const active = selection?.query === query && shown[selection.index] && !shown[selection.index].disabled ? selection.index : firstEnabled(shown);
  const optionId = (index: number) => `${id}-option-${index}`;
  useEffect(() => { if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({block: 'nearest'}); }, [active, query]);
  function run(command: PaletteCommand | undefined) {
    if (!command || command.disabled) return;
    onDone();
    command.run();
  }
  function keydown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelection({query, index: movePaletteSelection(shown, active, event.key)});
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(shown[active]);
    }
  }
  return <div className="command-palette">
    <div className="command-palette-search">
      <Search size={18} aria-hidden="true"/>
      <input role="combobox" aria-label={t('paletteSearch')} placeholder={t('palettePlaceholder')}
        aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        autoFocus autoComplete="off" spellCheck={false} value={query}
        onChange={event => onQuery(event.target.value)} onKeyDown={keydown}/>
    </div>
    <ul className="command-palette-list" id={`${id}-list`} role="listbox" aria-label={t('paletteResults')}>
      {shown.map((command, index) => {
        const Icon = groupIcons[command.group];
        return <li key={command.id} id={optionId(index)} role="option" aria-selected={index === active}
          aria-disabled={command.disabled || undefined} title={command.disabled ? command.reason : undefined}
          data-current={command.current || undefined}
          onPointerMove={() => { if (!command.disabled && index !== active) setSelection({query, index}); }}
          onMouseDown={event => event.preventDefault()} onClick={() => run(command)}>
          <Icon size={17} aria-hidden="true"/>
          <span className="command-palette-text"><strong>{command.label}</strong>{command.detail && <small>{command.detail}</small>}</span>
          <span className="command-palette-group">{command.current ? t('paletteCurrent') : groupLabel(command.group)}</span>
        </li>;
      })}
    </ul>
    {shown.length === 0 && <p className="muted command-palette-empty">{t('paletteNoMatches')}</p>}
    {note && <p className="muted command-palette-empty">{note}</p>}
    <p className="sr-only" role="status">{t('paletteResultCount', {count: shown.length})}</p>
    <p className="command-palette-hint" aria-hidden="true">{t('paletteHint')}</p>
  </div>;
}

/** Opens the palette on Ctrl/Cmd+Shift+P before the terminal can consume the chord. */
export function usePaletteShortcut(open: () => void) {
  const latest = useRef(open); latest.current = open;
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (!paletteShortcut(event)) return;
      event.preventDefault(); event.stopPropagation();
      latest.current();
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, []);
}
