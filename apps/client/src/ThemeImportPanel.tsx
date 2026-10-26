import {LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {t, useUi} from './i18n/core';
import { useState } from 'react';
import { chromeColors, exportTheme, parseThemeImport, type ImportedTheme } from './themeImport';
import type { Preferences } from './preferences';

type ImportMessage = {kind:'error';cause:UiErrorCause}|{kind:'notice';notice:'exported'|'applied'};
const noticeKeys={exported:'themeSelectTheExportedTextToCopyIt',applied:'themeThemeAppliedToAppAndTerminal'} as const;
type Props = {preferences: Preferences; apply: (patch: Partial<Preferences>) => boolean};
export default function ThemeImportPanel({preferences,apply}: Props) {
  useUi();
  const [source,setSource]=useState(''),[name,setName]=useState(t("appImportedTheme")),[mode,setMode]=useState<'dark'|'light'>('dark');
  const [preview,setPreview]=useState<ImportedTheme>(),[output,setOutput]=useState(''),[message,setMessage]=useState<ImportMessage>();
  function review(input=source) {
    setPreview(undefined);setMessage(undefined);
    try {setPreview(parseThemeImport(input,{name,mode}));} catch(error) {setMessage({kind:'error',cause:error instanceof LocalUiError?error:String(error)});}
  }
  function share(format:'json'|'code'|'link') {
    try {
      const palette=preferences.customTheme ?? undefined;
      if (!palette) throw new LocalUiError('themeImportAThemeBeforeExportingIt');
      const value={v:1 as const,...(preferences.customThemeInfo??{name,mode}),colors:palette};
      setOutput(exportTheme(value)[format]);setMessage({kind:'notice',notice:'exported'});
    } catch(error) {setMessage({kind:'error',cause:error instanceof LocalUiError?error:String(error)});}
  }
  async function paste() {
    try {const value=await navigator.clipboard.readText();setSource(value.slice(0,16384));review(value);} catch {setMessage({kind:'error',cause:new LocalUiError('themeClipboardCouldNotBeReadPasteTheThemeInto')});}
  }
  return <details><summary>{t("themeImportAndShareTheme")}</summary>
    <p>{t("themePasteJSONOrALazyshThemeShareCodeNothing")}</p>
    <label>{t("themeThemeName")}<input maxLength={80} value={name} onChange={event=>{setName(event.target.value);setPreview(undefined);}} /></label>
    <label>{t("themeThemeMode")}<select value={mode} onChange={event=>{setMode(event.target.value as 'dark'|'light');setPreview(undefined);}}><option value="dark">{t("themeDark")}</option><option value="light">{t("themeLight")}</option></select></label>
    <label>{t("themeThemeJSONOrShareCode")}<textarea aria-label={t("themeThemeJSONOrShareCode")} maxLength={16384} value={source} onChange={event=>{setSource(event.target.value);setPreview(undefined);}} /></label>
    <button type="button" onClick={()=>review()}>{t("themePreviewTheme")}</button>
    <button type="button" onClick={()=>void paste()}>{t("themeReadThemeFromClipboard")}</button>
    {preferences.customTheme && <button type="button" onClick={()=>review(JSON.stringify(preferences.customThemeInfo ? {v:1,...preferences.customThemeInfo,colors:preferences.customTheme} : preferences.customTheme))}>{t("themeReviewSavedPalette")}</button>}
    {preview && <section className="theme-preview" aria-label={t("themeThemePreview")} style={chromeColors(preview)}>
      <h3>{preview.name}</h3><p>{preview.mode === 'light' ? t("themeLight") : t("themeDark")}{" "}{t("themeThemeLazysh")}</p>
      <pre style={{background:preview.colors.background,color:preview.colors.foreground}}>agent $ ready for review</pre>
      <button type="button" onClick={()=>{if(apply({customTheme:preview.colors,customThemeInfo:{name:preview.name,mode:preview.mode},theme:'custom',appTheme:'custom'})){setPreview(undefined);setMessage({kind:'notice',notice:'applied'});}}}>{t("themeApplyToAppAndTerminal")}</button>
      <button type="button" onClick={()=>setPreview(undefined)}>{t("themeCancelPreview")}</button>
    </section>}
    {message && (message.kind==='notice' || message.cause!=='') && <p role="status">{message.kind==='error'?uiErrorText(message.cause):t(noticeKeys[message.notice])}</p>}
    <button type="button" disabled={!preferences.customTheme} onClick={()=>share('json')}>{t("themeExportThemeJSON")}</button>
    <button type="button" disabled={!preferences.customTheme} onClick={()=>share('code')}>{t("themeExportThemeShareCode")}</button>
    <button type="button" disabled={!preferences.customTheme} onClick={()=>share('link')}>{t("themeExportThemeLink")}</button>
    {output && <label>{t("themeExportedTheme")}<textarea aria-label={t("themeExportedTheme")} readOnly value={output} onFocus={event=>event.currentTarget.select()} /></label>}
    <p>{t("themeJSONIsLimitedTo8KiBAppChromeUses")}</p>
  </details>;
}
