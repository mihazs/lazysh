import {useUi} from './i18n/core';

/** One suggestion: what to show and, optionally, a short note after it. */
export type Suggestion = Readonly<{key: string; label: string; hint?: string}>;

/** Suggestions matching what is typed (slash commands, `@` files), as a listbox above the text field. Choosing one only inserts text. */
export default function AgentComposerPalette({id, label, items, active, onPick, onHover}: {
  id: string; label: string; items: readonly Suggestion[]; active: number; onPick: (index: number) => void; onHover: (index: number) => void;
}) {
  useUi();
  return <ul id={id} className="agent-composer-palette" role="listbox" aria-label={label}>
    {items.map((item, index) => <li key={item.key} id={`${id}-${index}`} role="option" aria-selected={index === active}>
      {/* A pointer or finger picks without taking focus from the text field, so the keyboard stays up. */}
      <button type="button" tabIndex={-1} onPointerDown={event => event.preventDefault()} onMouseEnter={() => onHover(index)} onClick={() => onPick(index)}>
        <code>{item.label}</code>{item.hint && <small>{item.hint}</small>}
      </button>
    </li>)}
  </ul>;
}
