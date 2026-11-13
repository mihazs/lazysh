import SettingsNavigation,{type SettingsPage,type SettingsSection} from "./SettingsNavigation";
import {t, useUi, formatNumber, type UiKey} from './i18n/core';
import { useEffect, useRef, useState } from "react";
import {LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import FontDownloadPanel from "./FontDownloadPanel";
import AppIconPanel from "./AppIconPanel";
import {useMountedAccess,useProtectedInvoke} from './access';
import {isAndroidApp} from './isAndroidApp';
import {applyPreferenceIntent, nativeLocale, PreferenceStorageError, useNativeLocale} from './i18n/nativeLocale';
import ThemeImportPanel from "./ThemeImportPanel";
import ChordBuilder from "./ChordBuilder";
import ToolbarKeysEditor from "./ToolbarKeysEditor";
import GestureBindingField from "./GestureBindingField";
import {setShowTopBar, useShowTopBar} from "./sideMenuMode";
import GestureTestPage from "./GestureTestPage";
import { bodyGestureSlots, defaults, discreteGestureActions, edgeGestureIds, edgeGestureSettings, edgeGestureZone, gestureActions, gestureDirections, gestureModes, levelAwareGestureActions, levelGestureSlots, savePreferences, themes, usePreferences, type GestureAction, type GestureSlot, type Preferences } from "./preferences";
import { providerName, usageProviders, type UsageBarMode } from "./usageAgentProvider";
import { deleteAllFonts, deleteFont, fontFamilyFor, fontErrorCause, fontWarningKey, fontWarningText, importFont, resetFontSelection, selectFont, useDeviceFonts } from "./fonts";

const themeLabels={forest:"themeForest",midnight:"themeMidnight",paper:"themePaper"} as const;
const languageLabels={system:"languageSystem",en:"languageEnglish","pt-BR":"languagePortugueseBrazil",es:"languageSpanish"} as const;
const cursorLabels={bar:"cursorBar",block:"cursorBlock",underline:"cursorUnderline"} as const;
/** Root sections, in the order the settings list shows them; hosts add their own entries to them. */
export const settingsSections=():SettingsSection[]=>[
  {id:"terminal",title:t("settingsSectionTerminal")},
  {id:"input",title:t("settingsSectionInput")},
  {id:"agents",title:t("settingsSectionAgents")},
  {id:"security",title:t("settingsSectionSecurity")},
  {id:"general",title:t("settingsSectionGeneral")},
  {id:"help",title:t("settingsSectionHelp")},
  {id:"reset",footer:t("settingsResetFooter")},
];
const count=(items:readonly unknown[])=>items.length?formatNumber(items.length):undefined;
const usageItemLabels={follow:"preferencesUsageFollow",fixed:"preferencesUsageFixed",hidden:"preferencesUsageHidden"} as const satisfies Record<UsageBarMode,UiKey>;

/** `pages` adds host-owned entries (connections, security, other surfaces) into the shared sections. */
export default function PreferencesPanel({pages=[],footer,usageAccounts=[]}:{pages?:SettingsPage[];footer?:string;usageAccounts?:readonly {id:string;name:string}[]}={}) {
  useUi();
  const preferences = usePreferences();
  const topBar = useShowTopBar();
  const invoke = useProtectedInvoke();
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
  function binding(slot: GestureSlot, label: string, action: GestureAction, change: (action: GestureAction) => void, allowed: readonly GestureAction[] = discreteGestureActions) {
    return <GestureBindingField key={slot} label={label} action={action} keys={preferences.gestureChords[slot]} allowed={allowed} onAction={change} onKeys={keys => update({gestureChords: {...preferences.gestureChords, [slot]: keys}})} />;
  }
  const usageItem=preferences.usageItem ?? "follow";
  const appThemeName=preferences.appTheme==="custom"?preferences.customThemeInfo?.name??t("preferencesCustom"):preferences.appTheme==="forest"?"lazysh":t(themeLabels[preferences.appTheme]);
  const own:SettingsPage[]=[
{id:"appearance",section:"terminal",title:t("preferencesCategoryAppearance"),value:`${appThemeName} · ${t("settingsFontSizeValue",{size:formatNumber(preferences.fontSize)})}`,content:<>

    <h3 className="settings-group-title">{t("settingsGroupApp")}</h3>
    <AppIconPanel />
    <label>{t("preferencesSessionSwitcherLayout")}<select value={preferences.sessionLayout} onChange={e => update({sessionLayout: e.target.value as Preferences["sessionLayout"]})}><option value="list">{t("preferencesList")}</option><option value="cards">{t("preferencesCards")}</option></select></label>
    <label><input type="checkbox" checked={topBar} onChange={e => setShowTopBar(e.target.checked)} />{t("preferencesShowTopBar")}</label>
    <p>{t("preferencesShowTopBarHint")}</p>
    <label>{t("preferencesAppTheme")}<select value={preferences.appTheme} onChange={e => update({appTheme: e.target.value as Preferences["appTheme"]})}>{Object.keys(themes).map(theme => <option key={theme} value={theme}>{theme === "forest" ? "lazysh" : t(themeLabels[theme as keyof typeof themes])}</option>)}{preferences.customThemeInfo && <option value="custom">{preferences.customThemeInfo.name}</option>}</select></label>
    <h3 className="settings-group-title">{t("settingsGroupTerminalColors")}</h3>
    <label>{t("preferencesTerminalTheme")}<select value={preferences.theme} onChange={e => update({theme: e.target.value as Preferences["theme"], ...(!preferences.customThemeInfo && e.target.value !== "custom" ? {customTheme: undefined} : {})})}>
      {Object.keys(themes).map(theme => <option key={theme} value={theme}>{t(themeLabels[theme as keyof typeof themes])}</option>)}
      {preferences.customTheme && <option value="custom">{t("preferencesCustom")}</option>}
    </select></label>
    <ThemeImportPanel preferences={preferences} apply={update} />
    <h3 className="settings-group-title">{t("settingsGroupFonts")}</h3>
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

</>},
{id:"terminal",section:"terminal",title:t("preferencesCategoryTerminal"),value:`${t(cursorLabels[preferences.cursorStyle])} · ${t("settingsHistoryLinesValue",{value:formatNumber(preferences.scrollback)})}`,content:<>

    <h3 className="settings-group-title">{t("settingsGroupCursorAndHistory")}</h3>
    <fieldset className="cursor-picker"><legend>{t("preferencesCursor")}</legend><div>{(["bar", "block", "underline"] as const).map(value => <label key={value}><input type="radio" name="cursor-style" value={value} checked={preferences.cursorStyle === value} onChange={() => update({cursorStyle: value})} /><span>{t(cursorLabels[value])}</span></label>)}</div></fieldset>
    <label><input type="checkbox" checked={preferences.cursorBlink} onChange={e => update({cursorBlink: e.target.checked})} />{t("preferencesBlinkCursor")}</label>
    <label>{t("preferencesHistoryLines")}<input type="number" min={100} max={20000} step={100} value={preferences.scrollback} onChange={e => { if (e.target.value) update({scrollback: Number(e.target.value)}); }} /></label>
    <p>{t("preferencesReducingHistoryRemovesOlderLocalLines")}</p>
    <h3 className="settings-group-title">{t("settingsGroupAccessibility")}</h3>
    <label><input type="checkbox" checked={preferences.screenReader} onChange={e => update({screenReader: e.target.checked})} />{t("preferencesScreenReaderAnnouncements")}</label>
    <label><input type="checkbox" checked={preferences.pinchZoom} onChange={e => update({pinchZoom: e.target.checked})} />{t("preferencesPinchWithTwoFingersToResizeTerminalText")}</label>
    <label><input type="checkbox" checked={preferences.autoHideToolbar} onChange={e => update({autoHideToolbar: e.target.checked})} />{t("preferencesAutoHideToolbarInDesktopPointerLayouts")}</label>

</>},
{id:"input",section:"input",title:t("preferencesCategoryInput"),content:<>

    <h3 className="settings-group-title">{t("settingsGroupKeyboard")}</h3>
    <label><input type="checkbox" checked={preferences.optionAsMeta} onChange={e => update({optionAsMeta: e.target.checked})} />{t("preferencesUseOptionAsMetaOnMacOS")}</label>
    <label><input type="checkbox" checked={preferences.composerSendEnter} onChange={e => update({composerSendEnter: e.target.checked})} />{t("preferencesComposerSendEnter")}</label>
    {isAndroidApp() && <>
      <label><input type="checkbox" checked={preferences.privateKeyboard === true} aria-describedby="private-keyboard-help" onChange={e => update({privateKeyboard: e.target.checked || undefined})} />{t("preferencesPrivateKeyboard")}</label>
      <p id="private-keyboard-help">{t("preferencesPrivateKeyboardHelp")}</p>
    </>}
    <fieldset className="cursor-picker"><legend>{t("preferencesComposerView")}</legend><div>{(["docked", "floating"] as const).map(value => <label key={value}><input type="radio" name="composer-layout" value={value} checked={(preferences.composerLayout ?? "docked") === value} onChange={() => update({composerLayout: value === "floating" ? "floating" : undefined})} /><span>{t(value === "floating" ? "preferencesComposerFloating" : "preferencesComposerDocked")}</span></label>)}</div></fieldset>
    <p>{t("preferencesComposerViewHelp")}</p>
    <h3 className="settings-group-title">{t("settingsGroupToolbarAndShortcuts")}</h3>

</>},
{id:"preferencesTerminalTouchGestures",title:t("preferencesTerminalTouchGestures"),parent:"input",content:<>

      <p>{t("preferencesBindingsAreOptionalSelectionCompositionAndScreenReaderGestures")}</p>
      <h3 className="settings-group-title">{t("edgeGesturesHeading")}</h3>
      <p>{t("edgeGesturesHint")}</p>
      <label>{t("gestureModeLabel")}<select value={edgeGestureSettings(preferences).mode} onChange={e => update({edgeGestures: {...edgeGestureSettings(preferences), mode: e.target.value as typeof gestureModes[number]}})}>{gestureModes.map(mode => <option key={mode} value={mode}>{t(({auto: "gestureModeAuto", handles: "gestureModeHandles", edges: "gestureModeEdges", off: "gestureModeOff"} as const)[mode])}</option>)}</select></label>
      <p>{t("gestureModeHint")}</p>
      {edgeGestureIds.map(id => <label key={id}><input type="checkbox" checked={edgeGestureSettings(preferences)[id]} onChange={e => update({edgeGestures: {...edgeGestureSettings(preferences), [id]: e.target.checked}})} />{t(({leftMenu: "edgeGestureLeftMenu", bottomMenu: "edgeGestureBottomMenu", viewSwitch: "edgeGestureViewSwitch"} as const)[id])}</label>)}
      <label>{t("edgeGestureZoneWidth", {value: formatNumber(edgeGestureSettings(preferences).zoneWidth)})}<input type="range" min={edgeGestureZone.min} max={edgeGestureZone.max} step={edgeGestureZone.step} value={edgeGestureSettings(preferences).zoneWidth} onChange={e => update({edgeGestures: {...edgeGestureSettings(preferences), zoneWidth: Number(e.target.value)}})} /></label>
      <label><input type="checkbox" checked={preferences.dismissKeyboardOnOverscroll} onChange={e=>update({dismissKeyboardOnOverscroll:e.target.checked})} />{t("preferencesDismissKeyboardOnOverscroll")}</label>
      {bodyGestureSlots.map(slot => binding(slot, {tap: t("gestureSingleTap"), doubleTap: t("gestureDoubleTap"), tripleTap: t("gestureTripleTap"), swipeLeft: t("gestureSwipeLeft"), swipeRight: t("gestureSwipeRight")}[slot], preferences.bodyGestures[slot], action => update({bodyGestures: {...preferences.bodyGestures, [slot]: action}})))}
      {gestureDirections.map(direction => binding(`two${direction[0].toUpperCase()}${direction.slice(1)}` as GestureSlot, t(({left:"gestureTwoLeft",right:"gestureTwoRight",up:"gestureTwoUp",down:"gestureTwoDown"} as const)[direction]), preferences.gestures[direction], action => update({gestures: {...preferences.gestures, [direction]: action}}), levelAwareGestureActions))}
      <p>{t("preferencesLevelAwareGestures")}</p>
      {levelGestureSlots.map(slot => binding(slot, t(({pinch:"gesturePinch",pullShallow:"gesturePullShallow",pullDeep:"gesturePullDeep"} as const)[slot]), preferences.bodyGestures[slot], action => update({bodyGestures: {...preferences.bodyGestures, [slot]: action}}), slot === "pinch" ? gestureActions : levelAwareGestureActions))}
      <p>{t("preferencesAddTheDPadItemUnderToolbarKeysTo")}</p>
      {(["left", "right"] as const).map(corner => binding(corner === "left" ? "cornerLeft" : "cornerRight", t(corner === "left" ? "gestureDpadLeft" : "gestureDpadRight"), preferences.dpadCorners[corner], action => update({dpadCorners: {...preferences.dpadCorners, [corner]: action}}), ["none", "backspace", "interrupt", "custom"]))}
      <button onClick={() => update({bodyGestures: {...defaults.bodyGestures}, gestures: {...defaults.gestures}, gestureChords: {}, dpadCorners: {...defaults.dpadCorners}, pinchZoom: defaults.pinchZoom, dismissKeyboardOnOverscroll: defaults.dismissKeyboardOnOverscroll, edgeGestures: undefined})}>{t("preferencesResetGestures")}</button>

</>},
{id:"gestureTestTitle",title:t("gestureTestTitle"),parent:"input",content:<GestureTestPage />},
{id:"preferencesToolbarKeysAndOrder",title:t("preferencesToolbarKeysAndOrder"),parent:"input",content:<>

      <ToolbarKeysEditor preferences={preferences} update={update} />

</>},
{id:"preferencesTextSnippets",title:t("preferencesTextSnippets"),parent:"input",value:count(preferences.snippets),content:<>

      <p>{t("preferencesSnippetsPasteLiteralTextIntoTheActiveProgramReview")}</p>
      <ul>{preferences.snippets.map((snippet, index) => <li key={index}><span>{snippet.label}</span><button aria-label={t("preferencesRemoveSnippetValue1", {value1: snippet.label})} onClick={() => update({snippets: preferences.snippets.filter((_, i) => i !== index)})}>{t("appRemove")}</button></li>)}</ul>
      <label>{t("preferencesSnippetName")}<input maxLength={32} value={label} onChange={e => setLabel(e.target.value)} /></label>
      <label>{t("preferencesSnippetText")}<textarea maxLength={2048} value={text} onChange={e => setText(e.target.value)} /></label>
      <button disabled={!label.trim() || !text} onClick={() => { if (update({snippets: [...preferences.snippets, {label: label.trim(), text}]})) { setLabel(""); setText(""); } }}>{t("preferencesAddSnippet")}</button>

</>},
{id:"preferencesKeyboardChords",title:t("preferencesKeyboardChords"),parent:"input",value:count(preferences.chords),content:<>

      <p>{t("preferencesSendUpTo8StepsCBST")}</p>
      <ul>{preferences.chords.map((chord, index) => <li key={index}><span>{chord.label}: {chord.keys}</span><button aria-label={t("preferencesRemoveChordValue1", {value1: chord.label})} onClick={() => update({chords: preferences.chords.filter((_, i) => i !== index)})}>{t("appRemove")}</button></li>)}</ul>
      <label>{t("preferencesChordName")}<input maxLength={32} value={chordLabel} onChange={e => setChordLabel(e.target.value)} /></label>
      <ChordBuilder disabled={!chordLabel.trim()} clearAfterSave onSave={keys => {
        if (!update({chords: [...preferences.chords, {label: chordLabel.trim(), keys}]})) return false;
        setChordLabel(''); return true;
      }} />

</>},
{id:"accountUsage",section:"agents",title:t("preferencesCategoryAccountUsage"),value:t(usageItemLabels[usageItem]),content:<>

    <fieldset><legend>{t("preferencesUsageItem")}</legend>{(Object.keys(usageItemLabels) as UsageBarMode[]).map(value => <label key={value}><input type="radio" name="usage-item" value={value} checked={usageItem === value} onChange={() => update({usageItem: value === "follow" ? undefined : value})} />{t(usageItemLabels[value])}</label>)}</fieldset>
    <p>{t("preferencesUsageFollowHelp")}</p>
    <label>{t("preferencesUsageProvider")}<select value={preferences.usageProvider ?? ""} disabled={usageItem === "hidden"} onChange={e => update({usageProvider: e.target.value || undefined})}>
      <option value="">{t("preferencesUsageProviderHost")}</option>
      {usageProviders.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      {[...usageAccounts, ...(preferences.usageProvider ? [{id: preferences.usageProvider, name: providerName(preferences.usageProvider)}] : [])].filter((account, index, all) => !usageProviders.some(([id]) => id === account.id) && all.findIndex(other => other.id === account.id) === index).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
    </select></label>
    <p>{t("preferencesUsageProviderHelp")}</p>

</>},
...(isAndroidApp() ? [{id:"android-notifications",section:"general",title:t("androidNotificationTitle"),content:<>
    <p>{t("androidNotificationSettingsHelp")}</p>
    <button onClick={() => void invoke('open_notification_settings').catch(() => setError(t("androidNotificationSettingsError")))}>{t("inboxAndroidSettings")}</button>
</>}] : []) as SettingsPage[],
{id:"language",section:"general",title:t("preferencesCategoryLanguage"),value:t(languageLabels[preferences.uiLanguage]),content:<>

    <fieldset className="language-picker" aria-disabled={languageBusy || undefined}>
      <legend>{t('language')}</legend>
      {(Object.entries(languageLabels) as [Preferences['uiLanguage'], typeof languageLabels[keyof typeof languageLabels]][]).map(([value, label]) =>
        <label key={value}><input type="radio" name="ui-language" value={value} checked={preferences.uiLanguage===value} aria-disabled={languageBusy || undefined} onClick={event=>{if(languageBusy)event.preventDefault();}} onKeyDown={event=>{if(languageBusy && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(event.key))event.preventDefault();}} onChange={() => {if(!languageBusy)void languageAction(()=>nativeLocale.change(value,current));}}/><span>{t(label)}</span></label>
      )}
    </fieldset>

</>},
{id:"reset",section:"reset",tone:"danger",title:t("preferencesCategoryReset"),content:<>

    <button disabled={languageBusy} onClick={() => {void languageAction(async()=>{
      await applyPreferenceIntent({...defaults,toolbar:[...defaults.toolbar],snippets:[],customTheme:undefined,customThemeInfo:undefined},true,current);
      if(current())await fontAction(resetFontSelection);
    });}}>{t("preferencesResetPreferences")}</button>
    <p>{t("settingsResetFooter")}</p>

</>},
  ];
  return <section className="preferences-panel" aria-label={t("preferencesTerminalPreferences")}>
    {error && <p role="alert">{uiErrorText(error)}</p>}
    {languageError && <p role="alert">{t(languageError==='settings'?'preferencesSettingsCouldNotBeSavedOnThisDevice':'nativeLocaleSaveFailed')}</p>}
    <SettingsNavigation sections={settingsSections()} footer={footer} pages={[...own,...pages]}/>
  </section>;
}
