// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import ChatPanel from '../ChatPanel';
import {recordedTranscript,panelRawText} from '../test/recordedPanelData';
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
async function changeLocale(value:string){await act(async()=>{if(value==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(value);});}
it('retranslates an already-visible invalid discovery list without reopening transcripts or replacing controls',async()=>{
  vi.mocked(invoke).mockResolvedValue({schemaVersion:1,sessions:[{path:4,name:'unsafe'}]});const view=discovery();
  fireEvent.click(screen.getByRole('button',{name:t('chatFind')}));const alert=await screen.findByRole('alert');
  const original=vi.mocked(invoke).mock.calls.slice();
  expect(original).toEqual([['agent_transcripts',{sessionId:'discovery-session',agent:'grok-acp'},{headers:{'X-Lazysh-Access':expect.any(String)}}]]);
  for(const locale of ['pt-BR','es','en-XA','en']){
    await changeLocale(locale);expect(screen.getByRole('alert')).toBe(alert);expect(alert.textContent).toBe(t('panelInvalidTranscriptList'));
    expect(screen.getByLabelText(t('chatPath'))).toBe(view.path);expect(view.path).toHaveProperty('value',panelRawText);
    expect(screen.getByLabelText(t('chatDraftLabel'))).toBe(view.draft);expect(view.draft).toHaveProperty('value',panelRawText);
    expect(vi.mocked(invoke).mock.calls).toEqual(original);
  }
});
it.each([new Error(panelRawText),panelRawText,'',{message:panelRawText},null])('keeps discovery raw diagnostics literal: %j',async(error)=>{
  vi.mocked(invoke).mockRejectedValue(error);discovery();fireEvent.click(screen.getByRole('button',{name:t('chatFind')}));await act(async()=>{});
  const expected=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);
  for(const locale of ['pt-BR','es','en-XA','en']){
    await changeLocale(locale);expect(screen.queryByRole('alert')?.textContent??'').toBe(expected);expect(invoke).toHaveBeenCalledTimes(1);
  }
});
it.each(['settle','session','unmount'] as const)('retains one held discovery through locale changes and handles %s with the original request ownership',async(action)=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=discovery();fireEvent.click(screen.getByRole('button',{name:t('chatFind')}));const original=vi.mocked(invoke).mock.calls.slice();
  try{
    for(const locale of ['pt-BR','es','en-XA','en']){
      await changeLocale(locale);expect(screen.getByRole('button',{name:t('chatFind')})).toHaveProperty('disabled',true);
      expect(screen.getByLabelText(t('chatDraftLabel'))).toBe(view.draft);expect(view.draft).toHaveProperty('value',panelRawText);expect(vi.mocked(invoke).mock.calls).toEqual(original);
    }
    if(action==='session')view.rerender(<ChatPanel sessionId="replacement-session"/>);
    if(action==='unmount')view.unmount();
  }finally{await act(async()=>finish({schemaVersion:1,sessions:[{path:4,name:'unsafe'}]}));}
  if(action==='settle')expect(screen.getByRole('alert').textContent).toBe(t('panelInvalidTranscriptList'));else expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.mocked(invoke).mock.calls).toEqual(original);
});

