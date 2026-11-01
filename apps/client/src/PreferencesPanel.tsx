import {t, useUi, formatNumber} from './i18n/core';
import { useEffect, useRef, useState } from "react";
import {LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import FontDownloadPanel from "./FontDownloadPanel";
import AppIconPanel from "./AppIconPanel";
import {useMountedAccess} from './access';
import {applyPreferenceIntent, nativeLocale, PreferenceStorageError, useNativeLocale} from './i18n/nativeLocale';
import ThemeImportPanel from "./ThemeImportPanel";
import ChordBuilder from "./ChordBuilder";
import { bodyGestureSlots, defaults, gestureActions, gestureDirections, gestureLabelKeys, savePreferences, themes, toolbarKeyLabel, toolbarKeys, usePreferences, type GestureAction, type GestureSlot, type Preferences, type ToolbarKey } from "./preferences";
import { deleteAllFonts, deleteFont, fontFamilyFor, fontErrorCause, fontWarningKey, fontWarningText, importFont, resetFontSelection, selectFont, useDeviceFonts } from "./fonts";

export default function PreferencesPanel() {
  useUi();
  const preferences = usePreferences();
  const locale=useNativeLocale();
  const owner=useMountedAccess();
  const current=()=>owner.mounted.current && owner.access.current();
  const languageBusy=locale.phase!=='ready';
  const fonts = useDeviceFonts();
  const fontOperation=useRef(false);
  const [fontBusy, setFontBusy] = useState(false);
  const [error, setError] = useState<UiErrorCause>("");
  const [languageError, setLanguageError] = useState<'language'|'settings'|undefined>();
  useEffect(()=>{if(locale.phase==='ready')setLanguageError(undefined);},[locale.phase]);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [chordLabel, setChordLabel] = useState("");
  async function fontAction(action: () => Promise<unknown>) {
    if (fontOperation.current || !current()) return;
    fontOperation.current=true;
    setFontBusy(true); setError("");
    try {await action();} catch (error) {if(current())setError(fontErrorCause(error));} finally {fontOperation.current=false;if(current())setFontBusy(false);}
  }
  function update(patch: Partial<Preferences>) {
    try { savePreferences({ ...preferences, ...patch }); setError(""); return true; }
    catch { setError(new LocalUiError('preferencesSettingsCouldNotBeSavedOnThisDevice')); return false; }
  }
  async function languageAction(action:()=>Promise<void>) {
    try {await action();if(current())setLanguageError(undefined);}
    catch (error) {if(current())setLanguageError(error instanceof PreferenceStorageError?'settings':'language');}
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
    return <div key={slot}><label>{label}<select value={action} onChange={event => change(event.target.value as GestureAction)}>{allowed.map(item => <option key={item} value={item}>{t(gestureLabelKeys[item])}</option>)}</select></label>
      {action === "custom" && <ChordBuilder key={preferences.gestureChords[slot] ?? ''} label={label} binding={preferences.gestureChords[slot]} onSave={keys => update({gestureChords: {...preferences.gestureChords, [slot]: keys}})} />}
    </div>;
  }
  return <section className="preferences-panel" aria-label={t("preferencesTerminalPreferences")}>
    <h2>{t("preferencesTerminalPreferences")}</h2>
    <p>{t("preferencesChangesApplyToEveryOpenTerminal")}</p>
    {error && <p role="alert">{uiErrorText(error)}</p>}
    {languageError && <p role="alert">{t(languageError==='settings'?'preferencesSettingsCouldNotBeSavedOnThisDevice':'nativeLocaleSaveFailed')}</p>}
    <details className="preferences-category"><summary>{t('preferencesCategoryLanguage')}</summary>
    <label>{t('language')}<select disabled={languageBusy} value={preferences.uiLanguage} onChange={event => void languageAction(()=>nativeLocale.change(event.target.value as Preferences['uiLanguage'],current))}>
      <option value="system">{t('languageSystem')}</option><option value="en">{t('languageEnglish')}</option>
      <option value="pt-BR">{t('languagePortugueseBrazil')}</option><option value="es">{t('languageSpanish')}</option>
    </select></label>
    </details>
    <details className="preferences-category"><summary>{t("preferencesCategoryAppearance")}</summary>
    <AppIconPanel />
    <label>{t("preferencesSessionSwitcherLayout")}<select value={preferences.sessionLayout} onChange={e => update({sessionLayout: e.target.value as Preferences["sessionLayout"]})}><option value="list">{t("preferencesList")}</option><option value="cards">{t("preferencesCards")}</option></select></label>
    <label>{t("preferencesAppTheme")}<select value={preferences.appTheme} onChange={e => update({appTheme: e.target.value as Preferences["appTheme"]})}>{Object.keys(themes).map(theme => <option key={theme} value={theme}>{theme === "forest" ? "lazysh" : t(({forest:"themeForest",midnight:"themeMidnight",paper:"themePaper"} as const)[theme as keyof typeof themes])}</option>)}{preferences.customThemeInfo && <option value="custom">{preferences.customThemeInfo.name}</option>}</select></label>
    <label>{t("preferencesTerminalTheme")}<select value={preferences.theme} onChange={e => update({theme: e.target.value as Preferences["theme"], ...(!preferences.customThemeInfo && e.target.value !== "custom" ? {customTheme: undefined} : {})})}>
      {Object.keys(themes).map(theme => <option key={theme} value={theme}>{t(({forest:"themeForest",midnight:"themeMidnight",paper:"themePaper"} as const)[theme as keyof typeof themes])}</option>)}
      {preferences.customTheme && <option value="custom">{t("preferencesCustom")}</option>}
    </select></label>
    <label>{t("preferencesFontSize")}<input type="number" min={10} max={32} value={preferences.fontSize} onChange={e => { if (e.target.value) update({fontSize: Number(e.target.value)}); }} /></label>
    <label>{t("preferencesFontFamily")}<input maxLength={256} value={preferences.fontFamily} onChange={e => update({fontFamily: e.target.value})} /></label>
    <label>{t("preferencesCJKFallbackFamilies")}<input maxLength={256} value={preferences.cjkFallback} onChange={e => update({cjkFallback: e.target.value})} /></label>
    <p>{t("preferencesUseInstalledFontFamiliesOrImportLocalFontFiles")}</p>
    <details><summary>{t("preferencesImportedFonts")}</summary>
      <FontDownloadPanel busy={fontBusy} run={fontAction} />
      {fonts.warnings.map(warning => <p key={fontWarningKey(warning)} role="status">{fontWarningText(warning)}</p>)}
      <label>{t("preferencesImportFontFile")}<input type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" disabled={fontBusy} onChange={event => {const file = event.target.files?.[0]; event.target.value = ""; if (file) void fontAction(() => importFont(file,current));}} /></label>
      <p>{t("preferencesAtMost4Fonts24MiBPerFontAnd")}</p>
      {(["primary", "cjk"] as const).map(role => <label key={role}>{role === "primary" ? t("preferencesImportedTerminalFont") : t("preferencesImportedCJKFallback")}<select disabled={fontBusy} value={fonts.selection[role] ?? ""} onChange={e => void fontAction(() => selectFont(role, e.target.value || undefined))}>
        <option value="">{t("preferencesUseInstalledFallbackFamilies")}</option>
        {fonts.selection[role] && !fonts.fonts.some(font => font.id === fonts.selection[role]) && <option value={fonts.selection[role]}>{t("preferencesMissingFontUsingFallback")}</option>}
        {fonts.fonts.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}
      </select></label>)}
      <p className="font-sample" style={{fontFamily: fontFamilyFor(preferences, fonts), fontSize: preferences.fontSize}}>lazysh 0123456789 · 中文 日本語 한국어</p>
      <ul>{fonts.fonts.map(font => <li key={font.id}><span>{font.name} ({formatNumber(font.size / 1024 / 1024, {minimumFractionDigits:2, maximumFractionDigits:2})}{" "}{t("preferencesMiB")}</span><button disabled={fontBusy} aria-label={t("preferencesDeleteFontValue1", {value1: font.name})} onClick={() => void fontAction(() => deleteFont(font.id))}>{t("preferencesDelete")}</button></li>)}</ul>
      <button disabled={fontBusy} onClick={() => void fontAction(deleteAllFonts)}>{t("preferencesDeleteAllImportedFonts")}</button>
    </details>
    <ThemeImportPanel preferences={preferences} apply={update} />
    </details>
    <details className="preferences-category"><summary>{t("preferencesCategoryTerminal")}</summary>
    <label>{t("preferencesCursor")}<select value={preferences.cursorStyle} onChange={e => update({cursorStyle: e.target.value as Preferences["cursorStyle"]})}>{["bar", "block", "underline"].map(value => <option key={value} value={value}>{t(({bar:"cursorBar",block:"cursorBlock",underline:"cursorUnderline"} as const)[value as Preferences["cursorStyle"]])}</option>)}</select></label>
    <label><input type="checkbox" checked={preferences.cursorBlink} onChange={e => update({cursorBlink: e.target.checked})} />{t("preferencesBlinkCursor")}</label>
    <label>{t("preferencesHistoryLines")}<input type="number" min={100} max={20000} step={100} value={preferences.scrollback} onChange={e => { if (e.target.value) update({scrollback: Number(e.target.value)}); }} /></label>
    <p>{t("preferencesReducingHistoryRemovesOlderLocalLines")}</p>
    <label><input type="checkbox" checked={preferences.screenReader} onChange={e => update({screenReader: e.target.checked})} />{t("preferencesScreenReaderAnnouncements")}</label>
    <label><input type="checkbox" checked={preferences.pinchZoom} onChange={e => update({pinchZoom: e.target.checked})} />{t("preferencesPinchWithTwoFingersToResizeTerminalText")}</label>
    <label><input type="checkbox" checked={preferences.autoHideToolbar} onChange={e => update({autoHideToolbar: e.target.checked})} />{t("preferencesAutoHideToolbarInDesktopPointerLayouts")}</label>
    </details>
    <details className="preferences-category"><summary>{t("preferencesCategoryInput")}</summary>
    <label><input type="checkbox" checked={preferences.optionAsMeta} onChange={e => update({optionAsMeta: e.target.checked})} />{t("preferencesUseOptionAsMetaOnMacOS")}</label>
    <details><summary>{t("preferencesTerminalTouchGestures")}</summary>
      <p>{t("preferencesBindingsAreOptionalSelectionCompositionAndScreenReaderGestures")}</p>
      {bodyGestureSlots.map(slot => binding(slot, {tap: t("gestureSingleTap"), doubleTap: t("gestureDoubleTap"), tripleTap: t("gestureTripleTap"), swipeLeft: t("gestureSwipeLeft"), swipeRight: t("gestureSwipeRight")}[slot], preferences.bodyGestures[slot], action => update({bodyGestures: {...preferences.bodyGestures, [slot]: action}})))}
      {gestureDirections.map(direction => binding(`two${direction[0].toUpperCase()}${direction.slice(1)}` as GestureSlot, t(({left:"gestureTwoLeft",right:"gestureTwoRight",up:"gestureTwoUp",down:"gestureTwoDown"} as const)[direction]), preferences.gestures[direction], action => update({gestures: {...preferences.gestures, [direction]: action}})))}
      <p>{t("preferencesAddTheDPadItemUnderToolbarKeysTo")}</p>
      {(["left", "right"] as const).map(corner => binding(corner === "left" ? "cornerLeft" : "cornerRight", t(corner === "left" ? "gestureDpadLeft" : "gestureDpadRight"), preferences.dpadCorners[corner], action => update({dpadCorners: {...preferences.dpadCorners, [corner]: action}}), ["none", "backspace", "interrupt", "custom"]))}
      <button onClick={() => update({bodyGestures: {...defaults.bodyGestures}, gestures: {...defaults.gestures}, gestureChords: {}, dpadCorners: {...defaults.dpadCorners}, pinchZoom: defaults.pinchZoom})}>{t("preferencesResetGestures")}</button>
    </details>
    <details><summary>{t("preferencesToolbarKeysAndOrder")}</summary>
      <ul>{preferences.toolbar.map((key, index) => <li key={key}><span>{toolbarKeyLabel(key)}</span><button aria-label={t("preferencesMoveValue1Earlier", {value1: key})} disabled={index === 0} onClick={() => move(key, -1)}>↑</button><button aria-label={t("preferencesMoveValue1Later", {value1: key})} disabled={index === preferences.toolbar.length - 1} onClick={() => move(key, 1)}>↓</button><button aria-label={t("preferencesRemoveValue1", {value1: key})} onClick={() => update({toolbar: preferences.toolbar.filter(item => item !== key)})}>{t("appRemove")}</button></li>)}</ul>
      {toolbarKeys.filter(key => !preferences.toolbar.includes(key)).map(key => <button key={key} onClick={() => update({toolbar: [...preferences.toolbar, key]})}>{t("preferencesAdd")}{" "}{toolbarKeyLabel(key)}</button>)}
    </details>
    <details><summary>{t("preferencesTextSnippets")}</summary>
      <p>{t("preferencesSnippetsPasteLiteralTextIntoTheActiveProgramReview")}</p>
      <ul>{preferences.snippets.map((snippet, index) => <li key={index}><span>{snippet.label}</span><button aria-label={t("preferencesRemoveSnippetValue1", {value1: snippet.label})} onClick={() => update({snippets: preferences.snippets.filter((_, i) => i !== index)})}>{t("appRemove")}</button></li>)}</ul>
      <label>{t("preferencesSnippetName")}<input maxLength={32} value={label} onChange={e => setLabel(e.target.value)} /></label>
      <label>{t("preferencesSnippetText")}<textarea maxLength={2048} value={text} onChange={e => setText(e.target.value)} /></label>
      <button disabled={!label.trim() || !text} onClick={() => { if (update({snippets: [...preferences.snippets, {label: label.trim(), text}]})) { setLabel(""); setText(""); } }}>{t("preferencesAddSnippet")}</button>
    </details>
    <details><summary>{t("preferencesKeyboardChords")}</summary>
      <p>{t("preferencesSendUpTo8StepsCBST")}</p>
      <ul>{preferences.chords.map((chord, index) => <li key={index}><span>{chord.label}: {chord.keys}</span><button aria-label={t("preferencesRemoveChordValue1", {value1: chord.label})} onClick={() => update({chords: preferences.chords.filter((_, i) => i !== index)})}>{t("appRemove")}</button></li>)}</ul>
      <label>{t("preferencesChordName")}<input maxLength={32} value={chordLabel} onChange={e => setChordLabel(e.target.value)} /></label>
      <ChordBuilder disabled={!chordLabel.trim()} clearAfterSave onSave={keys => {
        if (!update({chords: [...preferences.chords, {label: chordLabel.trim(), keys}]})) return false;
        setChordLabel(''); return true;
      }} />
    </details>
    </details>
    <details className="preferences-category"><summary>{t("preferencesCategoryReset")}</summary>
    <button disabled={languageBusy} onClick={() => {void languageAction(async()=>{
      await applyPreferenceIntent({...defaults,toolbar:[...defaults.toolbar],snippets:[],customTheme:undefined,customThemeInfo:undefined},true,current);
      if(current())await fontAction(resetFontSelection);
    });}}>{t("preferencesResetPreferences")}</button>
    </details>
  </section>;
}
