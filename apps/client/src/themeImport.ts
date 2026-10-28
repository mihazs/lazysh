import {LocalUiError} from './i18n/localError';
import type { ITheme } from '@xterm/xterm';

export type ThemeInfo = {name: string; mode: 'dark' | 'light'};
export type ThemeColors = ITheme & {bold?: 'bright' | `#${string}`};
export type ImportedTheme = ThemeInfo & {v: 1; colors: ThemeColors};
const colorKeys = ['background','foreground','cursor','cursorAccent','selectionBackground','selectionForeground','selectionInactiveBackground','black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
const bytes = (value: string) => new TextEncoder().encode(value);
export function themeInfo(value: unknown): ThemeInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalUiError('validationThemeNeedsANameAndExplicitLightOrDark');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !['name','mode'].includes(key)) || typeof p.name !== 'string' || !p.name.trim() || /[\uD800-\uDFFF]/u.test(p.name) || [...p.name].length > 40 || /[\x00-\x1f\x7f-\x9f]/.test(p.name) || (p.mode !== 'light' && p.mode !== 'dark')) throw new LocalUiError('validationThemeNeedsANameOfUpTo40Characters');
  return {name: p.name.trim(), mode: p.mode};
}
export function themeColors(value: unknown): ThemeColors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalUiError('validationAThemeMustBeAJSONObjectOfHexadecimal');
  const result: Record<string, string> = {};
  for (const [key, color] of Object.entries(value)) {
    if (key === 'bold') {
      if (color === 'bright') {result.bold = color; continue;}
      if (typeof color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) throw new LocalUiError('validationInvalidThemeColorBold');
    } else
    if (!colorKeys.includes(key) || typeof color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new LocalUiError('validationInvalidThemeColorValue1', key);
    result[key] = (color.length === 4 ? '#' + [...color.slice(1)].map(c => c + c).join('') : color).toLowerCase();
  }
  if (!result.background || !result.foreground) throw new LocalUiError('validationThemeNeedsBackgroundAndForegroundColors');
  return result as ThemeColors;
}
export function importedTheme(value: unknown): ImportedTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalUiError('validationInvalidThemeDocument');
  const p = value as Record<string, unknown>;
  if (p.v !== 1 || Object.keys(p).some(key => !['v','name','mode','colors'].includes(key))) throw new LocalUiError('validationUnsupportedThemeDocument');
  const info = themeInfo({name:p.name,mode:p.mode});
  const colors = themeColors(p.colors);
  for (const color of [colors.background!, colors.foreground!]) {
    if (color.length === 9 && !color.endsWith('ff')) throw new LocalUiError('validationWholeAppThemesNeedOpaqueBackgroundAndForegroundColors');
  }
  const normalized = {...colors} as Record<string,string>;
  for (const base of ['black','red','green','yellow','blue','magenta','cyan','white']) {
    normalized[base] ??= normalized.foreground;
    const bright = 'bright' + base[0].toUpperCase() + base.slice(1);
    normalized[bright] ??= normalized[base];
  }
  normalized.cursor ??= normalized.foreground;
  normalized.selectionBackground ??= mix(normalized.background,normalized.foreground,.3);
  return {v:1,...info,colors:normalized};
}
export function parseThemeImport(source: string, legacyInfo: ThemeInfo): ImportedTheme {
  if (source.length > 16384 || bytes(source).length > 16384) throw new LocalUiError('validationThemeInputExceeds16KiB');
  let json = source.trim();
  const shared = json.startsWith('lazysh-theme:');
  if (!shared && bytes(source).length > 8192) throw new LocalUiError('validationThemeJSONExceeds8KiB');
  if (shared) {
    const encoded = json.slice(json.indexOf(':') + 1);
    if (!/^[\w+/-]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new LocalUiError('validationInvalidThemeShareCode');
    try {
      const decoded = atob(encoded.replace(/-/g,'+').replace(/_/g,'/'));
      if (decoded.length > 8192) throw new Error();
      json = new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(decoded, c => c.charCodeAt(0)));
    } catch {throw new LocalUiError('validationInvalidOrOversizedThemeShareCode');}
  }
  if (bytes(json).length > 8192) throw new LocalUiError('validationThemeJSONExceeds8KiB');
  let value: unknown;
  try {value = JSON.parse(json);} catch {throw new LocalUiError('validationEnterValidThemeJSONOrAThemeShareCode');}
  if (value && typeof value === 'object' && 'v' in value) return importedTheme(value);
  return importedTheme({v:1,...themeInfo(legacyInfo),colors:value});
}
export function exportTheme(value: ImportedTheme): {json: string; code: string; link: string} {
  const json = JSON.stringify(importedTheme(value));
  const code = 'lazysh-theme:' + btoa(String.fromCharCode(...bytes(json))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return {json,code,link:'lazysh://theme?data='+code.slice('lazysh-theme:'.length)};
}
function rgb(value: string): number[] {return [1,3,5].map(index => parseInt(value.slice(index,index+2),16));}
function mix(a: string,b: string,amount: number): string {const other=rgb(b);return '#'+rgb(a).map((c,i)=>Math.round(c*(1-amount)+other[i]*amount).toString(16).padStart(2,'0')).join('');}
export function contrast(a: string,b: string): number {
  const luminance=(color:string)=>rgb(color).map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
function readable(value: string, backgrounds: string[]): string {
  const candidates=[value.slice(0,7),'#000000','#ffffff'];
  return candidates.find(color=>backgrounds.every(bg=>contrast(color,bg)>=4.5)) ?? (contrast('#000000',backgrounds[0])>contrast('#ffffff',backgrounds[0])?'#000000':'#ffffff');
}
export function chromeColors(theme: ImportedTheme): Record<string,string> {
  const {colors:c}=importedTheme(theme), bg=c.background!.slice(0,7), fg=c.foreground!.slice(0,7);
  const toward=contrast('#000000',bg)>contrast('#ffffff',bg)?'#ffffff':'#000000';
  const panel=mix(bg,toward,.03),control=mix(bg,toward,.06),hover=mix(bg,toward,.09);
  const surfaces=[bg,panel,control,hover];
  const text=readable(fg,surfaces),accent=readable(c.cursor??c.blue??fg,surfaces);
  const result:Record<string,string>={bg,panel,control,hover,text,muted:text,border:mix(bg,text,.45),accent,'on-accent':readable('#ffffff',[accent])};
  for (const [name,key] of [['danger','red'],['warning','yellow'],['blue','blue'],['purple','magenta']] as const) {
    const candidate=c[key]??fg, background=panel;
    result[name+'-bg']=background;result[name]=readable(candidate,[...surfaces,background]);
  }
  return Object.fromEntries(Object.entries(result).map(([key,value])=>['--theme-'+key,value]));
}
