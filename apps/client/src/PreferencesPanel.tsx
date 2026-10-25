import { useState } from "react";
import ThemeImportPanel from "./ThemeImportPanel";
import ChordBuilder from "./ChordBuilder";
import { bodyGestureSlots, defaults, gestureActions, gestureDirections, gestureLabels, savePreferences, themes, toolbarKeys, usePreferences, type GestureAction, type GestureSlot, type Preferences, type ToolbarKey } from "./preferences";
import { deleteAllFonts, deleteFont, fontFamilyFor, importFont, resetFontSelection, selectFont, useDeviceFonts } from "./fonts";

export default function PreferencesPanel() {
  const preferences = usePreferences();
  const fonts = useDeviceFonts();
  const [fontBusy, setFontBusy] = useState(false);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [chordLabel, setChordLabel] = useState("");
  async function fontAction(action: () => Promise<unknown>) {
    if (fontBusy) return;
    setFontBusy(true); setError("");
    try {await action();} catch (error) {setError(String(error));} finally {setFontBusy(false);}
  }
  function update(patch: Partial<Preferences>) {
    try { savePreferences({ ...preferences, ...patch }); setError(""); return true; }
    catch { setError("Settings could not be saved on this device."); return false; }
  }
  function move(item: ToolbarKey, delta: number) {
    const toolbar = [...preferences.toolbar];
    const index = toolbar.indexOf(item);
    const other = index + delta;
    if (index < 0 || other < 0 || other >= toolbar.length) return;
    [toolbar[index], toolbar[other]] = [toolbar[other], toolbar[index]];
    update({toolbar});
  }
  function binding(slot: GestureSlot, label: string, action: GestureAction, change: (action: GestureAction) => void, allowed: readonly GestureAction[] = gestureActions) {
    return <div key={slot}><label>{label}<select value={action} onChange={event => change(event.target.value as GestureAction)}>{allowed.map(item => <option key={item} value={item}>{gestureLabels[item]}</option>)}</select></label>
      {action === "custom" && <ChordBuilder key={preferences.gestureChords[slot] ?? ''} label={label} binding={preferences.gestureChords[slot]} onSave={keys => update({gestureChords: {...preferences.gestureChords, [slot]: keys}})} />}
    </div>;
  }
  return <section className="preferences-panel" aria-label="Terminal preferences">
    <h2>Terminal preferences</h2>
    <p>Changes apply to every open terminal.</p>
    {error && <p role="alert">{error}</p>}
    <label>Session switcher layout<select value={preferences.sessionLayout} onChange={e => update({sessionLayout: e.target.value as Preferences["sessionLayout"]})}><option value="list">List</option><option value="cards">Cards</option></select></label>
    <label>App theme<select value={preferences.appTheme} onChange={e => update({appTheme: e.target.value as Preferences["appTheme"]})}>{Object.keys(themes).map(theme => <option key={theme}>{theme}</option>)}{preferences.customThemeInfo && <option value="custom">{preferences.customThemeInfo.name}</option>}</select></label>
    <label>Terminal theme<select value={preferences.theme} onChange={e => update({theme: e.target.value as Preferences["theme"], ...(!preferences.customThemeInfo && e.target.value !== "custom" ? {customTheme: undefined} : {})})}>
      {Object.keys(themes).map(theme => <option key={theme} value={theme}>{theme}</option>)}
      {preferences.customTheme && <option value="custom">Custom</option>}
    </select></label>
    <label>Font size<input type="number" min={10} max={32} value={preferences.fontSize} onChange={e => { if (e.target.value) update({fontSize: Number(e.target.value)}); }} /></label>
    <label>Font family<input maxLength={256} value={preferences.fontFamily} onChange={e => update({fontFamily: e.target.value})} /></label>
    <label>CJK fallback families<input maxLength={256} value={preferences.cjkFallback} onChange={e => update({cjkFallback: e.target.value})} /></label>
    <p>Use installed font families or import local font files below. Imported font files and selections stay on this device.</p>
    <details><summary>Imported fonts</summary>
      {fonts.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
      <label>Import font file<input type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" disabled={fontBusy} onChange={event => {const file = event.target.files?.[0]; event.target.value = ""; if (file) void fontAction(() => importFont(file));}} /></label>
      <p>At most 4 fonts, 24 MiB per font and 48 MiB total. No font downloads run automatically.</p>
      {(["primary", "cjk"] as const).map(role => <label key={role}>{role === "primary" ? "Imported terminal font" : "Imported CJK fallback"}<select disabled={fontBusy} value={fonts.selection[role] ?? ""} onChange={e => void fontAction(() => selectFont(role, e.target.value || undefined))}>
        <option value="">Use installed fallback families</option>
        {fonts.selection[role] && !fonts.fonts.some(font => font.id === fonts.selection[role]) && <option value={fonts.selection[role]}>Missing font — using fallback</option>}
        {fonts.fonts.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}
      </select></label>)}
      <p className="font-sample" style={{fontFamily: fontFamilyFor(preferences, fonts), fontSize: preferences.fontSize}}>lazysh 0123456789 · 中文 日本語 한국어</p>
      <ul>{fonts.fonts.map(font => <li key={font.id}><span>{font.name} ({(font.size / 1024 / 1024).toFixed(2)} MiB)</span><button disabled={fontBusy} aria-label={`Delete font ${font.name}`} onClick={() => void fontAction(() => deleteFont(font.id))}>Delete</button></li>)}</ul>
      <button disabled={fontBusy} onClick={() => void fontAction(deleteAllFonts)}>Delete all imported fonts</button>
    </details>
    <label>Cursor<select value={preferences.cursorStyle} onChange={e => update({cursorStyle: e.target.value as Preferences["cursorStyle"]})}>{["bar", "block", "underline"].map(value => <option key={value}>{value}</option>)}</select></label>
    <label><input type="checkbox" checked={preferences.cursorBlink} onChange={e => update({cursorBlink: e.target.checked})} />Blink cursor</label>
    <label>History lines<input type="number" min={100} max={20000} step={100} value={preferences.scrollback} onChange={e => { if (e.target.value) update({scrollback: Number(e.target.value)}); }} /></label>
    <p>Reducing history removes older local lines.</p>
    <label><input type="checkbox" checked={preferences.optionAsMeta} onChange={e => update({optionAsMeta: e.target.checked})} />Use Option as Meta on macOS</label>
    <label><input type="checkbox" checked={preferences.screenReader} onChange={e => update({screenReader: e.target.checked})} />Screen reader announcements</label>
    <label><input type="checkbox" checked={preferences.pinchZoom} onChange={e => update({pinchZoom: e.target.checked})} />Pinch with two fingers to resize terminal text</label>
    <label><input type="checkbox" checked={preferences.autoHideToolbar} onChange={e => update({autoHideToolbar: e.target.checked})} />Auto-hide toolbar in desktop pointer layouts</label>
    <details><summary>Terminal touch gestures</summary>
      <p>Bindings are optional. Selection, composition and screen reader gestures take priority. Single-finger vertical scrolling stays available. Long presses keep the system selection menu.</p>
      {bodyGestureSlots.map(slot => binding(slot, {tap: "Single tap", doubleTap: "Double tap", tripleTap: "Triple tap", swipeLeft: "Swipe left", swipeRight: "Swipe right"}[slot], preferences.bodyGestures[slot], action => update({bodyGestures: {...preferences.bodyGestures, [slot]: action}})))}
      {gestureDirections.map(direction => binding(`two${direction[0].toUpperCase()}${direction.slice(1)}` as GestureSlot, `Two-finger swipe ${direction}`, preferences.gestures[direction], action => update({gestures: {...preferences.gestures, [direction]: action}})))}
      <p>Add the D-pad item under Toolbar keys to show its arrow grid and corner shortcuts.</p>
      {(["left", "right"] as const).map(corner => binding(corner === "left" ? "cornerLeft" : "cornerRight", `D-pad ${corner} corner`, preferences.dpadCorners[corner], action => update({dpadCorners: {...preferences.dpadCorners, [corner]: action}}), ["none", "backspace", "interrupt", "custom"]))}
      <button onClick={() => update({bodyGestures: {...defaults.bodyGestures}, gestures: {...defaults.gestures}, gestureChords: {}, dpadCorners: {...defaults.dpadCorners}, pinchZoom: defaults.pinchZoom})}>Reset gestures</button>
    </details>
    <ThemeImportPanel preferences={preferences} apply={update} />
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
      <p>Send up to 8 steps: C-b, S-t or Ctrl+b Shift+t. C-/M-/S- and Ctrl+/Opt+/Shift+ modifiers, Esc, BSpace, dash, plus, arrows and F1–F12 are supported. Use text:/clear for literal text. Chords run from their toolbar button or an explicitly configured gesture.</p>
      <ul>{preferences.chords.map((chord, index) => <li key={index}><span>{chord.label}: {chord.keys}</span><button aria-label={`Remove chord ${chord.label}`} onClick={() => update({chords: preferences.chords.filter((_, i) => i !== index)})}>Remove</button></li>)}</ul>
      <label>Chord name<input maxLength={32} value={chordLabel} onChange={e => setChordLabel(e.target.value)} /></label>
      <ChordBuilder disabled={!chordLabel.trim() || preferences.chords.length >= 12} clearAfterSave onSave={keys => {
        if (!update({chords: [...preferences.chords, {label: chordLabel.trim(), keys}]})) return false;
        setChordLabel(''); return true;
      }} />
    </details>
    <button onClick={() => {update({...defaults, toolbar: [...defaults.toolbar], snippets: [], customTheme: undefined, customThemeInfo: undefined}); void fontAction(resetFontSelection);}}>Reset preferences</button>
  </section>;
}
