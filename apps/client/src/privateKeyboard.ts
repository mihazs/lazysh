import {useEffect, useRef} from "react";
import {protectedInvoke} from "./access";
import {isAndroidApp} from "./isAndroidApp";
import {usePreferences} from "./preferences";
import {terminalEditorSelector} from "./terminalAdapter";

const terminalEditor = (node: EventTarget | null) => node instanceof HTMLTextAreaElement && node.matches(terminalEditorSelector);

/**
 * Android's native terminal editor uses the preference regardless of WebView focus. The
 * WebView applies private keyboard flags only to its focused terminal editor.
 */
export function usePrivateKeyboard() {
  const enabled = usePreferences().privateKeyboard === true;
  const shell = useRef<{reported?: {active: boolean; enabled: boolean}; queue: Promise<unknown>}>({queue: Promise.resolve()});
  useEffect(() => {
    if (!isAndroidApp()) return;
    const report = (focused: EventTarget | null) => {
      const active = enabled && terminalEditor(focused);
      const previous = shell.current.reported;
      if (previous?.active === active && previous.enabled === enabled) return;
      const mode = {active, enabled};
      shell.current.reported = mode;
      shell.current.queue = shell.current.queue.then(() => protectedInvoke("terminal_private_keyboard", mode)).catch(() => {
        // A refused report is unknown to the shell; the next focus change sends the state again.
        if (shell.current.reported === mode) shell.current.reported = undefined;
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
