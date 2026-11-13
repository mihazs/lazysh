import {useEffect, useRef} from "react";
import {protectedInvoke} from "./access";
import {isAndroidApp} from "./isAndroidApp";
import {usePreferences} from "./preferences";
import {terminalEditorSelector} from "./terminalAdapter";

const terminalEditor = (node: EventTarget | null) => node instanceof HTMLTextAreaElement && node.matches(terminalEditorSelector);

/**
 * Android only. While a terminal's hidden editor is focused and Private keyboard is on, tell the shell, which then
 * restarts the keyboard's input with no-learning, no-suggestions and visible-password flags. Every other field,
 * including the Chat composer, reports inactive, so only the terminal is ever changed.
 */
export function usePrivateKeyboard() {
  const enabled = usePreferences().privateKeyboard === true;
  // The first report always goes out, which also resets a shell left active by a reloaded page. The queue keeps reports in order.
  const shell = useRef<{reported?: boolean; queue: Promise<unknown>}>({queue: Promise.resolve()});
  useEffect(() => {
    if (!isAndroidApp()) return;
    const report = (focused: EventTarget | null) => {
      const active = enabled && terminalEditor(focused);
      if (active === shell.current.reported) return;
      shell.current.reported = active;
      shell.current.queue = shell.current.queue.then(() => protectedInvoke("terminal_private_keyboard", {active})).catch(() => {
        // A refused report is unknown to the shell; the next focus change sends the state again.
        shell.current.reported = undefined;
      });
    };
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Focus moves between two events; wait until it lands.
    const focusout = () => { clearTimeout(settle); settle = setTimeout(() => report(document.activeElement), 0); };
    const focusin = (event: FocusEvent) => report(event.target);
    report(document.activeElement);
    document.addEventListener("focusin", focusin);
    document.addEventListener("focusout", focusout);
    return () => {
      clearTimeout(settle);
      document.removeEventListener("focusin", focusin);
      document.removeEventListener("focusout", focusout);
    };
  }, [enabled]);
}
