import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { api } from "./bridge";
import { decodeClipboardRequest, parseChord, savePreferences, terminalOptions, usePreferences, type GestureAction, type ToolbarKey } from "./preferences";
import type { LiveSession } from "./terminal";
import "@xterm/xterm/css/xterm.css";

const sequences: Partial<Record<ToolbarKey, string>> = {esc: "\x1b", tab: "\t", c: "c", d: "d", enter: "\r", backspace: "\x7f", left: "\x1b[D", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C"};
const labels: Partial<Record<ToolbarKey, string>> = {left: "←", up: "↑", down: "↓", right: "→"};

export function terminalWebUrl(value: string): string | undefined {
  if (value.length > 4096 || /[\s\x00-\x1f\x7f-\x9f\\]/.test(value) || !/^https?:\/\//i.test(value)) return;
  const authority = value.split('://')[1].split(/[/?#]/)[0];
  if (!authority || authority.includes('@')) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password && url.href.length <= 4096) return url.href;
  } catch { /* Ignore malformed remote links. */ }
}

export default function TerminalPane({ session, active, reportError }: {
  session: LiveSession;
  active: boolean;
  reportError: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const preferences = usePreferences();
  const [ctrl, setCtrl] = useState(false);
  const [meta, setMeta] = useState(false);
  const [clipboard, setClipboard] = useState<string | null>(null);
  const pendingClipboard = useRef(false);
  const [link, setLink] = useState<string | null>(null);
  const [openingLink, setOpeningLink] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchLine = useRef(-1);
  const [searchStatus, setSearchStatus] = useState("");
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [toolbarOverride, setToolbarOverride] = useState<boolean | null>(null);
  const [desktopPointer, setDesktopPointer] = useState(false);
  const imeComposing = useRef(false);
  const pointers = useRef(new Map<number, {x: number; y: number}>());
  const gesture = useRef<{x: number; y: number; distance: number; fontSize: number; zoomed: boolean; moved: Set<number>} | null>(null);
  const toolbarVisible = toolbarOverride ?? !(preferences.autoHideToolbar && desktopPointer);
  const customTouch = !preferences.screenReader && (preferences.pinchZoom || Object.values(preferences.gestures).some(action => action !== "none"));

  useEffect(() => {pointers.current.clear(); gesture.current = null;}, [customTouch]);

  useEffect(() => {
    const stage = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (!detail || typeof detail !== "object") return;
      const { sessionId, text } = detail as Record<string, unknown>;
      if (sessionId !== session.id || typeof text !== "string" || text.length === 0 || text.length > 65536) return;
      const next = draftRef.current ? `${draftRef.current}\n\n${text}` : text;
      if (next.length > 65536) {reportError("The combined draft exceeds 65,536 characters. Shorten the current draft first."); return;}
      draftRef.current = next;
      setDraft(next); setComposing(true);
    };
    window.addEventListener("lazysh-prompt-draft", stage);
    return () => window.removeEventListener("lazysh-prompt-draft", stage);
  }, [session.id, reportError]);

  useEffect(() => {
    if (composing && active) composerInput.current?.focus();
  }, [composing, active, draft]);

  useEffect(() => {
    const element = container.current;
    if (!element || !customTouch) return;
    const multitouch = (event: TouchEvent) => {
      if (event.touches.length !== 2 || imeComposing.current || session.terminal.hasSelection()) return;
      // xterm scrolls from the first touch; reserve two touches for configured gestures.
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    };
    element.addEventListener("touchmove", multitouch, {capture: true, passive: false});
    return () => element.removeEventListener("touchmove", multitouch, {capture: true});
  }, [customTouch, session.id]);

  useEffect(() => {
    const query = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    if (!query) return;
    const update = () => setDesktopPointer(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const terminal = session.terminal;
    const addon = new FitAddon();
    fit.current = addon;
    terminal.loadAddon(addon);
    const links = new WebLinksAddon((_event, uri) => {
      const url = terminalWebUrl(uri);
      if (url) setLink(url);
    });
    terminal.loadAddon(links);
    const osc = terminal.parser.registerOscHandler(52, data => {
      const text = decodeClipboardRequest(data);
      if (text !== undefined && !pendingClipboard.current) {
        pendingClipboard.current = true;
        setClipboard(text);
      }
      return true;
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === "keydown" && !event.isComposing && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        setSearching(true);
        requestAnimationFrame(() => searchInput.current?.focus());
        return false;
      }
      return true;
    });
    if (terminal.element) element.append(terminal.element);
    else terminal.open(element);
    const output = terminal.onData(data => {
      if (session.connected) void api.write(session.id, data).catch(error => reportError(String(error)));
    });
    const size = terminal.onResize(({ cols, rows }) => {
      if (session.connected) void api.resize(session.id, cols, rows).catch(error => reportError(String(error)));
    });
    const resize = new ResizeObserver(() => {
      if (activeRef.current && element.clientWidth > 0) addon.fit();
    });
    resize.observe(element);
    addon.fit();
    terminal.focus();
    return () => {
      resize.disconnect(); output.dispose(); size.dispose(); osc.dispose(); links.dispose(); addon.dispose();
      terminal.attachCustomKeyEventHandler(() => true);
      fit.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    session.terminal.options = terminalOptions(preferences);
    if (active) requestAnimationFrame(() => fit.current?.fit());
  }, [preferences, session, active]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => { fit.current?.fit(); if (composing) composerInput.current?.focus(); else session.terminal.focus(); });
  }, [active, session, composing]);

  function sendKey(key: string) {
    if (!session.connected) return;
    let data = ctrl && key.length === 1 ? String.fromCharCode(key.toUpperCase().charCodeAt(0) & 31) : key;
    if (meta) data = `\x1b${data}`;
    void api.write(session.id, data).catch(error => reportError(String(error)));
    setCtrl(false); setMeta(false); session.terminal.focus();
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); }
    catch { reportError("Clipboard access was unavailable. Use your system copy menu."); }
  }
  async function openLink() {
    if (!link || openingLink) return;
    const selected = link;
    setOpeningLink(true);
    try { await api.openWebUrl(selected); setLink(current => current === selected ? null : current); }
    catch (error) { reportError(typeof error === 'string' ? error : 'The system browser could not open this link. Copy its URL instead.'); }
    finally { setOpeningLink(false); }
  }
  async function paste() {
    if (!session.connected) return;
    try { session.terminal.paste(await navigator.clipboard.readText()); session.terminal.focus(); }
    catch { reportError("Clipboard access was unavailable. Paste using your keyboard or system menu."); }
  }
  function search(direction: number) {
    if (!query) return;
    const buffer = session.terminal.buffer.active;
    const start = searchLine.current < 0 ? (direction > 0 ? -1 : buffer.length) : searchLine.current;
    for (let offset = 1; offset <= buffer.length; offset++) {
      const line = (start + offset * direction + buffer.length * 2) % buffer.length;
      const text = buffer.getLine(line)?.translateToString(true) ?? "";
      const column = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (column >= 0) {
        searchLine.current = line;
        session.terminal.scrollToLine(line);
        session.terminal.select(0, line, text.length);
        setSearchStatus(`Match on line ${line + 1}`);
        return;
      }
    }
    setSearchStatus("No match in retained history.");
  }
  function runGesture(action: GestureAction) {
    if (action === "find") {setSearching(true); requestAnimationFrame(() => searchInput.current?.focus());}
    else if (action === "compose") setComposing(true);
    else {
      const keys = {left: "\x1b[D", right: "\x1b[C", pageUp: "\x1b[5~", pageDown: "\x1b[6~", escape: "\x1b", tab: "\t", none: ""}[action];
      if (keys && session.connected) void api.write(session.id, keys).catch(error => reportError(String(error)));
    }
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!customTouch || event.pointerType !== "touch" || imeComposing.current || session.terminal.hasSelection()) return;
    pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), fontSize: preferences.fontSize, zoomed: false, moved: new Set()};
    } else if (pointers.current.size > 2) gesture.current = null;
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (!gesture.current || pointers.current.size !== 2) return;
    if (imeComposing.current || session.terminal.hasSelection()) {gesture.current = null; return;}
    gesture.current.moved.add(event.pointerId);
    // Wait for both touches so a parallel swipe cannot look like a one-sided pinch.
    if (gesture.current.moved.size < 2) return;
    gesture.current.moved.clear();
    const [a, b] = [...pointers.current.values()];
    const scale = Math.hypot(a.x - b.x, a.y - b.y) / gesture.current.distance;
    if (preferences.pinchZoom && Math.abs(scale - 1) >= .08) {
      gesture.current.zoomed = true;
      if (event.cancelable) event.preventDefault();
      const fontSize = Math.max(10, Math.min(32, Math.round(gesture.current.fontSize * scale)));
      if (fontSize !== preferences.fontSize) {
        try {savePreferences({...preferences, fontSize});} catch {reportError("Font size could not be saved.");}
      }
    }
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = gesture.current;
    if (start && pointers.current.size === 2 && !start.zoomed && !imeComposing.current && !session.terminal.hasSelection()) {
      pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
      const [a, b] = [...pointers.current.values()];
      const dx = (a.x + b.x) / 2 - start.x, dy = (a.y + b.y) / 2 - start.y;
      const scale = Math.hypot(a.x - b.x, a.y - b.y) / start.distance;
      if (preferences.pinchZoom && Math.abs(scale - 1) >= .08) {
        try {savePreferences({...preferences, fontSize: Math.max(10, Math.min(32, Math.round(start.fontSize * scale)))});} catch {reportError("Font size could not be saved.");}
      } else if (Math.max(Math.abs(dx), Math.abs(dy)) >= 60) runGesture(preferences.gestures[Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up")]);
    }
    pointers.current.delete(event.pointerId);
    gesture.current = null;
  }
  return <div className="terminal-pane" style={{display: active ? "flex" : "none"}}>
    {!session.connected && <div className="session-notice" role="status">Session ended{session.message ? ` · ${session.message}` : ""}. Close this tab or connect again from Hosts.</div>}
    {clipboard !== null && <div className="terminal-consent" role="region" aria-label="Remote clipboard request">
      <p>The remote program wants to replace your clipboard ({clipboard.length} characters).</p>
      <pre>{clipboard.slice(0, 500)}{clipboard.length > 500 ? "…" : ""}</pre>
      <button onClick={() => { void copy(clipboard); setClipboard(null); pendingClipboard.current = false; }}>Allow this copy</button>
      <button onClick={() => { setClipboard(null); pendingClipboard.current = false; }}>Deny</button>
    </div>}
    {link && <div className="terminal-consent" role="region" aria-label="Terminal link">
      <p>{link}</p><button disabled={openingLink} onClick={() => void openLink()}>{openingLink ? 'Opening…' : 'Open in browser'}</button><button onClick={() => void copy(link)}>Copy URL</button><button onClick={() => setLink(null)}>Dismiss link</button>
    </div>}
    {searching && <form className="terminal-search" onSubmit={event => {event.preventDefault(); search(1);}}>
      <input ref={searchInput} aria-label="Search terminal history" maxLength={256} value={query} onChange={event => {setQuery(event.target.value); searchLine.current = -1; setSearchStatus("");}} />
      <button>Next</button><button type="button" onClick={() => search(-1)}>Previous</button><button type="button" onClick={() => {setSearching(false); session.terminal.focus();}}>Close search</button>
      <span role="status">{searchStatus}</span>
    </form>}
    <div ref={container} className="terminal-canvas" style={{touchAction: customTouch ? "none" : "auto"}} aria-label={`Terminal for ${session.name}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => {pointers.current.clear(); gesture.current = null;}} onCompositionStartCapture={() => {imeComposing.current = true; pointers.current.clear(); gesture.current = null;}} onCompositionEndCapture={() => {imeComposing.current = false;}} />
    {composing && <div className="terminal-compose"><label>Compose text<textarea ref={composerInput} maxLength={65536} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <button disabled={!session.connected || !draft} onClick={() => {session.terminal.paste(draft); setDraft(""); session.terminal.focus();}}>Paste draft</button><button onClick={() => setComposing(false)}>Close composer</button>
    </div>}
    <div className="terminal-toolbar-toggle"><button onClick={() => setToolbarOverride(!toolbarVisible)} aria-expanded={toolbarVisible}>{toolbarVisible ? "Hide terminal keys" : "Show terminal keys"}</button></div>
    {toolbarVisible && <div className="terminal-keys" aria-label="Terminal keys">
      {preferences.toolbar.map(key => <button key={key} disabled={!session.connected} aria-pressed={key === "ctrl" ? ctrl : key === "meta" ? meta : undefined} aria-label={labels[key] ? `Arrow ${key}` : undefined} onClick={() => {
        if (key === "ctrl") setCtrl(!ctrl);
        else if (key === "meta") setMeta(!meta);
        else if (key === "paste") void paste();
        else sendKey(sequences[key] ?? key);
      }}>{labels[key] ?? key}</button>)}
      {preferences.snippets.map((snippet, index) => <button key={`snippet-${index}`} disabled={!session.connected} onClick={() => {setDraft(snippet.text); setComposing(true);}}>{snippet.label}</button>)}
      {preferences.chords.map((chord, index) => <button key={`chord-${index}`} title={chord.keys} disabled={!session.connected} onClick={() => {try {void api.write(session.id, parseChord(chord.keys)).catch(error => reportError(String(error))); session.terminal.focus();} catch (error) {reportError(String(error));}}}>{chord.label}</button>)}
      <button onClick={() => {setSearching(!searching); requestAnimationFrame(() => searchInput.current?.focus());}}>Find</button>
      <button onClick={() => {const text = session.terminal.getSelection(); if (text) void copy(text); else reportError("Select terminal text before copying.");}}>Copy</button>
      <button onClick={() => setComposing(!composing)}>Compose</button>
    </div>}
  </div>;
}
