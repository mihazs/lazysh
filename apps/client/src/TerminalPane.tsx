import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { api } from "./bridge";
import { decodeClipboardRequest, parseChord, savePreferences, terminalOptions, usePreferences, type GestureAction, type GestureSlot, type ToolbarKey } from "./preferences";
import type { LiveSession } from "./terminal";
import { fontFamilyFor, useDeviceFonts } from "./fonts";
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
  const fonts = useDeviceFonts();
  const [ctrl, setCtrl] = useState(false);
  const [ctrlLocked, setCtrlLocked] = useState(false);
  const [dpadOpen, setDpadOpen] = useState(false);
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
  const press = useRef<{id: number; x: number; y: number; when: number; moved: boolean} | null>(null);
  const taps = useRef<{count: number; when: number; x: number; y: number; timer?: ReturnType<typeof setTimeout>} | null>(null);
  const gesture = useRef<{x: number; y: number; distance: number; fontSize: number; zoomed: boolean; moved: Set<number>} | null>(null);
  const toolbarVisible = toolbarOverride ?? !(preferences.autoHideToolbar && desktopPointer);
  const customTouch = !preferences.screenReader && (preferences.pinchZoom || Object.values(preferences.gestures).some(action => action !== "none") || Object.values(preferences.bodyGestures).some(action => action !== "none"));

  useEffect(() => {pointers.current.clear(); gesture.current = null; press.current = null; cancelTaps();}, [customTouch]);
  useEffect(() => {if (!active) cancelTaps(); return cancelTaps;}, [active, session.id, preferences.bodyGestures]);

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
      if (imeComposing.current || session.terminal.hasSelection()) return;
      if (event.touches.length === 1) {
        const start = press.current;
        if (!start) return;
        const dx = event.touches[0].clientX - start.x, dy = event.touches[0].clientY - start.y;
        const action = preferences.bodyGestures[dx < 0 ? "swipeLeft" : "swipeRight"];
        if (action === "none" || Math.abs(dx) < 16 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      } else if (event.touches.length !== 2) return;
      // Keep xterm's native vertical scrolling; reserve only configured gestures.
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    };
    element.addEventListener("touchmove", multitouch, {capture: true, passive: false});
    return () => element.removeEventListener("touchmove", multitouch, {capture: true});
  }, [customTouch, session.id, preferences.bodyGestures]);

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
    session.terminal.options = terminalOptions(preferences, fontFamilyFor(preferences, fonts));
    if (active) requestAnimationFrame(() => fit.current?.fit());
  }, [preferences, fonts, session, active]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => { fit.current?.fit(); if (composing) composerInput.current?.focus(); else session.terminal.focus(); });
  }, [active, session, composing]);

  function sendKey(key: string) {
    if (!session.connected) return;
    let data = key;
    if (ctrl || meta) {
      const named: Record<string, string> = {"\x1b": "Escape", "\t": "Tab", "\r": "Enter", "\x7f": "Backspace", "\x1b[D": "Left", "\x1b[A": "Up", "\x1b[B": "Down", "\x1b[C": "Right"};
      try {data = parseChord(`${ctrl ? "Ctrl+" : ""}${meta ? "Alt+" : ""}${named[key] ?? key}`);}
      catch (error) {reportError(String(error)); return;}
    }
    void api.write(session.id, data).catch(error => reportError(String(error)));
    if (!ctrlLocked) setCtrl(false);
    setMeta(false); session.terminal.focus();
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
  function runGesture(action: GestureAction, slot?: GestureSlot) {
    if (action === "find") {setSearching(true); requestAnimationFrame(() => searchInput.current?.focus());}
    else if (action === "compose") setComposing(true);
    else if (action === "keyboard") session.terminal.focus();
    else if (action === "hideKeyboard") session.terminal.blur();
    else if (action === "paste") void paste();
    else if (action === "copy") {const text = session.terminal.getSelection(); if (text) void copy(text);}
    else if (action === "nextSession" || action === "previousSession") window.dispatchEvent(new CustomEvent("lazysh-terminal-action", {detail: {sessionId: session.id, action}}));
    else if (action === "custom") {
      const keys = slot ? preferences.gestureChords[slot] : undefined;
      if (!keys) {reportError("Configure and save a valid chord for this gesture first."); return;}
      try {if (session.connected) void api.write(session.id, parseChord(keys)).catch(error => reportError(String(error)));} catch (error) {reportError(String(error));}
    }
    else {
      const keys = {left: "\x1b[D", right: "\x1b[C", pageUp: "\x1b[5~", pageDown: "\x1b[6~", escape: "\x1b", tab: "\t", backspace: "\x7f", interrupt: "\x03", none: ""}[action];
      if (keys && session.connected) void api.write(session.id, keys).catch(error => reportError(String(error)));
    }
  }
  function cancelTaps() {
    if (taps.current?.timer) clearTimeout(taps.current.timer);
    taps.current = null;
  }
  function tap(x: number, y: number) {
    if (preferences.bodyGestures.tap === "none" && preferences.bodyGestures.doubleTap === "none" && preferences.bodyGestures.tripleTap === "none") return;
    const previous = taps.current;
    const count = previous && Date.now() - previous.when <= 350 && Math.hypot(x - previous.x, y - previous.y) < 24 ? previous.count + 1 : 1;
    cancelTaps();
    const slot = count >= 3 ? "tripleTap" : count === 2 ? "doubleTap" : "tap";
    const perform = () => {
      taps.current = null;
      if (activeRef.current && !imeComposing.current && !session.terminal.hasSelection()) runGesture(preferences.bodyGestures[slot], slot);
    };
    if (count >= 3 || (count === 2 && preferences.bodyGestures.tripleTap === "none") || (count === 1 && preferences.bodyGestures.doubleTap === "none" && preferences.bodyGestures.tripleTap === "none")) perform();
    else taps.current = {count, x, y, when: Date.now(), timer: setTimeout(perform, 350)};
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!customTouch || event.pointerType !== "touch" || imeComposing.current || session.terminal.hasSelection()) return;
    pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (pointers.current.size === 1) {
      if (taps.current?.timer) clearTimeout(taps.current.timer);
      press.current = {id: event.pointerId, x: event.clientX, y: event.clientY, when: Date.now(), moved: false};
    }
    if (pointers.current.size === 2) {
      press.current = null; cancelTaps();
      const [a, b] = [...pointers.current.values()];
      gesture.current = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), fontSize: preferences.fontSize, zoomed: false, moved: new Set()};
    } else if (pointers.current.size > 2) gesture.current = null;
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) {press.current.moved = true; cancelTaps();}
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
    const single = press.current;
    if (single?.id === event.pointerId && pointers.current.size === 1 && !imeComposing.current && !session.terminal.hasSelection()) {
      const dx = event.clientX - single.x, dy = event.clientY - single.y;
      if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        const slot = dx < 0 ? "swipeLeft" : "swipeRight";
        runGesture(preferences.bodyGestures[slot], slot);
      } else if (!single.moved && Math.hypot(dx, dy) <= 10 && Date.now() - single.when <= 500) tap(event.clientX, event.clientY);
      else cancelTaps();
    }
    if (start && pointers.current.size === 2 && !start.zoomed && !imeComposing.current && !session.terminal.hasSelection()) {
      pointers.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
      const [a, b] = [...pointers.current.values()];
      const dx = (a.x + b.x) / 2 - start.x, dy = (a.y + b.y) / 2 - start.y;
      const scale = Math.hypot(a.x - b.x, a.y - b.y) / start.distance;
      if (preferences.pinchZoom && Math.abs(scale - 1) >= .08) {
        try {savePreferences({...preferences, fontSize: Math.max(10, Math.min(32, Math.round(start.fontSize * scale)))});} catch {reportError("Font size could not be saved.");}
      } else if (Math.max(Math.abs(dx), Math.abs(dy)) >= 60) {
        const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        const slot = {left: "twoLeft", right: "twoRight", up: "twoUp", down: "twoDown"}[direction] as GestureSlot;
        runGesture(preferences.gestures[direction], slot);
      }
    }
    pointers.current.delete(event.pointerId);
    press.current = null;
    gesture.current = null;
  }
  return <div className="terminal-pane" style={{display: active ? "flex" : "none"}}>
    {(fonts.selection.primary || fonts.selection.cjk) && fonts.warnings.map(warning => <div className="session-notice" role="note" key={warning}>{warning}</div>)}
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
    <div ref={container} className="terminal-canvas" style={{touchAction: customTouch ? "none" : "auto"}} aria-label={`Terminal for ${session.name}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => {pointers.current.clear(); gesture.current = null; press.current = null; cancelTaps();}} onCompositionStartCapture={() => {imeComposing.current = true; pointers.current.clear(); gesture.current = null; press.current = null; cancelTaps();}} onCompositionEndCapture={() => {imeComposing.current = false;}} />
    {composing && <div className="terminal-compose"><label>Compose text<textarea ref={composerInput} maxLength={65536} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <button disabled={!session.connected || !draft} onClick={() => {session.terminal.paste(draft); setDraft(""); session.terminal.focus();}}>Paste draft</button><button onClick={() => setComposing(false)}>Close composer</button>
    </div>}
    <div className="terminal-toolbar-toggle"><button onClick={() => setToolbarOverride(!toolbarVisible)} aria-expanded={toolbarVisible}>{toolbarVisible ? "Hide terminal keys" : "Show terminal keys"}</button></div>
    {ctrlLocked && <div className="session-notice" role="status">Control is locked. Tap ctrl to release it.</div>}
    {toolbarVisible && dpadOpen && preferences.toolbar.includes("dpad") && <div className="terminal-dpad" role="group" aria-label="Terminal D-pad">
      {preferences.dpadCorners.left === "none" ? <span /> : <button disabled={!session.connected} aria-label="D-pad left corner" title={preferences.gestureChords.cornerLeft ?? preferences.dpadCorners.left} onClick={() => runGesture(preferences.dpadCorners.left, "cornerLeft")}>{preferences.dpadCorners.left === "interrupt" ? "^C" : preferences.dpadCorners.left === "backspace" ? "⌫" : "1"}</button>}
      <button disabled={!session.connected} aria-label="D-pad up" onClick={() => sendKey("\x1b[A")}>↑</button>
      {preferences.dpadCorners.right === "none" ? <span /> : <button disabled={!session.connected} aria-label="D-pad right corner" title={preferences.gestureChords.cornerRight ?? preferences.dpadCorners.right} onClick={() => runGesture(preferences.dpadCorners.right, "cornerRight")}>{preferences.dpadCorners.right === "backspace" ? "⌫" : preferences.dpadCorners.right === "interrupt" ? "^C" : "2"}</button>}
      <button disabled={!session.connected} aria-label="D-pad left" onClick={() => sendKey("\x1b[D")}>←</button><button disabled={!session.connected} aria-label="D-pad down" onClick={() => sendKey("\x1b[B")}>↓</button><button disabled={!session.connected} aria-label="D-pad right" onClick={() => sendKey("\x1b[C")}>→</button>
    </div>}
    {toolbarVisible && <div className="terminal-keys" aria-label="Terminal keys">
      {preferences.toolbar.map(key => <button key={key} disabled={!session.connected && key !== "dpad"} aria-pressed={key === "ctrl" ? ctrl : key === "meta" ? meta : key === "dpad" ? dpadOpen : undefined} aria-label={labels[key] ? `Arrow ${key}` : undefined} title={key === "ctrl" ? ctrlLocked ? "Control locked; tap to release" : "Double-tap to lock Control" : undefined} onDoubleClick={() => {if (key === "ctrl") {setCtrl(true); setCtrlLocked(true);}}} onClick={() => {
        if (key === "ctrl") {if (ctrlLocked) {setCtrlLocked(false); setCtrl(false);} else setCtrl(!ctrl);}
        else if (key === "meta") setMeta(!meta);
        else if (key === "paste") void paste();
        else if (key === "dpad") setDpadOpen(!dpadOpen);
        else sendKey(sequences[key] ?? key);
      }}>{labels[key] ?? key}{key === "ctrl" && ctrlLocked ? " · lock" : ""}</button>)}
      {preferences.snippets.map((snippet, index) => <button key={`snippet-${index}`} disabled={!session.connected} onClick={() => {setDraft(snippet.text); setComposing(true);}}>{snippet.label}</button>)}
      {preferences.chords.map((chord, index) => <button key={`chord-${index}`} title={chord.keys} disabled={!session.connected} onClick={() => {try {void api.write(session.id, parseChord(chord.keys)).catch(error => reportError(String(error))); session.terminal.focus();} catch (error) {reportError(String(error));}}}>{chord.label}</button>)}
      <button onClick={() => {setSearching(!searching); requestAnimationFrame(() => searchInput.current?.focus());}}>Find</button>
      <button onClick={() => {const text = session.terminal.getSelection(); if (text) void copy(text); else reportError("Select terminal text before copying.");}}>Copy</button>
      <button onClick={() => setComposing(!composing)}>Compose</button>
    </div>}
  </div>;
}
