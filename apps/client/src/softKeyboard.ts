/**
 * A touch screen raises the soft keyboard for focused text input, so moving between terminals must not
 * focus one by itself. When the keyboard is already up as the user leaves a terminal, the terminal
 * navigated to takes it over instead, so it neither closes nor reopens.
 */
const handoverMs = 1000;
let until = -Infinity;

/** Whether a terminal's own input (its keyboard editor or composer) has focus, which keeps the soft keyboard up. */
export const keyboardOpen = () => !!document.activeElement?.matches('.terminal-pane textarea, .terminal-pane input');
/** Called as a terminal gives up the screen: the next one to take it keeps the keyboard if it was open, or whenever `typing` says it was in use. */
export const carryKeyboard = (typing = false) => {if (typing || keyboardOpen()) until = performance.now() + handoverMs;};
export const keyboardCarried = () => performance.now() < until;

export const touchScreen = () => !!window.matchMedia?.('(pointer: coarse)').matches;
/** Whether activating a terminal may focus its input: on a touch screen only a typing request or a carried keyboard may. */
export const mayFocusOnActivation = (typing: boolean) => !touchScreen() || typing || keyboardCarried();
