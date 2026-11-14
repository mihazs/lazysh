/** The Ctrl/Cmd+Shift keyboard chords that toggle Agents and Workspaces, and the choices that rebind or turn them off. */
export type NavigationShortcut = 'agents' | 'workspaces';
export const navigationShortcutViews = ['agents', 'workspaces'] as const satisfies readonly NavigationShortcut[];
export const navigationShortcutDefaults = {agents: 'A', workspaces: 'W'} as const satisfies Record<NavigationShortcut, string>;
/**
 * Where a changed key (or `off`) is saved: inside `gestureChords`, which clients that predate rebinding read only
 * for gesture slots. They keep the default chords and still import every other synced setting.
 */
export const navigationShortcutSlots = {agents: 'navigationAgents', workspaces: 'navigationWorkspaces'} as const satisfies Record<NavigationShortcut, string>;
export type NavigationShortcutSlot = typeof navigationShortcutSlots[NavigationShortcut];
export type NavigationShortcutChoices = Partial<Record<NavigationShortcutSlot, string>>;
export const navigationShortcutOff = 'off';
/** Ctrl/Cmd+Shift chords the app already claims: Find in the terminal (F), the command palette (P) and the Terminal/Agent view toggle (Y). */
export const reservedNavigationKeys: readonly string[] = ['F', 'P', 'Y'];

/** The key each chord uses, or undefined while it is off. */
export type NavigationShortcutKeys = Readonly<Record<NavigationShortcut, string | undefined>>;
export function navigationShortcutKeys(choices: NavigationShortcutChoices = {}): NavigationShortcutKeys {
  const key = (view: NavigationShortcut) => {
    const choice = choices[navigationShortcutSlots[view]];
    return choice === navigationShortcutOff ? undefined : choice ?? navigationShortcutDefaults[view];
  };
  return {agents: key('agents'), workspaces: key('workspaces')};
}

/**
 * The usable choices in saved or imported settings: a letter that is not reserved, or `off`.
 * Defaults are not stored, and two chords on one key both fall back to their defaults.
 */
export function parseNavigationShortcuts(source: Readonly<Record<string, unknown>>): NavigationShortcutChoices {
  const choices: NavigationShortcutChoices = {};
  for (const view of navigationShortcutViews) {
    const value = source[navigationShortcutSlots[view]];
    const choice = value === navigationShortcutOff ? value : typeof value === 'string' && /^[A-Za-z]$/.test(value) ? value.toUpperCase() : undefined;
    if (choice && choice !== navigationShortcutDefaults[view] && !reservedNavigationKeys.includes(choice)) choices[navigationShortcutSlots[view]] = choice;
  }
  const keys = navigationShortcutKeys(choices);
  return keys.agents !== undefined && keys.agents === keys.workspaces ? {} : choices;
}

/** Whether the chord for `view` may use `key` now, given where the other chord sits. */
export function navigationKeyAvailable(key: string, view: NavigationShortcut, keys: NavigationShortcutKeys): boolean {
  const other = view === 'agents' ? keys.workspaces : keys.agents;
  return !reservedNavigationKeys.includes(key) && key !== other;
}
