import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "./bridge";
import type { LiveSession } from "./terminal";
import "@xterm/xterm/css/xterm.css";

export default function TerminalPane({
  session,
  active,
  reportError,
}: {
  session: LiveSession;
  active: boolean;
  reportError: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [ctrl, setCtrl] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const addon = new FitAddon();
    fit.current = addon;
    session.terminal.loadAddon(addon);
    if (session.terminal.element) element.append(session.terminal.element);
    else session.terminal.open(element);
    const output = session.terminal.onData((data) => {
      if (session.connected)
        void api
          .write(session.id, data)
          .catch((error) => reportError(String(error)));
    });
    const size = session.terminal.onResize(({ cols, rows }) => {
      if (session.connected)
        void api
          .resize(session.id, cols, rows)
          .catch((error) => reportError(String(error)));
    });
    const resize = new ResizeObserver(() => {
      if (activeRef.current && element.clientWidth > 0) addon.fit();
    });
    resize.observe(element);
    addon.fit();
    session.terminal.focus();
    return () => {
      resize.disconnect();
      output.dispose();
      size.dispose();
      addon.dispose();
      fit.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        session.terminal.focus();
      });
    }
  }, [active, session]);

  const sendKey = (key: string) => {
    if (!session.connected) return;
    const data =
      ctrl && key.length === 1
        ? String.fromCharCode(key.toUpperCase().charCodeAt(0) & 31)
        : key;
    void api
      .write(session.id, data)
      .catch((error) => reportError(String(error)));
    setCtrl(false);
    session.terminal.focus();
  };

  async function paste() {
    if (!session.connected) return;
    try {
      session.terminal.paste(await navigator.clipboard.readText());
      session.terminal.focus();
    } catch {
      reportError(
        "Clipboard access was unavailable. Paste using your keyboard or system menu.",
      );
    }
  }

  return (
    <div
      className="terminal-pane"
      style={{ display: active ? "flex" : "none" }}
    >
      {!session.connected && (
        <div className="session-notice" role="status">
          Session ended{session.message ? ` · ${session.message}` : ""}. Close
          this tab or connect again from Hosts.
        </div>
      )}
      <div
        ref={container}
        className="terminal-canvas"
        aria-label={`Terminal for ${session.name}`}
      />
      <div className="terminal-keys" aria-label="Terminal keys">
        <button disabled={!session.connected} onClick={() => sendKey("\x1b")}>
          esc
        </button>
        <button
          disabled={!session.connected}
          aria-pressed={ctrl}
          onClick={() => setCtrl(!ctrl)}
        >
          ctrl
        </button>
        <button disabled={!session.connected} onClick={() => sendKey("\t")}>
          tab
        </button>
        <button disabled={!session.connected} onClick={() => sendKey("c")}>
          c
        </button>
        <button disabled={!session.connected} onClick={() => sendKey("d")}>
          d
        </button>
        <button disabled={!session.connected} onClick={() => void paste()}>
          paste
        </button>
        <span />
        <button
          disabled={!session.connected}
          aria-label="Arrow left"
          onClick={() => sendKey("\x1b[D")}
        >
          ←
        </button>
        <button
          disabled={!session.connected}
          aria-label="Arrow up"
          onClick={() => sendKey("\x1b[A")}
        >
          ↑
        </button>
        <button
          disabled={!session.connected}
          aria-label="Arrow down"
          onClick={() => sendKey("\x1b[B")}
        >
          ↓
        </button>
        <button
          disabled={!session.connected}
          aria-label="Arrow right"
          onClick={() => sendKey("\x1b[C")}
        >
          →
        </button>
      </div>
    </div>
  );
}
