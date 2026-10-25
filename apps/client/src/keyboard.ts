export type AppShortcut = { action: "palette" | "switcher" | "newConnection" | "closeSession" } | { action: "session"; index: number };

export function appShortcut(event: KeyboardEvent): AppShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  const target = event.target;
  if (target instanceof Element) {
    if (target.closest('[role="dialog"]')) return;
    const terminalInput = target.matches('.xterm-helper-textarea') && target.closest('.terminal-canvas');
    if (!terminalInput && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
  }
  const key = event.key.toLowerCase();
  if (/^[1-9]$/.test(key)) return {action: "session", index: Number(key) - 1};
  const actions = {k: "palette", o: "switcher", n: "newConnection", w: "closeSession"} as const;
  if (Object.hasOwn(actions, key)) return {action: actions[key as keyof typeof actions]};
}
