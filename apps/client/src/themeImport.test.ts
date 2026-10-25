import {describe,it,expect} from 'vitest';
import {chromeColors,contrast,exportTheme,importedTheme,parseThemeImport} from './themeImport';
import {defaults,parsePreferences,terminalOptions} from './preferences';
const info={name:'Day 日光',mode:'light' as const};
const theme={v:1 as const,...info,colors:{background:'#ffffff',foreground:'#ffffff',cursor:'#ffffff',red:'#eeeeee'}};
describe('bounded reviewed theme documents',()=>{
  it('normalizes minimal canonical palettes through terminal preferences and share round trips, without changing unreviewed legacy defaults',()=>{
    const colors={background:'#101010',foreground:'#eeeeee',red:'#ab1234'};
    const imported=parseThemeImport(JSON.stringify({v:1,...info,colors}),info);
    expect(imported.colors).toMatchObject({black:'#eeeeee',green:'#eeeeee',brightBlack:'#eeeeee',brightRed:'#ab1234',brightGreen:'#eeeeee',cursor:'#eeeeee',selectionBackground:expect.stringMatching(/^#[a-f0-9]{6}$/)});
    const preferences=parsePreferences({...defaults,theme:'custom',customTheme:colors,customThemeInfo:info});
    const {extendedAnsi,...renderedColors}=terminalOptions(preferences).theme!;
    expect(renderedColors).toEqual(imported.colors);
    expect(extendedAnsi).toHaveLength(240);
    expect(preferences.customTheme).not.toHaveProperty('extendedAnsi');
    const exported=exportTheme(imported);
    expect(parseThemeImport(exported.json,info)).toEqual(imported);
    expect(parseThemeImport(exported.code,info)).toEqual(imported);
    expect(terminalOptions(parsePreferences({...defaults,customTheme:colors})).theme?.black).toBeUndefined();
  });
  it('round-trips bold policy and preserves bundled and pre-metadata bright defaults',()=>{
    for(const [bold,normalized] of [[undefined,undefined],['bright','bright'],['#abc','#aabbcc'],['#A1B2C3','#a1b2c3']] as const) {
      const imported=importedTheme({...theme,colors:{...theme.colors,...(bold===undefined?{}:{bold})}});
      const saved=parsePreferences({...defaults,theme:'custom',customTheme:imported.colors,customThemeInfo:info});
      expect(terminalOptions(saved).drawBoldTextInBrightColors).toBe(bold!==undefined);
      expect(terminalOptions(saved).theme).not.toHaveProperty('bold');
      expect(parseThemeImport(exportTheme(imported).code,info)).toEqual(imported);
      expect(saved.customTheme?.bold).toBe(normalized);
    }
    expect(terminalOptions(defaults).drawBoldTextInBrightColors).toBe(true);
    expect(terminalOptions(parsePreferences({...defaults,customTheme:theme.colors})).drawBoldTextInBrightColors).toBe(true);
    for(const bold of [null,1,'Bright','#aabbccff','#aa','red','url(evil)']) expect(()=>importedTheme({...theme,colors:{...theme.colors,bold}})).toThrow();
  });
  it('rejects unpaired UTF-16 surrogates in names while preserving emoji pairs',()=>{
    for(const name of ['\ud800','before\udfff','\ud800\ud800','\udfff\ud800']) {
      expect(()=>parseThemeImport(JSON.stringify({...theme,name}),info)).toThrow();
      expect(()=>parseThemeImport('{"background":"#000","foreground":"#fff"}',{...info,name})).toThrow();
    }
    const value=importedTheme({...theme,name:'🌙'.repeat(40)});
    expect(parseThemeImport(exportTheme(value).code,info).name).toBe(value.name);
  });
  it('round-trips UTF-8 JSON and share codes; normalizes shorthand while preserving legacy palettes',()=>{
    const value=parseThemeImport('{"background":"#fff","foreground":"#111"}',info);
    expect(value.colors).toMatchObject({background:'#ffffff',foreground:'#111111'});
    const encoded=exportTheme({...value,name:'Theme 日本語'});
    expect(parseThemeImport(encoded.json,info)).toEqual({...value,name:'Theme 日本語'});
    expect(parseThemeImport(encoded.code,info)).toEqual({...value,name:'Theme 日本語'});
    expect(parseThemeImport(encoded.code.replace('lazysh-theme:','moshi-theme:'),info)).toEqual({...value,name:'Theme 日本語'});
    const old=parsePreferences({...defaults,customTheme:{background:'#010203',foreground:'#fefefe'}});
    expect(old.appTheme).toBe(defaults.appTheme);expect(old.theme).toBe('custom');
    expect(terminalOptions(old).theme).toEqual(old.customTheme);
  });
  it('rejects malformed/oversized documents, URLs, injection, unsupported color semantics and transparent app surfaces',()=>{
    for(const source of ['x'.repeat(16385),' '.repeat(8193),'{', 'https://example.com/theme.json','lazysh-theme:a','lazysh-theme:%%%%', 'lazysh-theme:'+btoa('\xff'),JSON.stringify({...theme,v:2}),JSON.stringify({...theme,name:'a'.repeat(41)}),JSON.stringify({...theme,mode:'system'}),JSON.stringify({...theme,extra:true}),JSON.stringify({...theme,colors:{...theme.colors,bold:'#ffffff80'}}),JSON.stringify({...theme,colors:{background:'#ffffff00',foreground:'#fff'}}),'{"background":"url(evil)","foreground":"#fff"}','{"background":"#fff","foreground":"#111","__proto__":"#fff"}']) expect(()=>parseThemeImport(source,info)).toThrow();
    expect(()=>parseThemeImport(JSON.stringify(theme)+' '.repeat(8192),info)).toThrow();
  });
  it('keeps new selectors independent, validates metadata and defaults malformed custom app choices',()=>{
    const value=parsePreferences({...defaults,theme:'custom',appTheme:'custom',customTheme:theme.colors,customThemeInfo:info});
    expect(value.appTheme).toBe('custom');expect(value.customThemeInfo).toEqual(info);
    const bundled=parsePreferences({...value,theme:'paper'});expect(terminalOptions(bundled).theme).toEqual(expect.objectContaining({background:'#faf8f2'}));expect(bundled.appTheme).toBe('custom');
    expect(parsePreferences({...value,customThemeInfo:{name:'bad',mode:'system'}}).appTheme).toBe('forest');
  });
  it('derives readable chrome even from deliberately unreadable palettes',()=>{
    for(const background of ['#ffffff','#000000','#757575','#808080','#123456']) {
      const tokens=chromeColors(importedTheme({...theme,colors:{...theme.colors,background}}));
      for(const fg of ['text','muted','accent','danger','warning','blue','purple']) for(const bg of ['bg','panel','control','hover']) expect(contrast(tokens['--theme-'+fg],tokens['--theme-'+bg])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--theme-on-accent'],tokens['--theme-accent'])).toBeGreaterThanOrEqual(4.5);
    }
  });
});
