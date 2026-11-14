import type {Disposable, TerminalEvent} from './terminalAdapter';

/** An adapter's listeners: events reach them in order, only for the types each asked for, and never after `clear`. */
export class TerminalEvents {
  private readonly entries = new Set<{listener: (event: TerminalEvent) => void; types?: ReadonlySet<TerminalEvent['type']>}>();

  add(listener: (event: TerminalEvent) => void, types?: readonly TerminalEvent['type'][]): Disposable {
    const entry = {listener, types: types && new Set(types)};
    this.entries.add(entry);
    return {dispose: () => { this.entries.delete(entry); }};
  }

  emit(event: TerminalEvent) {
    for (const {listener, types} of [...this.entries]) if (!types || types.has(event.type)) listener(event);
  }

  /** Whether some listener would receive `type`. */
  wants(type: TerminalEvent['type']) { return [...this.entries].some(({types}) => !types || types.has(type)); }

  clear() { this.entries.clear(); }
}
