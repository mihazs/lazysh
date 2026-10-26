// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import ChatPanel from '../ChatPanel';
import {panelRawText} from '../test/recordedPanelData';
import {t,uiI18n} from './core';
import {enablePseudoLocale} from '../test/pseudoLocale';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{vi.mocked(invoke).mockReset();});
afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
function discovery(){
  const view=render(<ChatPanel sessionId="discovery-session"/>);
  fireEvent.change(screen.getByLabelText(t('chatAgent')),{target:{value:'grok-acp'}});
  const path=screen.getByLabelText(t('chatPath'));fireEvent.change(path,{target:{value:panelRawText}});
  const draft=screen.getByLabelText(t('chatDraftLabel'));fireEvent.change(draft,{target:{value:panelRawText}});
  return {...view,path,draft};
}
async function language(value:string){await act(async()=>{if(value==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(value);});}
it('retranslates an already-visible invalid discovery list without reopening transcripts or replacing controls',async()=>{
  vi.mocked(invoke).mockResolvedValue({schemaVersion:1,sessions:[{path:4,name:'unsafe'}]});const view=discovery();
  fireEvent.click(screen.getByRole('button',{name:t('chatFind')}));const alert=await screen.findByRole('alert');
  const original=vi.mocked(invoke).mock.calls.slice();
  expect(original).toEqual([['agent_transcripts',{sessionId:'discovery-session',agent:'grok-acp'},{headers:{'X-Lazysh-Access':expect.any(String)}}]]);
  for(const locale of ['pt-BR','es','en-XA','en']){
    await language(locale);expect(screen.getByRole('alert')).toBe(alert);expect(alert.textContent).toBe(t('panelInvalidTranscriptList'));
    expect(screen.getByLabelText(t('chatPath'))).toBe(view.path);expect(view.path).toHaveProperty('value',panelRawText);
    expect(screen.getByLabelText(t('chatDraftLabel'))).toBe(view.draft);expect(view.draft).toHaveProperty('value',panelRawText);
    expect(vi.mocked(invoke).mock.calls).toEqual(original);
  }
});
it.each([new Error(panelRawText),panelRawText,'',{message:panelRawText},null])('keeps discovery raw diagnostics literal: %j',async(error)=>{
  vi.mocked(invoke).mockRejectedValue(error);discovery();fireEvent.click(screen.getByRole('button',{name:t('chatFind')}));await act(async()=>{});
  const expected=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);
  for(const locale of ['pt-BR','es','en-XA','en']){
    await language(locale);expect(screen.queryByRole('alert')?.textContent??'').toBe(expected);expect(invoke).toHaveBeenCalledTimes(1);
  }
});
it.each(['settle','session','unmount'] as const)('retains one held discovery through locale changes and handles %s with the original request ownership',async(action)=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=discovery();fireEvent.click(screen.getByRole('button',{name:t('chatFind')}));const original=vi.mocked(invoke).mock.calls.slice();
  try{
    for(const locale of ['pt-BR','es','en-XA','en']){
      await language(locale);expect(screen.getByRole('button',{name:t('chatFind')})).toHaveProperty('disabled',true);
      expect(screen.getByLabelText(t('chatDraftLabel'))).toBe(view.draft);expect(view.draft).toHaveProperty('value',panelRawText);expect(vi.mocked(invoke).mock.calls).toEqual(original);
    }
    if(action==='session')view.rerender(<ChatPanel sessionId="replacement-session"/>);
    if(action==='unmount')view.unmount();
  }finally{await act(async()=>finish({schemaVersion:1,sessions:[{path:4,name:'unsafe'}]}));}
  if(action==='settle')expect(screen.getByRole('alert').textContent).toBe(t('panelInvalidTranscriptList'));else expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.mocked(invoke).mock.calls).toEqual(original);
});
