// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import ThemeImportPanel from './ThemeImportPanel';
import {defaults} from './preferences';
import {t,uiI18n} from './i18n/core';
afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
it('requires preview and explicit apply; input edits invalidate the reviewed candidate',()=>{
  const apply=vi.fn().mockReturnValue(true);
  render(<ThemeImportPanel preferences={defaults} apply={apply} />);
  fireEvent.change(screen.getByLabelText('Theme JSON or share code'),{target:{value:'{"v":1,"name":"Reviewed","mode":"light","colors":{"background":"#fff","foreground":"#111"}}'}});
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));
  expect(screen.getByRole('region',{name:'Theme preview'})).toBeTruthy();expect(apply).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Theme JSON or share code'),{target:{value:'bad'}});
  expect(screen.queryByRole('button',{name:'Apply to app and terminal'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));
  expect(apply).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toContain('valid theme JSON');
  fireEvent.change(screen.getByLabelText('Theme JSON or share code'),{target:{value:'{"background":"#000","foreground":"#fff"}'}});
  fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));
  fireEvent.click(screen.getByRole('button',{name:'Apply to app and terminal'}));
  expect(apply).toHaveBeenCalledExactlyOnceWith({theme:'custom',appTheme:'custom',customTheme:expect.objectContaining({background:'#000000',foreground:'#ffffff',black:'#ffffff',brightBlack:'#ffffff'}),customThemeInfo:{name:'Imported theme',mode:'dark'}});
});
it('does not read or write clipboard on mount, exports only a validated palette',()=>{
  const readText=vi.fn(),writeText=vi.fn();Object.defineProperty(navigator,'clipboard',{value:{readText,writeText},configurable:true});
  render(<ThemeImportPanel preferences={{...defaults,customTheme:{background:'#000000',foreground:'#ffffff'}}} apply={vi.fn()} />);
  expect(readText).not.toHaveBeenCalled();expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Export theme share code'}));
  expect(screen.getByLabelText<HTMLTextAreaElement>('Exported theme').value).toMatch(/^lazysh-theme:/);
  expect(writeText).not.toHaveBeenCalled();
});
it('reviews the saved name and mode and retains the candidate if persistence fails',()=>{
  const apply=vi.fn().mockReturnValue(false);
  render(<ThemeImportPanel preferences={{...defaults,theme:'custom',appTheme:'custom',customTheme:{background:'#ffffff',foreground:'#111111'},customThemeInfo:{name:'Saved daylight',mode:'light'}}} apply={apply} />);
  fireEvent.click(screen.getByRole('button',{name:'Review saved palette'}));
  expect(screen.getByRole('heading',{name:'Saved daylight'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Apply to app and terminal'}));
  expect(apply.mock.calls[0][0].customThemeInfo).toEqual({name:'Saved daylight',mode:'light'});
  expect(screen.getByRole('button',{name:'Apply to app and terminal'})).toBeTruthy();
  expect(screen.queryByText('Theme applied to app and terminal.')).toBeNull();
});

it('retranslates the retained invalid-color cause while keeping its literal key and draft',async()=>{
  const apply=vi.fn();render(<ThemeImportPanel preferences={defaults} apply={apply}/>);
  const input=screen.getByLabelText('Theme JSON or share code');
  const source=JSON.stringify({background:'#000',foreground:'#fff','{{<color>}}':'#fff'});
  fireEvent.change(input,{target:{value:source}});fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));input.focus();
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(screen.getByRole('status').textContent).toBe(t('validationInvalidThemeColorValue1',{value1:'{{<color>}}'}));
  expect(screen.getByLabelText(t('themeThemeJSONOrShareCode'))).toBe(input);
  expect(input).toHaveProperty('value',source);expect(document.activeElement).toBe(input);expect(apply).not.toHaveBeenCalled();
});

async function themeLanguages(check:()=>void){
  const{enablePseudoLocale}=await import('./test/pseudoLocale');
  for(const locale of ['en','pt-BR','es','en-XA']){
    await act(async()=>{if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);});check();
  }
}
it('retains a held clipboard read and reviewed preview through locale changes without replaying actions',async()=>{
  let finish!:(value:string)=>void;
  const readText=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;})),writeText=vi.fn();
  Object.defineProperty(navigator,'clipboard',{value:{readText,writeText},configurable:true});
  const apply=vi.fn().mockReturnValue(true);render(<ThemeImportPanel preferences={defaults} apply={apply}/>);
  const name=screen.getByLabelText('Theme name');fireEvent.change(name,{target:{value:'RAW {{name}} 中文'}});
  fireEvent.click(screen.getByRole('button',{name:'Read theme from clipboard'}));name.focus();
  await themeLanguages(()=>{
    expect(screen.getByLabelText(t('themeThemeName'))).toBe(name);expect(name).toHaveProperty('value','RAW {{name}} 中文');
    expect(document.activeElement).toBe(name);expect(readText).toHaveBeenCalledTimes(1);expect(apply).not.toHaveBeenCalled();
  });
  await act(async()=>finish('{"background":"#000","foreground":"#fff"}'));
  const preview=screen.getByRole('region',{name:t('themeThemePreview')});
  await themeLanguages(()=>{
    expect(screen.getByRole('region',{name:t('themeThemePreview')})).toBe(preview);
    expect(screen.getByRole('heading',{name:'RAW {{name}} 中文'})).toBeTruthy();
    expect(readText).toHaveBeenCalledTimes(1);expect(writeText).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
  });
  fireEvent.click(screen.getByRole('button',{name:t('themeApplyToAppAndTerminal')}));
  const message=screen.getByRole('status');
  await themeLanguages(()=>{expect(screen.getByRole('status')).toBe(message);expect(message.textContent).toBe(t('themeThemeAppliedToAppAndTerminal'));expect(apply).toHaveBeenCalledTimes(1);});
  expect(apply.mock.calls[0][0].customThemeInfo).toEqual({name:'RAW {{name}} 中文',mode:'dark'});
});
it('keeps export bytes and its retained notice stable while the initial editable fallback name stays literal',async()=>{
  const{exportTheme}=await import('./themeImport');
  const theme={v:1 as const,name:'RAW <name> {{key}}',mode:'light' as const,colors:{background:'#ffffff',foreground:'#111111'}};
  render(<ThemeImportPanel preferences={{...defaults,customTheme:theme.colors,customThemeInfo:{name:theme.name,mode:theme.mode}}} apply={vi.fn()}/>);
  const fallback=(screen.getByLabelText('Theme name') as HTMLInputElement).value;
  fireEvent.click(screen.getByRole('button',{name:'Export theme link'}));
  const output=screen.getByLabelText('Exported theme'),notice=screen.getByRole('status');
  const bytes=exportTheme(theme).link;
  await themeLanguages(()=>{
    expect(screen.getByLabelText(t('themeExportedTheme'))).toBe(output);expect(output).toHaveProperty('value',bytes);
    expect(screen.getByRole('status')).toBe(notice);expect(notice.textContent).toBe(t('themeSelectTheExportedTextToCopyIt'));
    expect(screen.getByLabelText(t('themeThemeName'))).toHaveProperty('value',fallback);
  });
});
it('translates a retained clipboard failure without reading again',async()=>{
  const readText=vi.fn().mockRejectedValue(new Error('RAW browser denied'));
  Object.defineProperty(navigator,'clipboard',{value:{readText},configurable:true});
  render(<ThemeImportPanel preferences={defaults} apply={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Read theme from clipboard'}));await screen.findByRole('status');
  await themeLanguages(()=>{expect(screen.getByRole('status').textContent).toBe(t('themeClipboardCouldNotBeReadPasteTheThemeInto'));expect(readText).toHaveBeenCalledTimes(1);});
});
it.each(['',new Error('RAW theme <{{key}}>'),{message:'RAW object'}])('preserves unknown review error %j with the original String formatting',async(raw)=>{
  const theme=await import('./themeImport');const parse=vi.spyOn(theme,'parseThemeImport').mockImplementation(()=>{throw raw;});
  try{
    render(<ThemeImportPanel preferences={defaults} apply={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));
    await themeLanguages(()=>{expect(screen.queryByRole('status')?.textContent??'').toBe(String(raw));});
  }finally{parse.mockRestore();}
});