const message={...recordedTranscript.messages[0],blocks:[recordedTranscript.messages[0].blocks[0]]};
const page={...recordedTranscript,messages:[message]};
const antigravity={...page,agent:'antigravity-jsonl',view:'record_stream',checkpoint:`v1:20:${'a'.repeat(64)}`};
const cases=[
  ['chatInvalidResponse',null],
  ['chatUnsupportedResponse',{...page,schemaVersion:2}],
  ['chatInvalidCheckpoint',{...antigravity,checkpoint:`v1:0:${'a'.repeat(64)}`}],
  ['chatInvalidMessage',{...page,messages:[{...message,id:4}]}],
  ['chatInvalidRecordMetadata',{...antigravity,messages:[{...message,role:'record'}]}],
  ['chatUnexpectedRecordMetadata',{...page,messages:[{...message,record:{}}]}],
  ['chatInvalidBlock',{...page,messages:[{...message,blocks:[{type:'future'}]}]}],
  ['chatInvalidContent',{...page,messages:[{...message,blocks:[{type:'text',text:42}]}]}],
  ['chatInvalidToolStatus',{...page,messages:[{...message,blocks:[{type:'tool_use',id:panelRawText,status:'failed'}]}]}],
  ['chatInvalidToolError',{...page,messages:[{...message,blocks:[{type:'text',isError:true}]}]}],
  ['chatInvalidUsage',{...page,messages:[{...message,usage:{tokens:-1}}]}],
  ['chatChanged',{...page,agent:'codex'}],
  ['chatUpdateCompanion',page],
] as const;
function openRead(agent='claude',conversation=false){
  const view=render(<ChatPanel sessionId="read-session"/>);
  if(agent!=='claude')fireEvent.change(screen.getByLabelText(t('chatAgent')),{target:{value:agent}});
  if(conversation)fireEvent.change(screen.getByLabelText(t('chatView')),{target:{value:'conversation'}});
  const path=screen.getByLabelText(t('chatPath')),draft=screen.getByLabelText(t('chatDraftLabel'));
  fireEvent.change(path,{target:{value:panelRawText}});fireEvent.change(draft,{target:{value:panelRawText}});
  fireEvent.click(screen.getByRole('button',{name:t('chatOpen')}));
  return {...view,path,draft};
}
it.each(cases)('retranslates retained %s while preserving the same draft, controls and original read',async(key,response)=>{
  vi.mocked(invoke).mockResolvedValue(response);const view=openRead('claude',key==='chatUpdateCompanion');
  const alert=await screen.findByRole('alert');expect(alert.textContent).toBe(t(key));const calls=vi.mocked(invoke).mock.calls.slice();
  expect(calls).toEqual([['agent_transcript',{sessionId:'read-session',agent:'claude',path:panelRawText,offset:0,...(key==='chatUpdateCompanion'?{view:'conversation'}:{})},{headers:{'X-Lazysh-Access':expect.any(String)}}]]);
  for(const language of ['pt-BR','es','en-XA','en']){
    await changeLocale(language);expect(screen.getByRole('alert')).toBe(alert);expect(alert.textContent).toBe(t(key));
    expect(screen.getByLabelText(t('chatPath'))).toBe(view.path);expect(view.path).toHaveProperty('value',panelRawText);
    expect(screen.getByLabelText(t('chatDraftLabel'))).toBe(view.draft);expect(view.draft).toHaveProperty('value',panelRawText);expect(vi.mocked(invoke).mock.calls).toEqual(calls);
  }
});
it.each([new Error(panelRawText),panelRawText,'',null,{message:panelRawText},new Error('TranscriptChanged literal native diagnostic')])('preserves ordinary raw read diagnostic formatting: %j',async(error)=>{
  vi.mocked(invoke).mockRejectedValue(error);openRead();await act(async()=>{});
  const expected=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);
  for(const language of ['pt-BR','es','en-XA','en']){
    await changeLocale(language);expect(screen.queryByRole('alert')?.textContent??'').toBe(expected);expect(invoke).toHaveBeenCalledTimes(1);
  }
});
it('retranslates the existing Antigravity TranscriptChanged mapping without translating unrelated host errors',async()=>{
  vi.mocked(invoke).mockRejectedValueOnce(new Error('lazysh-agent: TranscriptChanged: operation failed')).mockRejectedValueOnce(new Error(panelRawText));
  openRead('antigravity-jsonl');const alert=await screen.findByRole('alert');
  for(const language of ['pt-BR','es','en-XA','en']){
    await changeLocale(language);expect(alert.textContent).toBe(t('chatChanged'));expect(invoke).toHaveBeenCalledTimes(1);
  }
  fireEvent.click(screen.getByRole('button',{name:t('chatOpen')}));await act(async()=>{});expect(screen.getByRole('alert').textContent).toBe(panelRawText);expect(invoke).toHaveBeenCalledTimes(2);
});
it.each(['settle','session','unmount'] as const)('keeps the original held read through locale changes then handles %s without replay',async(action)=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=openRead(),calls=vi.mocked(invoke).mock.calls.slice();
  try{
    for(const language of ['pt-BR','es','en-XA','en']){
      await changeLocale(language);expect(screen.getByLabelText(t('chatPath'))).toBe(view.path);expect(view.path).toHaveProperty('value',panelRawText);
      expect(screen.getByLabelText(t('chatDraftLabel'))).toBe(view.draft);expect(view.draft).toHaveProperty('value',panelRawText);expect(vi.mocked(invoke).mock.calls).toEqual(calls);
    }
    if(action==='session')view.rerender(<ChatPanel sessionId="replacement-session"/>);
    if(action==='unmount')view.unmount();
  }finally{await act(async()=>finish(null));}
  if(action==='settle')expect(screen.getByRole('alert').textContent).toBe(t('chatInvalidResponse'));else expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.mocked(invoke).mock.calls).toEqual(calls);
});
