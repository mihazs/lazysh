// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import VoicePanel from '../VoicePanel';
import {dictationInput,type DirectDictation} from '../voiceDelivery';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {installSpeechCapture} from '../test/speechCapture';
import {catalogEntry,type DownloadCall,downloadFixture} from '../test/voiceDownloadFixture';
import {parakeetBytes,parakeetFixture} from '../test/parakeetFixture';
import {cloudSnapshot,configuredCloudReply} from '../test/cloudVoiceData';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>({...await (await import('../test/nativeCoreMock')).mockNativeCore(original),Channel:class {onmessage:((event:unknown)=>void)|undefined;}}));
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic Voice control locale fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'d'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
});
afterEach(async()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllGlobals();await uiI18n.changeLanguage('en');});
async function languagesKeep(check:()=>void){
  const calls=[...vi.mocked(invoke).mock.calls];
  for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});check();expect(vi.mocked(invoke).mock.calls).toEqual(calls);}
}
it.each(['valid','invalid'] as const)('preserves recording, model/language, request lease and claimed Enter delivery for a %s result across locales',async outcome=>{
  let finish!:(text:string)=>void;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='voice_models')return [{id:'tiny.bin',bytes:1024}];
    if(command==='voice_model_catalog')return [];
    if(command==='voice_transcribe')return new Promise<string>(resolve=>{finish=resolve;});
    return undefined;
  });
  const speech=installSpeechCapture();const queued:string[]=[];
  const deliver=vi.fn(async(request:DirectDictation)=>{const data=dictationInput(request.text,request.autoSend);expect(request.claim()).toBe(true);queued.push(data);expect(request.claim()).toBe(false);});
  render(<VoicePanel sessionId="unchanged-session" onDirectDictation={deliver}/>);
  await waitFor(()=>expect(screen.getByLabelText(t('voiceModel'))).toHaveProperty('value','tiny.bin'));
  fireEvent.change(screen.getByLabelText(t('voiceLanguage')),{target:{value:'pt'}});
  fireEvent.click(screen.getByLabelText(t('voiceTypeDirect')));fireEvent.click(screen.getByLabelText(t('voiceAutoSend')));
  const draft=screen.getByLabelText(t('voiceDraft'));fireEvent.change(draft,{target:{value:'editable old draft {{x}}'}});
  fireEvent.click(screen.getByRole('button',{name:t('voiceRecord')}));await screen.findByRole('button',{name:t('voiceStop')});
  await languagesKeep(()=>{expect(screen.getByRole('button',{name:t('voiceStop')})).toBeTruthy();expect(screen.getByLabelText(t('voiceModel'))).toHaveProperty('value','tiny.bin');expect(screen.getByLabelText(t('voiceLanguage'))).toHaveProperty('value','pt');expect(screen.getByLabelText(t('voiceAutoSend'))).toHaveProperty('checked',true);expect(speech.captures).toHaveLength(1);expect(speech.captures[0].state).toBe('recording');expect(speech.stop).not.toHaveBeenCalled();});
  fireEvent.click(screen.getByRole('button',{name:t('voiceStop')}));await waitFor(()=>expect(finish).toBeTypeOf('function'));
  await languagesKeep(()=>{expect(screen.getByText(t('voiceTranscribingLocal'))).toBeTruthy();expect(screen.getByLabelText(t('voiceDraft'))).toBe(draft);expect(draft).toHaveProperty('value','editable old draft {{x}}');expect(deliver).not.toHaveBeenCalled();});
  const text=outcome==='valid'?'echo 世界':'first\nsecond';await act(async()=>{finish(text);});
  expect(draft).toHaveProperty('value',text);
  if(outcome==='valid'){
    expect(queued).toEqual(['echo 世界\r']);expect(deliver).toHaveBeenCalledOnce();
    await languagesKeep(()=>expect(screen.getByText(t('voiceQueuedEnter'))).toBeTruthy());
  }else{expect(queued).toEqual([]);await languagesKeep(()=>expect(screen.getAllByRole('alert').some(alert=>alert.textContent===t('voiceDeliveryOneLine'))).toBe(true));}
  expect(invoke).toHaveBeenCalledWith('voice_transcribe',{id:'tiny.bin',samples:Array(1600).fill(0),language:'pt'},{headers:{'X-Lazysh-Access':'d'.repeat(64)}});
});
it('retains exact download channel/request IDs and progress parameters while messages retranslate',async()=>{
  const nativeLabel='Native {{raw}} $t(voiceTitle) <b>label</b>';
  const fixture=downloadFixture([],{...catalogEntry,label:nativeLabel});render(<VoicePanel/>);
  fireEvent.click(await screen.findByRole('button',{name:t('voiceDownloadSelected')}));
  const request=vi.mocked(invoke).mock.calls.find(([command])=>command==='voice_download_model')![1] as DownloadCall;
  await languagesKeep(()=>expect(screen.getByText(t('voiceConnectingPublisher'))).toBeTruthy());
  await act(async()=>{request.events.onmessage({requestId:request.requestId,received:Math.floor(catalogEntry.bytes/2),total:catalogEntry.bytes,stage:'downloading'});});
  const progress=screen.getByRole('progressbar',{name:t('voiceModelDownload')});
  await languagesKeep(()=>{expect(screen.getByText(t('voiceDownloadProgress',{percent:49}))).toBeTruthy();expect(screen.getByRole('progressbar',{name:t('voiceModelDownload')})).toBe(progress);expect(progress).toHaveProperty('value',Math.floor(catalogEntry.bytes/2));expect(screen.getByRole('combobox',{name:t('voiceDownloadableModel')})).toHaveProperty('value',catalogEntry.id);expect((screen.getByRole('combobox',{name:t('voiceDownloadableModel')}) as HTMLSelectElement).selectedOptions[0].textContent).toContain(nativeLabel);});
  await act(async()=>{request.events.onmessage({requestId:request.requestId,received:catalogEntry.bytes,total:catalogEntry.bytes,stage:'verifying'});});
  await languagesKeep(()=>expect(screen.getByText(t('voiceVerifyingModel'))).toBeTruthy());
  fireEvent.click(screen.getByRole('button',{name:t('voiceCancelDownload')}));
  await languagesKeep(()=>expect(screen.getByText(t('voiceCancellingModel'))).toBeTruthy());
  expect(invoke).toHaveBeenLastCalledWith('voice_download_cancel',{requestId:request.requestId},{headers:{'X-Lazysh-Access':'d'.repeat(64)}});
  await act(async()=>{fixture.fail('Native model download cancelled');});
});
it('keeps native Parakeet stages and finishing ownership while only captions change',async()=>{
  const fixture=parakeetFixture();render(<VoicePanel/>);
  await waitFor(()=>expect(screen.getByRole('option',{name:t('voiceParakeetOption')})).toHaveProperty('disabled',false));
  fireEvent.change(screen.getByLabelText(t('voiceSpeechEngine')),{target:{value:'parakeet'}});vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button',{name:t('voiceDownloadParakeet')}));
  const request=vi.mocked(invoke).mock.calls.find(([command])=>command==='voice_parakeet_install')![1] as {requestId:string;events:{onmessage:(value:unknown)=>void}};
  for(const [stage,key] of [['preparing','voiceParakeetPreparing'],['loading','voiceParakeetLoading'],['removing','voiceParakeetRemoving'],['transcribing','voiceParakeetTranscribing']] as const){
    await act(async()=>{request.events.onmessage({...fixture.status,stage,total:parakeetBytes,requestId:request.requestId});});
    await languagesKeep(()=>{expect(screen.getByText(t(key))).toBeTruthy();expect(screen.getByLabelText(t('voiceSpeechEngine'))).toHaveProperty('disabled',true);});
  }
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:t('voiceCancel')}));});
  await languagesKeep(()=>{expect(screen.getByText(t('voiceParakeetFinishing'))).toBeTruthy();expect(screen.getByRole('button',{name:t('voiceFinishingCancel')})).toHaveProperty('disabled',true);});
  expect(invoke).toHaveBeenCalledWith('voice_parakeet_cancel',{requestId:request.requestId},{headers:{'X-Lazysh-Access':'d'.repeat(64)}});
  Object.assign(fixture.status,{busy:false,requestId:null,stage:'idle'});await act(async()=>{fixture.install();});
});
it.each(['','Parakeet requires a supported Linux x86_64 desktop.','Native <reason> {{key}}'])('distinguishes the local initial reason from received native reason %j without text matching',async reason=>{
  let release!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='voice_parakeet_status'?new Promise(resolve=>{release=resolve;}):[]);
  render(<VoicePanel/>);
  await languagesKeep(()=>expect(screen.getByText(t('voiceEngineReason',{engine:'Parakeet',reason:t('voiceParakeetInitial')}))).toBeTruthy());
  await act(async()=>{release({available:false,reason,installed:false,ready:false,busy:false,stage:'idle',requestId:null,received:0,total:parakeetBytes});});
  await languagesKeep(()=>expect(screen.getByText((_text,element)=>element?.tagName==='P'&&element.textContent===t('voiceEngineReason',{engine:'Parakeet',reason}))).toBeTruthy());
});
it('retains a raw microphone failure plus appended local Cloud cleanup warning as separate causes',async()=>{
  const value=cloudSnapshot();let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='voice_cloud_begin')return '12345678-1234-4234-8234-123456789abc';
    if(command==='voice_cloud_cancel')return new Promise(resolve=>{finish=resolve;});
    return configuredCloudReply(command,value);
  });
  const speech=installSpeechCapture();speech.microphone.mockRejectedValueOnce(new Error('voiceRecordingFailed <native denial> {{raw}}'));
  render(<VoicePanel/>);fireEvent.change(screen.getByLabelText(t('voiceSpeechEngine')),{target:{value:'cloud'}});
  await waitFor(()=>expect(screen.getByRole('button',{name:t('voiceRecord')})).toHaveProperty('disabled',false));fireEvent.click(screen.getByRole('button',{name:t('voiceRecord')}));
  await screen.findByText('voiceRecordingFailed <native denial> {{raw}}');await act(async()=>{finish({cancelled:true,cleanup:'unconfirmed'});});
  await languagesKeep(()=>expect(screen.getAllByRole('alert').some(alert=>alert.textContent==='voiceRecordingFailed <native denial> {{raw}} '+t('voiceCloudCleanup'))).toBe(true));
});
it('retranslates an already-visible local model validation without reading/importing a file',async()=>{
  vi.mocked(invoke).mockResolvedValue([]);render(<VoicePanel/>);
  fireEvent.change(screen.getByLabelText(t('voiceImportModel')),{target:{files:[new File(['tiny'],'../unsafe.bin')]}});
  await languagesKeep(()=>expect(screen.getAllByRole('alert').some(alert=>alert.textContent===t('voiceModelFile'))).toBe(true));
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command.startsWith('voice_import_'))).toBe(false);
});
it.each(['','Apple SpeechAnalyzer requires a supported iOS device.','Native Apple <reason> {{raw}}'])('keeps the received Apple reason %j verbatim, including empty text',async reason=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='apple_speech_capability'?{available:true,reason,supportedLanguages:['en-US'],installedLanguages:[],reservedLanguages:[]}:[]);
  render(<VoicePanel/>);await waitFor(()=>expect(screen.getByRole('option',{name:'Apple SpeechAnalyzer'})).toHaveProperty('disabled',false));
  fireEvent.change(screen.getByLabelText(t('voiceSpeechEngine')),{target:{value:'apple'}});
  const paragraph=screen.getByLabelText(t('voiceAppleLanguage')).parentElement!.previousElementSibling;
  await languagesKeep(()=>{expect(paragraph?.textContent).toBe(reason);expect(paragraph?.isConnected).toBe(true);});
});
it('keeps Apple install/release ownership and language while retained asset progress re-translates',async()=>{
  const capability={available:true,reason:'Native Apple engine',supportedLanguages:['en-US'],installedLanguages:[] as string[],reservedLanguages:[] as string[]};
  let release!:()=>void;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='apple_speech_capability')return capability;
    if(command==='apple_speech_install'||command==='apple_speech_remove')return new Promise<void>(resolve=>{release=resolve;});
    return [];
  });
  render(<VoicePanel/>);await waitFor(()=>expect(screen.getByRole('option',{name:'Apple SpeechAnalyzer'})).toHaveProperty('disabled',false));fireEvent.change(screen.getByLabelText(t('voiceSpeechEngine')),{target:{value:'apple'}});
  for(const remove of [false,true]){
    fireEvent.click(screen.getByRole('button',{name:t(remove?'voiceReleaseAppleLanguage':'voiceDownloadAppleLanguage')}));
    const request=vi.mocked(invoke).mock.calls.at(-1)!;expect(request[0]).toBe(remove?'apple_speech_remove':'apple_speech_install');
    expect(request[1]).toMatchObject({language:'en-US',requestId:expect.stringMatching(/^[0-9a-f-]{36}$/)});expect(request[2]).toEqual({headers:{'X-Lazysh-Access':'d'.repeat(64)}});
    await languagesKeep(()=>{expect(screen.getByText(t(remove?'voiceReleasingApple':'voiceDownloadingApple'))).toBeTruthy();expect(screen.getByLabelText(t('voiceAppleLanguage'))).toHaveProperty('value','en-US');});
    capability.installedLanguages=remove?[]:['en-US'];capability.reservedLanguages=remove?[]:['en-US'];await act(async()=>{release();});
  }
});
it('retains import progress and exact owned import ID/bytes without rereading the file on locale changes',async()=>{
  const models:{id:string;bytes:number}[]=[];let release!:()=>void;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='voice_models')return models;
    if(command==='voice_import_begin')return 'owned-import';
    if(command==='voice_import_finish'&&(args as {cancel:boolean}).cancel===false)return new Promise<void>(resolve=>{release=resolve;});
    return [];
  });
  render(<VoicePanel/>);const slice=vi.fn(()=>({arrayBuffer:async()=>new ArrayBuffer(1024)}));
  fireEvent.change(screen.getByLabelText(t('voiceImportModel')),{target:{files:[{name:'trusted.bin',size:1024,slice}]}});
  await screen.findByText(t('voiceImportProgress',{percent:100}));
  await languagesKeep(()=>{expect(screen.getByText(t('voiceImportProgress',{percent:100}))).toBeTruthy();expect(slice).toHaveBeenCalledOnce();});
  expect(invoke).toHaveBeenCalledWith('voice_import_chunk',{id:'owned-import',offset:0,bytes:Array(1024).fill(0)},{headers:{'X-Lazysh-Access':'d'.repeat(64)}});
  models.push({id:'trusted.bin',bytes:1024});await act(async()=>{release();});expect(screen.getByLabelText(t('voiceModel'))).toHaveProperty('value','trusted.bin');
});
