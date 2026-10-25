import { useState } from "react";
import { defaults, gestureActions, gestureDirections, parseChord, parseTheme, savePreferences, themes, toolbarKeys, usePreferences, type GestureAction, type Preferences, type ToolbarKey } from "./preferences";

export default function PreferencesPanel() {
  const preferences = usePreferences();
  const [error, setError] = useState("");
  const [themeJson, setThemeJson] = useState("");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [chordLabel, setChordLabel] = useState("");
  const [keys, setKeys] = useState("");
  function update(patch: Partial<Preferences>) {
    try { savePreferences({ ...preferences, ...patch }); setError(""); }
    catch { setError("Settings could not be saved on this device."); }
  }
  function move(item: ToolbarKey, delta: number) {
    const toolbar = [...preferences.toolbar];
    const index = toolbar.indexOf(item);
    const other = index + delta;
    if (index < 0 || other < 0 || other >= toolbar.length) return;
    [toolbar[index], toolbar[other]] = [toolbar[other], toolbar[index]];
    update({toolbar});
  }
  return <section className="preferences-panel" aria-label="Terminal preferences">
    <h2>Terminal preferences</h2>
    <p>Changes apply to every open terminal. Settings stay on this device.</p>
    {error && <p role="alert">{error}</p>}
    <label>Theme<select value={preferences.customTheme ? "custom" : preferences.theme} onChange={e => update({theme: e.target.value as Preferences["theme"], customTheme: undefined})}>
      {Object.keys(themes).map(theme => <option key={theme} value={theme}>{theme}</option>)}
      {preferences.customTheme && <option value="custom">Custom</option>}
    </select></label>
    <label>Font size<input type="number" min={10} max={32} value={preferences.fontSize} onChange={e => { if (e.target.value) update({fontSize: Number(e.target.value)}); }} /></label>
    <label>Font family<input maxLength={256} value={preferences.fontFamily} onChange={e => update({fontFamily: e.target.value})} /></label>
    <p>Use a font installed on your device; include a CJK fallback where needed.</p>
    <label>Cursor<select value={preferences.cursorStyle} onChange={e => update({cursorStyle: e.target.value as Preferences["cursorStyle"]})}>{["bar", "block", "underline"].map(value => <option key={value}>{value}</option>)}</select></label>
    <label><input type="checkbox" checked={preferences.cursorBlink} onChange={e => update({cursorBlink: e.target.checked})} />Blink cursor</label>
    <label>History lines<input type="number" min={100} max={20000} step={100} value={preferences.scrollback} onChange={e => { if (e.target.value) update({scrollback: Number(e.target.value)}); }} /></label>
    <p>Reducing history removes older local lines.</p>
    <label><input type="checkbox" checked={preferences.optionAsMeta} onChange={e => update({optionAsMeta: e.target.checked})} />Use Option as Meta on macOS</label>
    <label><input type="checkbox" checked={preferences.screenReader} onChange={e => update({screenReader: e.target.checked})} />Screen reader announcements</label>
    <label><input type="checkbox" checked={preferences.pinchZoom} onChange={e => update({pinchZoom: e.target.checked})} />Pinch with two fingers to resize terminal text</label>
    <label><input type="checkbox" checked={preferences.autoHideToolbar} onChange={e => update({autoHideToolbar: e.target.checked})} />Auto-hide toolbar in desktop pointer layouts</label>
    <details><summary>Two-finger swipe actions</summary>
      <p>Gestures leave text selection and composition alone. Single-finger scrolling stays available.</p>
      {gestureDirections.map(direction => <label key={direction}>Swipe {direction}<select value={preferences.gestures[direction]} onChange={e => update({gestures: {...preferences.gestures, [direction]: e.target.value as GestureAction}})}>{gestureActions.map(action => <option key={action} value={action}>{action}</option>)}</select></label>)}
    </details>
    <details><summary>Import terminal theme</summary>
      <label>Theme JSON<textarea maxLength={4096} value={themeJson} onChange={e => setThemeJson(e.target.value)} placeholder={'{"background":"#101311","foreground":"#d9e0d6"}'} /></label>
      <button onClick={() => { try { update({customTheme: parseTheme(JSON.parse(themeJson))}); } catch (e) { setError(String(e)); } }}>Import theme</button>
    </details>
    <details><summary>Toolbar keys and order</summary>
      <ul>{preferences.toolbar.map((key, index) => <li key={key}><span>{key}</span><button aria-label={`Move ${key} earlier`} disabled={index === 0} onClick={() => move(key, -1)}>↑</button><button aria-label={`Move ${key} later`} disabled={index === preferences.toolbar.length - 1} onClick={() => move(key, 1)}>↓</button><button aria-label={`Remove ${key}`} onClick={() => update({toolbar: preferences.toolbar.filter(item => item !== key)})}>Remove</button></li>)}</ul>
      {toolbarKeys.filter(key => !preferences.toolbar.includes(key)).map(key => <button key={key} onClick={() => update({toolbar: [...preferences.toolbar, key]})}>Add {key}</button>)}
    </details>
    <details><summary>Text snippets</summary>
      <p>Snippets paste literal text into the active program. Review text before pressing Enter.</p>
      <ul>{preferences.snippets.map((snippet, index) => <li key={index}><span>{snippet.label}</span><button aria-label={`Remove snippet ${snippet.label}`} onClick={() => update({snippets: preferences.snippets.filter((_, i) => i !== index)})}>Remove</button></li>)}</ul>
      <label>Snippet name<input maxLength={32} value={label} onChange={e => setLabel(e.target.value)} /></label>
      <label>Snippet text<textarea maxLength={2048} value={text} onChange={e => setText(e.target.value)} /></label>
      <button disabled={!label.trim() || !text || preferences.snippets.length >= 12} onClick={() => { update({snippets: [...preferences.snippets, {label: label.trim(), text}]}); setLabel(""); setText(""); }}>Add snippet</button>
    </details>
    <details><summary>Keyboard chords</summary>
      <p>Send up to 8 steps to the terminal. Example: Ctrl+b n. Use Ctrl, Alt, Shift, arrows, Enter, Escape, Tab, Space, PageUp, PageDown, Home, End, Insert, Delete, Backspace, or F1–F12. Chords run only when you press their toolbar button.</p>
      <ul>{preferences.chords.map((chord, index) => <li key={index}><span>{chord.label}: {chord.keys}</span><button aria-label={`Remove chord ${chord.label}`} onClick={() => update({chords: preferences.chords.filter((_, i) => i !== index)})}>Remove</button></li>)}</ul>
      <label>Chord name<input maxLength={32} value={chordLabel} onChange={e => setChordLabel(e.target.value)} /></label>
      <label>Key sequence<input maxLength={128} value={keys} onChange={e => setKeys(e.target.value)} /></label>
      <button disabled={!chordLabel.trim() || !keys.trim() || preferences.chords.length >= 12} onClick={() => {try {parseChord(keys); update({chords: [...preferences.chords, {label: chordLabel.trim(), keys: keys.trim()}]}); setChordLabel(""); setKeys("");} catch (e) {setError(String(e));}}}>Add chord</button>
    </details>
    <button onClick={() => update({...defaults, toolbar: [...defaults.toolbar], snippets: [], customTheme: undefined})}>Reset preferences</button>
  </section>;
}
