import { useState } from 'react';
import { chromeColors, exportTheme, parseThemeImport, type ImportedTheme } from './themeImport';
import type { Preferences } from './preferences';

type Props = {preferences: Preferences; apply: (patch: Partial<Preferences>) => boolean};
export default function ThemeImportPanel({preferences,apply}: Props) {
  const [source,setSource]=useState(''),[name,setName]=useState('Imported theme'),[mode,setMode]=useState<'dark'|'light'>('dark');
  const [preview,setPreview]=useState<ImportedTheme>(),[output,setOutput]=useState(''),[message,setMessage]=useState('');
  function review(input=source) {
    setPreview(undefined);setMessage('');
    try {setPreview(parseThemeImport(input,{name,mode}));} catch(error) {setMessage(String(error));}
  }
  function share(format:'json'|'code'|'link') {
    try {
      const palette=preferences.customTheme ?? undefined;
      if (!palette) throw new Error('Import a theme before exporting it.');
      const value={v:1 as const,...(preferences.customThemeInfo??{name,mode}),colors:palette};
      setOutput(exportTheme(value)[format]);setMessage('Select the exported text to copy it.');
    } catch(error) {setMessage(String(error));}
  }
  async function paste() {
    try {const value=await navigator.clipboard.readText();setSource(value.slice(0,16384));review(value);} catch {setMessage('Clipboard could not be read. Paste the theme into the input instead.');}
  }
  return <details><summary>Import and share theme</summary>
    <p>Paste JSON or a lazysh-theme share code. Nothing changes until you review and apply. Flat palettes use the name and mode below; versioned documents include their own.</p>
    <label>Theme name<input maxLength={80} value={name} onChange={event=>{setName(event.target.value);setPreview(undefined);}} /></label>
    <label>Theme mode<select value={mode} onChange={event=>{setMode(event.target.value as 'dark'|'light');setPreview(undefined);}}><option value="dark">Dark</option><option value="light">Light</option></select></label>
    <label>Theme JSON or share code<textarea aria-label="Theme JSON or share code" maxLength={16384} value={source} onChange={event=>{setSource(event.target.value);setPreview(undefined);}} /></label>
    <button type="button" onClick={()=>review()}>Preview theme</button>
    <button type="button" onClick={()=>void paste()}>Read theme from clipboard</button>
    {preferences.customTheme && <button type="button" onClick={()=>review(JSON.stringify(preferences.customThemeInfo ? {v:1,...preferences.customThemeInfo,colors:preferences.customTheme} : preferences.customTheme))}>Review saved palette</button>}
    {preview && <section className="theme-preview" aria-label="Theme preview" style={chromeColors(preview)}>
      <h3>{preview.name}</h3><p>{preview.mode === 'light' ? 'Light' : 'Dark'} theme · lazysh 中文</p>
      <pre style={{background:preview.colors.background,color:preview.colors.foreground}}>agent $ ready for review</pre>
      <button type="button" onClick={()=>{if(apply({customTheme:preview.colors,customThemeInfo:{name:preview.name,mode:preview.mode},theme:'custom',appTheme:'custom'})){setPreview(undefined);setMessage('Theme applied to app and terminal.');}}}>Apply to app and terminal</button>
      <button type="button" onClick={()=>setPreview(undefined)}>Cancel preview</button>
    </section>}
    {message && <p role="status">{message}</p>}
    <button type="button" disabled={!preferences.customTheme} onClick={()=>share('json')}>Export theme JSON</button>
    <button type="button" disabled={!preferences.customTheme} onClick={()=>share('code')}>Export theme share code</button>
    <button type="button" disabled={!preferences.customTheme} onClick={()=>share('link')}>Export theme link</button>
    {output && <label>Exported theme<textarea aria-label="Exported theme" readOnly value={output} onFocus={event=>event.currentTarget.select()} /></label>}
    <p>JSON is limited to 8 KiB. App chrome uses readable derived colors; terminal colors stay as supplied. Theme links open in the installed native app for review. QR scanning is not available yet.</p>
  </details>;
}
