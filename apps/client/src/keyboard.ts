export type AppShortcut = { action: "palette" | "switcher" | "newConnection" | "closeSession" } | { action: "session"; index: number };

/** App shortcuts never act inside modal dialogs or editable controls, except the terminal's own input. */
function appTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest('[role="dialog"]')) return false;
  const terminalInput = target.matches('.xterm-helper-textarea') && target.closest('.terminal-canvas');
  return !!terminalInput || !target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
}

export function appShortcut(event: KeyboardEvent): AppShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (!appTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (/^[1-9]$/.test(key)) return {action: "session", index: Number(key) - 1};
  const actions = {k: "palette", o: "switcher", n: "newConnection", w: "closeSession"} as const;
  if (Object.hasOwn(actions, key)) return {action: actions[key as keyof typeof actions]};
}

/** Ctrl/Cmd+Shift+P opens the command palette, including from a focused terminal, whose shell keeps Ctrl/Cmd+K. */
export function paletteShortcut(event: KeyboardEvent): boolean {
  return !event.defaultPrevented && !event.isComposing && !event.repeat && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey
    && event.key.toLowerCase() === 'p' && appTarget(event.target);
}
