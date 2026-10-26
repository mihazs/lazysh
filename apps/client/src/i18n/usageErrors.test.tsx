// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import UsagePanel from '../UsagePanel';
import {recordedUsage,panelRawText} from '../test/recordedPanelData';
import {t,uiI18n} from './core';
import {enablePseudoLocale} from '../test/pseudoLocale';
vi.mock('@tauri-apps/api/core',async original=>({...await (await import('../test/nativeCoreMock')).mockNativeCore(original),isTauri:()=>true}));
beforeEach(()=>{vi.mocked(invoke).mockReset();});
afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
const window=recordedUsage.providerWindows[0];
const failures=[
  ['usageUnsupportedResponse',null],
  ['usageInvalidRecord',{...recordedUsage,samples:[{...recordedUsage.samples[0],inputTokens:-1}]}],
  ['usageInvalidContext',{...recordedUsage,recordedContext:{source:'unknown'}}],
  ['usageInvalidWindows',{...recordedUsage,providerWindows:{}}],
  ['usageInvalidWindow',{...recordedUsage,providerWindows:[{...window,usedPercent:101}]}],
  ['usageDuplicateWindow',{...recordedUsage,providerWindows:[window,window]}],
  ['panelInvalidTranscriptList',{schemaVersion:0,sessions:[]}],
  ['usageChanged',{...recordedUsage,agent:'claude',providerWindows:[]}],
] as const;
function openUsage(){
  const view=render(<UsagePanel sessionId="literal-session"/>);
  const path=screen.getByLabelText(t('usagePath'));
  fireEvent.change(screen.getByLabelText(t('usageAgent')),{target:{value:'codex'}});
  fireEvent.change(path,{target:{value:panelRawText}});
  return {...view,path};
}
async function locale(value:string){await act(async()=>{if(value==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(value);});}
it.each(failures)('retranslates retained %s without re-reading or replacing the original selection',async(key,response)=>{
  vi.mocked(invoke).mockResolvedValue(response);const {path}=openUsage();
  fireEvent.click(screen.getByRole('button',{name:t(key==='panelInvalidTranscriptList'?'usageFind':'usageInspect')}));
  const alert=await screen.findByRole('alert');expect(alert.textContent).toBe(t(key));
  const calls=vi.mocked(invoke).mock.calls.slice();
  for(const language of ['pt-BR','es','en-XA','en']){
    await locale(language);expect(screen.getByRole('alert')).toBe(alert);expect(alert.textContent).toBe(t(key));
    expect(screen.getByLabelText(t('usagePath'))).toBe(path);expect(path).toHaveProperty('value',panelRawText);expect(invoke).toHaveBeenCalledTimes(1);
  }
  expect(vi.mocked(invoke).mock.calls).toEqual(calls);
  expect(calls[0][0]).toBe(key==='panelInvalidTranscriptList'?'agent_transcripts':'agent_usage');
  expect(calls[0][1]).toEqual({sessionId:'literal-session',agent:'codex',...(key==='panelInvalidTranscriptList'?{}:{path:panelRawText,offset:0})});
});
it.each([new Error(panelRawText),panelRawText,'',null,{message:panelRawText}])('keeps native/raw diagnostic formatting literal: %j',async(error)=>{
  vi.mocked(invoke).mockRejectedValue(error);openUsage();fireEvent.click(screen.getByRole('button',{name:t('usageInspect')}));
  await act(async()=>{});
  const expected=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);
  for(const language of ['pt-BR','es','en-XA','en']){
    await locale(language);expect(screen.queryByRole('alert')?.textContent??'').toBe(expected);expect(invoke).toHaveBeenCalledTimes(1);
  }
});
it('keeps one held original request across locale changes and rejects it after session replacement',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=openUsage();fireEvent.click(screen.getByRole('button',{name:t('usageInspect')}));const calls=vi.mocked(invoke).mock.calls.slice();
  try{
    for(const language of ['pt-BR','es','en-XA','en']){
      await locale(language);expect(screen.getByLabelText(t('usagePath'))).toBe(view.path);expect(view.path).toHaveProperty('value',panelRawText);
      expect(screen.getByRole('status').textContent).toBe(t('usageReading'));expect(vi.mocked(invoke).mock.calls).toEqual(calls);
    }
    view.rerender(<UsagePanel sessionId="replacement-session"/>);
  }finally{await act(async()=>finish(null));}
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByLabelText(t('usagePath'))).toHaveProperty('value','');expect(vi.mocked(invoke).mock.calls).toEqual(calls);
});
