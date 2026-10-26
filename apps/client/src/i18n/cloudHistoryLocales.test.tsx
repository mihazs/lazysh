// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import CloudVoiceSettingsPanel from '../CloudVoiceSettingsPanel';
import VoiceHistoryPanel from '../VoiceHistoryPanel';
import VoicePanel from '../VoicePanel';
import {useDictationHistory} from '../voiceHistory';
import {cloudSnapshot,configuredCloudReply} from '../test/cloudVoiceData';
import {installSpeechCapture} from '../test/speechCapture';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {t,uiI18n} from './core';
import type {CloudSnapshot} from '../cloudVoice';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic Cloud/history localization',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'e'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
});
afterEach(async()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllGlobals();localStorage.clear();await uiI18n.changeLanguage('en');});
async function localized(check:()=>void){
  const calls=[...vi.mocked(invoke).mock.calls];
  for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});check();expect(vi.mocked(invoke).mock.calls).toEqual(calls);}
}
function Settings(){const [snapshot,setSnapshot]=useState<CloudSnapshot>();return <CloudVoiceSettingsPanel snapshot={snapshot} onSnapshot={setSnapshot} disabled={false} onBusy={()=>{}}/>;}
it('keeps explicit enrollment, password identity and held metadata checks while quota formatting follows the locale',async()=>{
  const value=cloudSnapshot();let release!:(value:CloudSnapshot)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='voice_cloud_status'?{configured:false}:new Promise<CloudSnapshot>(resolve=>{release=resolve;}));
  render(<Settings/>);
  await waitFor(()=>expect(screen.getByRole('textbox',{name:t('cloudSettingsOrigin')})).toHaveProperty('disabled',false));
  const origin=screen.getByRole('textbox',{name:t('cloudSettingsOrigin')});const token=screen.getByLabelText(t('cloudSettingsToken'));
  fireEvent.change(origin,{target:{value:value.origin}});fireEvent.change(token,{target:{value:'b'.repeat(64)}});token.focus();
  await localized(()=>{expect(screen.getByLabelText(t('cloudSettingsToken'))).toBe(token);expect(document.activeElement).toBe(token);expect(token).toHaveProperty('value','b'.repeat(64));expect(origin).toHaveProperty('value',value.origin);});
  fireEvent.click(screen.getByRole('button',{name:t('cloudSettingsVerify')}));
  await localized(()=>expect(screen.getByRole('status').textContent).toBe(t('cloudSettingsChecking')));
  await act(async()=>{release(value);});
  await localized(()=>{
    expect(screen.getByLabelText(t('cloudSettingsToken'))).toHaveProperty('value','');
    expect(screen.getByText(t('cloudSettingsServiceModel',{origin:value.origin,model:value.capabilities.model}))).toBeTruthy();
    expect(screen.getByText(t('cloudSettingsWindow',{start:new Date(value.quota.windowStart*1000).toISOString(),end:new Date(value.quota.windowEnd*1000).toISOString()}))).toBeTruthy();
  });
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['voice_cloud_status','voice_cloud_enroll']);
  expect(invoke).toHaveBeenLastCalledWith('voice_cloud_enroll',{origin:value.origin,token:'b'.repeat(64)},{headers:{'X-Lazysh-Access':'e'.repeat(64)}});
});
it.each([
  {name:'configuration validation',command:'voice_cloud_status',value:null,key:'cloudInvalidStatus'},
  {name:'origin mismatch',command:'voice_cloud_refresh',value:{...cloudSnapshot(),origin:'https://other.example.com'},key:'cloudOriginMismatch'},
  {name:'capabilities validation',command:'voice_cloud_refresh',value:{...cloudSnapshot(),capabilities:{}},key:'cloudInvalidCapabilities'},
  {name:'quota validation',command:'voice_cloud_refresh',value:{...cloudSnapshot(),quota:{}},key:'cloudInvalidQuota'},
  {name:'raw diagnostic',command:'voice_cloud_status',raw:'cloudInvalidStatus <raw/user/path> {{value}}'},
] as const)('keeps already-visible $name current without repeating protected requests',async scenario=>{
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command===scenario.command){if('raw' in scenario)throw {key:'cloudInvalidStatus',message:scenario.raw};return scenario.value;}
    return {configured:true,origin:cloudSnapshot().origin};
  });
  render(<Settings/>);const alert=await screen.findByRole('alert');
  await localized(()=>{expect(screen.getByRole('alert')).toBe(alert);expect(alert.textContent).toBe('raw' in scenario?scenario.raw:t(scenario.key));expect(document.querySelector('img,script')).toBeNull();});
});
it('renders a truthful unavailable check time if a safe integer is outside the Intl Date range',()=>{
  vi.mocked(invoke).mockResolvedValue({configured:false});
  render(<CloudVoiceSettingsPanel snapshot={{...cloudSnapshot(),checkedAt:Number.MAX_SAFE_INTEGER}} onSnapshot={()=>{}} disabled={false} onBusy={()=>{}}/>);
  expect(screen.getByText(t('cloudSettingsChecked',{time:t('unavailable')}))).toBeTruthy();
});
it('retranslates history errors while retaining capture revision, exact text, entry identity and recording timestamp',async()=>{
  const hook=renderHook(()=>useDictationHistory());await waitFor(()=>expect(hook.result.current.ready).toBe(true));
  const captured=hook.result.current.capture();
  await act(async()=>{await hook.result.current.add('raw transcription {{name}} <img src=secret>',captured);});
  const reuse=vi.fn();const view=render(<VoiceHistoryPanel history={hook.result.current} onReuse={reuse}/>);
  fireEvent.click(screen.getByText(t('historyRecent',{count:1})));
  const row=screen.getByRole('listitem');
  for(const locale of ['pt-BR','es','en']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    view.rerender(<VoiceHistoryPanel history={hook.result.current} onReuse={reuse}/>);
    expect(screen.getByRole('listitem')).toBe(row);
    expect(screen.getByRole('alert').textContent).toBe(t('historyLoadFailed'));
    expect(hook.result.current.capture()).toMatchObject({revision:captured.revision,epoch:captured.epoch,remember:captured.remember});
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(new Date(captured.createdAt).toISOString());
    fireEvent.click(screen.getByRole('button',{name:t('historyReuseLabel',{index:1})}));
  }
  expect(reuse.mock.calls).toEqual(Array(3).fill(['raw transcription {{name}} <img src=secret>']));expect(invoke).not.toHaveBeenCalled();
  await act(async()=>{await hook.result.current.setRemember(true);});
  for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});view.rerender(<VoiceHistoryPanel history={hook.result.current} onReuse={reuse}/>);expect(screen.getByRole('alert').textContent).toBe(t('historyEnableFailed'));}
  expect(document.querySelector('img,script')).toBeNull();
});
it('locale subscriptions do not cancel or replace an active Cloud transcription, draft or original session lease',async()=>{
  const value=cloudSnapshot(),id='12345678-1234-4234-8234-123456789abc';let complete!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='voice_cloud_begin')return id;
    if(command==='voice_cloud_transcribe')return new Promise(resolve=>{complete=resolve;});
    return configuredCloudReply(command,value);
  });
  const microphone=installSpeechCapture();render(<VoicePanel sessionId="literal-session"/>);
  fireEvent.change(screen.getByLabelText(t('voiceSpeechEngine')),{target:{value:'cloud'}});
  await waitFor(()=>expect(screen.getByRole('button',{name:t('cloudSettingsRefresh')})).toHaveProperty('disabled',false));
  const draft=screen.getByLabelText(t('voiceDraft'));fireEvent.change(draft,{target:{value:'keep existing draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
  await waitFor(()=>expect(complete).toBeTypeOf('function'));
  await localized(()=>{expect(screen.getByLabelText(t('voiceDraft'))).toBe(draft);expect(draft).toHaveProperty('value','keep existing draft');expect(screen.getByLabelText(t('voiceSpeechEngine'))).toHaveProperty('value','cloud');expect(microphone.microphone).toHaveBeenCalledOnce();});
  await act(async()=>{complete({requestId:id,text:'verbatim {{text}} <b>not HTML</b>',quota:value.quota,checkedAt:value.checkedAt+1000});});
  expect(draft).toHaveProperty('value','verbatim {{text}} <b>not HTML</b>');
  expect(invoke).toHaveBeenCalledWith('voice_cloud_transcribe',{requestId:id,sessionId:'literal-session',samples:Array(1600).fill(0),language:'auto'},{headers:{'X-Lazysh-Access':'e'.repeat(64)}});
});
