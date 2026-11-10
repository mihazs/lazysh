import {parseChord} from './preferences';

export type NavigationShortcut = 'agents' | 'workspaces';
export type NavigationBindings = Record<NavigationShortcut, string | null>;
export const defaultNavigationBindings: NavigationBindings = {agents: 'C-S-A', workspaces: 'C-S-W'};

/** A navigation binding is one physical key, using the existing terminal chord grammar. */
export function navigationBinding(source: string): string | undefined {
  if (source.startsWith('text:') || /[\s,]/.test(source)) return;
  try { parseChord(source); } catch { return; }
  let rest = source;
  const modifiers = new Set<string>();
  for (;;) {
    const match = /^(Ctrl|Control|Alt|Opt|Option|Shift|C|M|S)[+-]/i.exec(rest);
    if (!match) break;
    modifiers.add(/^(c|ctrl|control)$/i.test(match[1]) ? 'C' : /^(s|shift)$/i.test(match[1]) ? 'S' : 'M');
    rest = rest.slice(match[0].length);
  }
  const aliases: Record<string,string> = {Esc:'Escape', BSpace:'Backspace', dash:'-', plus:'+', comma:'comma'};
  const key = aliases[rest] ?? (rest.length === 1 ? rest.toUpperCase() : rest);
  const ctrl = modifiers.has('C'), alt = modifiers.has('M'), shift = modifiers.has('S');
  if (!ctrl && !alt) return;
  if (ctrl && !alt && ((shift && ['P','Y'].includes(key)) || (!shift && /^[KONW1-9]$/.test(key)))) return;
  return `${ctrl ? 'C-' : ''}${alt ? 'M-' : ''}${shift ? 'S-' : ''}${key}`;
}

export function parseNavigationBindings(value: unknown): NavigationBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {...defaultNavigationBindings};
  const input = value as Record<string, unknown>;
  const read = (name: NavigationShortcut) => input[name] === null ? null : typeof input[name] === 'string' ? navigationBinding(input[name]) : undefined;
  const agents = read('agents'), workspaces = read('workspaces');
  if (agents === undefined || workspaces === undefined || (agents !== null && agents === workspaces)) return {...defaultNavigationBindings};
  return {agents, workspaces};
}
