// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { installSpeechCapture } from "./test/speechCapture";
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import VoicePanel from './VoicePanel';
import { accessSnapshot, applyAccessStatus } from './access';

vi.mock('@tauri-apps/api/core', async original => ({ ...await (await import("./test/nativeCoreMock")).mockNativeCore(original), Channel:class {onmessage:((event:unknown)=>void)|undefined;} }));
afterEach(() => { cleanupNativeMocks(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'}); });

it('requires a local model and explicit recording and handles microphone denial', async () => {
  vi.mocked(invoke).mockResolvedValue([{id:'ggml-tiny.en.bin',bytes:75*1024*1024}]);
  const getUserMedia = vi.fn().mockRejectedValue(new Error('Microphone permission denied'));
  vi.stubGlobal('MediaRecorder',class {});
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}});
  render(<VoicePanel sessionId="ssh1" />);
  await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('ggml-tiny.en.bin'));
  expect(getUserMedia).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  expect(await screen.findByText('Microphone permission denied')).toHaveProperty('textContent','Microphone permission denied');
  expect(invoke).not.toHaveBeenCalledWith('voice_transcribe',expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
});

it('stages an edited draft only on explicit request and never sends terminal input', async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  const listener = vi.fn(); window.addEventListener('lazysh-prompt-draft',listener);
  render(<VoicePanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText('Dictation draft'),{target:{value:'review this code'}});
  expect(listener).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Stage in terminal composer'}));
  expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'ssh1',text:'review this code'});
  expect(vi.mocked(invoke).mock.calls.every(([name]) => name === 'voice_models' || name === 'apple_speech_capability' || name==='voice_model_catalog' || name==='voice_parakeet_status')).toBe(true);
  window.removeEventListener('lazysh-prompt-draft',listener);
});

const catalogEntry={id:'tiny.en',file:'ggml-tiny.en.bin',label:'Tiny · English',bytes:77704715,sha256:'921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',revision:'5359861c739e955e79d9a303bcbc70fb988958b1'};
type DownloadCall={id:string;requestId:string;events:{onmessage:(event:unknown)=>void}};
function downloadFixture(installed:{id:string;bytes:number}[]=[]) {
  let complete!:()=>void;let fail!:(error:Error)=>void;
  vi.mocked(invoke).mockImplementation(command=>{
    if(command==='voice_models')return Promise.resolve(installed) as never;
    if(command==='voice_model_catalog')return Promise.resolve([catalogEntry]) as never;
    if(command==='voice_download_model')return new Promise<void>((resolve,reject)=>{complete=resolve;fail=reject;}) as never;
    if(command==='voice_download_cancel')return Promise.resolve(true) as never;
    return Promise.resolve() as never;
  });
  return {installed,complete:()=>complete(),fail:(message:string)=>fail(new Error(message))};
}
it('downloads only on explicit click, shows bounded progress and selects the installed model',async()=>{
  const fixture=downloadFixture();render(<VoicePanel sessionId="ssh1"/>);
  const button=await screen.findByRole('button',{name:'Download selected model'});
  expect(invoke).not.toHaveBeenCalledWith('voice_download_model',expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
  fireEvent.click(button);
  const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='voice_download_model')![1] as DownloadCall;
  expect(request.id).toBe('tiny.en');expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(request).not.toHaveProperty('url');expect(request).not.toHaveProperty('sha256');
  expect((screen.getByLabelText('Import model') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:'Record speech'}) as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>{request.events.onmessage({requestId:request.requestId,received:100,total:catalogEntry.bytes,stage:'downloading'});});
  expect(screen.getByRole('progressbar',{name:'Model download'}).getAttribute('value')).toBe('100');
  await act(async()=>{request.events.onmessage({requestId:request.requestId,received:catalogEntry.bytes,total:catalogEntry.bytes,stage:'verifying'});});
  expect(screen.getByRole('status').textContent).toContain('SHA-256');
  fixture.installed.push({id:catalogEntry.file,bytes:catalogEntry.bytes});
  await act(async()=>{fixture.complete();});
  await waitFor(()=>expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe(catalogEntry.file));
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(invoke).not.toHaveBeenCalledWith('voice_transcribe',expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
});
it('waits for cancellation cleanup and ignores stale download progress without installing',async()=>{
  const fixture=downloadFixture();render(<VoicePanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Download selected model'}));
  const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='voice_download_model')![1] as DownloadCall;
  fireEvent.click(screen.getByRole('button',{name:'Cancel download'}));
  expect(invoke).toHaveBeenCalledWith('voice_download_cancel',{requestId:request.requestId}, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect((screen.getByRole('button',{name:'Cancelling download…'}) as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>{request.events.onmessage({requestId:request.requestId,received:catalogEntry.bytes,total:catalogEntry.bytes,stage:'installed'});});
  expect(screen.getByRole('status').textContent).toContain('Cancelling');
  await act(async()=>{fixture.fail('Model download cancelled');});
  await waitFor(()=>expect((screen.getByRole('button',{name:'Download selected model'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
  expect(screen.queryAllByRole('alert').filter(alert=>!alert.closest('[aria-label="Dictation history"]'))).toEqual([]);
});
it('reports verification failure and cancels an in-flight download on unmount',async()=>{
  const fixture=downloadFixture();const view=render(<VoicePanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Download selected model'}));
  await act(async()=>{fixture.fail('Model SHA-256 verification failed; no model was installed');});
  expect(await screen.findByText('Model SHA-256 verification failed; no model was installed')).toHaveProperty('textContent','Model SHA-256 verification failed; no model was installed');
  expect((screen.getByRole('button',{name:'Download selected model'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Download selected model'}));
  const calls=vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_download_model');
  const request=calls.at(-1)![1] as DownloadCall;
  view.unmount();
  expect(invoke).toHaveBeenCalledWith('voice_download_cancel',{requestId:request.requestId}, { headers: { "X-Lazysh-Access": expect.any(String) } });
  await act(async()=>{fixture.fail('Model download cancelled');});
});
it('disables downloads for an existing file and at the three-model quota',async()=>{
  const fixture=downloadFixture([{id:catalogEntry.file,bytes:catalogEntry.bytes}]);
  const view=render(<VoicePanel/>);
  expect((await screen.findByRole('button',{name:'Download selected model'}) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  fixture.installed.splice(0,1,{id:'one.bin',bytes:1024},{id:'two.bin',bytes:1024},{id:'three.bin',bytes:1024});
  render(<VoicePanel/>);
  expect((await screen.findByRole('button',{name:'Download selected model'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/maximum three/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith('voice_download_model',expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
});

it('releases a microphone granted after the dictation view has closed', async () => {
  vi.mocked(invoke).mockResolvedValue([{id:'tiny.bin',bytes:1024}]);
  let grant!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn().mockImplementation(() => new Promise<MediaStream>(resolve => {grant=resolve;}));
  const stop = vi.fn(); const capture = vi.fn();
  vi.stubGlobal('MediaRecorder',capture);
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}});
  const view = render(<VoicePanel />);
  await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('tiny.bin'));
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  view.unmount();
  grant({getTracks:() => [{stop}]} as unknown as MediaStream);
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(capture).not.toHaveBeenCalled();
});

it('requires explicit Apple asset installation and cancels the exact pending request', async () => {
  let complete: (()=>void)|undefined;
  vi.mocked(invoke).mockImplementation((command)=>{
    if(command==='voice_models')return Promise.resolve([]) as never;
    if(command==='apple_speech_capability')return Promise.resolve({available:true,reason:'On-device speech',supportedLanguages:['en-US'],installedLanguages:[],reservedLanguages:[]}) as never;
    if(command==='apple_speech_install')return new Promise<void>(resolve=>{complete=resolve;}) as never;
    return Promise.resolve() as never;
  });
  render(<VoicePanel/>);
  await waitFor(()=>expect((screen.getByRole('option',{name:'Apple SpeechAnalyzer'}) as HTMLOptionElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Speech engine'),{target:{value:'apple'}});
  expect((screen.getByRole('button',{name:'Record speech'}) as HTMLButtonElement).disabled).toBe(true);
  expect(invoke).not.toHaveBeenCalledWith('apple_speech_install',expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
  fireEvent.click(screen.getByRole('button',{name:'Download Apple speech language'}));
  const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='apple_speech_install')?.[1];
  expect(request).toEqual({language:'en-US',requestId:expect.stringMatching(/^[0-9a-f-]{36}$/)});
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(invoke).toHaveBeenCalledWith('apple_speech_cancel',{requestId:(request as {requestId:string}).requestId}, { headers: { "X-Lazysh-Access": expect.any(String) } });
  complete?.();
  await waitFor(()=>expect(screen.queryByText('Downloading Apple speech assets…')).toBeNull());
  expect(invoke).not.toHaveBeenCalledWith('apple_speech_transcribe',expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
});
it('preserves current-view dictation and cannot refill cleared history from late inference',async()=>{
  const {complete}=speechFixture();
  const stage=vi.fn();window.addEventListener('lazysh-prompt-draft',stage);
  const view=render(<VoicePanel sessionId="ssh1"/>);
  await waitFor(()=>expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('tiny.bin'));
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('voice_transcribe',expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } }));
  await act(async()=>{complete('first private prompt');});
  expect(localStorage.length).toBe(0);
  fireEvent.change(screen.getByLabelText('Dictation draft'),{target:{value:'edited draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Reuse dictation 1'}));
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','first private prompt');expect(stage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
  await waitFor(()=>expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_transcribe')).toHaveLength(2));
  fireEvent.click(screen.getByRole('button',{name:'Clear history'}));
  await act(async()=>{complete('result after clear');});
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','result after clear');
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Reuse dictation 1'})).toBeNull());
  expect(screen.queryByRole('button',{name:'Reuse dictation 1'})).toBeNull();
  expect(stage).not.toHaveBeenCalled();
  view.unmount();window.removeEventListener('lazysh-prompt-draft',stage);
});

function speechFixture(){
  let complete!:(text:string)=>void;
  vi.mocked(invoke).mockImplementation(command=>{
    if(command==='voice_models')return Promise.resolve([{id:'tiny.bin',bytes:1024}]) as never;
    if(command==='voice_model_catalog')return Promise.resolve([]) as never;
    if(command==='voice_transcribe')return new Promise<string>(resolve=>{complete=resolve;}) as never;
    return Promise.resolve() as never;
  });
  installSpeechCapture();
  return {complete:(text:string)=>complete(text),record:async()=>{
    await waitFor(()=>expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('tiny.bin'));
    const before=vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_transcribe').length;
    fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
    fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
    await waitFor(()=>expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_transcribe')).toHaveLength(before+1));
  }};
}
it('keeps review as default, captures opt-in delivery choices and leaves history reuse draft-only',async()=>{
  const speech=speechFixture(),deliver=vi.fn(async(request:import('./voiceDelivery').DirectDictation)=>{expect(request.claim()).toBe(true);expect(request.claim()).toBe(false);});
  render(<VoicePanel sessionId="ssh-current" onDirectDictation={deliver}/>);
  expect(screen.getByLabelText('Type final result directly into terminal')).toHaveProperty('checked',false);
  expect(screen.getByLabelText('Auto-send: press Enter')).toHaveProperty('disabled',true);
  await speech.record();await act(async()=>speech.complete('review me'));expect(deliver).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));
  await speech.record();
  expect(screen.getByRole('group',{name:'Dictation delivery'})).toHaveProperty('disabled',true);
  await act(async()=>speech.complete('type me'));
  expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:'ssh-current',text:'type me',autoSend:false}));
  fireEvent.click(screen.getByLabelText('Auto-send: press Enter'));await speech.record();await act(async()=>speech.complete('send me'));
  expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({text:'send me',autoSend:true}));
  const count=deliver.mock.calls.length;fireEvent.click(screen.getByRole('button',{name:'Reuse dictation 1'}));expect(deliver).toHaveBeenCalledTimes(count);
  fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));expect(screen.getByLabelText('Auto-send: press Enter')).toHaveProperty('checked',false);
});
for(const action of ['cancel','background','unmount'] as const){
  it(`does not deliver a late result after ${action}`,async()=>{
    const speech=speechFixture(),deliver=vi.fn().mockResolvedValue(undefined);
    const view=render(<VoicePanel sessionId="old-session" onDirectDictation={deliver}/>);
    fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));
    fireEvent.click(screen.getByLabelText('Auto-send: press Enter'));await speech.record();
    if(action==='cancel')fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    else if(action==='unmount')view.unmount();
    else {Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});fireEvent(document,new Event('visibilitychange'));}
    await act(async()=>speech.complete('late command'));
    expect(deliver).not.toHaveBeenCalled();
    if(action==='background')Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  });
}
it('keeps the draft after a failed direct write and never automatically retries',async()=>{
  const speech=speechFixture(),deliver=vi.fn(async(request:import('./voiceDelivery').DirectDictation)=>{request.claim();throw new Error('Terminal input queue is full or disconnected');});
  render(<VoicePanel sessionId="ssh-current" onDirectDictation={deliver}/>);
  fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));
  fireEvent.click(screen.getByLabelText('Auto-send: press Enter'));await speech.record();await act(async()=>speech.complete('keep this command'));
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','keep this command');
  expect(await screen.findByText('Terminal input queue is full or disconnected')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Dictation draft'),{target:{value:'edited'}});
  expect(deliver).toHaveBeenCalledOnce();expect(deliver.mock.calls[0][0].claim()).toBe(false);
});
it('resets direct input and Enter when Voice is closed and reopened for another session',()=>{
  speechFixture();const callback=vi.fn().mockResolvedValue(undefined);
  const view=render(<VoicePanel key="first" sessionId="first" onDirectDictation={callback}/>);
  fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));fireEvent.click(screen.getByLabelText('Auto-send: press Enter'));
  view.rerender(<VoicePanel key="second" sessionId="second" onDirectDictation={callback}/>);
  expect(screen.getByLabelText('Type final result directly into terminal')).toHaveProperty('checked',false);
  expect(screen.getByLabelText('Auto-send: press Enter')).toHaveProperty('checked',false);
});

const parakeetBytes = 487170055;
function parakeetFixture(overrides: Record<string, unknown> = {}) {
  const status = {available:true, reason:'Local CPU engine', installed:false, ready:false, busy:false,
    stage:'idle', requestId:null as string|null, received:0, total:parakeetBytes, ...overrides};
  let finishInstall!:()=>void, failInstall!:(error:Error)=>void;
  let finishTranscription!:(result:{requestId:string;text:string})=>void;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === 'voice_models' || command === 'voice_model_catalog') return Promise.resolve([]) as never;
    if (command === 'voice_parakeet_status') return Promise.resolve({...status}) as never;
    if (command === 'voice_parakeet_install') {
      Object.assign(status, {busy:true, stage:'downloading', requestId:(args as {requestId:string}).requestId});
      return new Promise<void>((resolve,reject) => { finishInstall=resolve; failInstall=reject; }) as never;
    }
    if (command === 'voice_parakeet_remove') {
      Object.assign(status, {installed:false, ready:false, busy:false, stage:'idle', requestId:null});
      return Promise.resolve() as never;
    }
    if (command === 'voice_parakeet_cancel') {
      Object.assign(status, {busy:true, stage:'finishing'});
      return Promise.resolve({cancelled:true,finishing:true}) as never;
    }
    if (command === 'voice_parakeet_transcribe') {
      Object.assign(status, {busy:true,stage:'loading',requestId:(args as {requestId:string}).requestId});
      return new Promise<{requestId:string;text:string}>(resolve => { finishTranscription=resolve; }) as never;
    }
    return Promise.resolve() as never;
  });
  return {status, install:()=>finishInstall(), failInstall:()=>failInstall(new Error('Cancelled native installation')),
    complete:(requestId:string,text:string)=>finishTranscription({requestId,text})};
}
function parakeetMicrophone() {
  return installSpeechCapture().microphone;
}
async function chooseParakeet() {
  await waitFor(()=>expect(screen.getByRole('option',{name:'Parakeet · local'})).toHaveProperty('disabled',false));
  fireEvent.change(screen.getByLabelText('Speech engine'),{target:{value:'parakeet'}});
}
async function recordParakeet() {
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
  await waitFor(()=>expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='voice_parakeet_transcribe')).toBe(true));
  return vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_parakeet_transcribe').at(-1)![1] as {requestId:string;samples:number[]};
}
for (const outcome of ['success','failure'] as const) for (const replacement of ['microphone','decode'] as const) {
  it(`does not let cancelled pre-request decode ${outcome} clear a replacement awaiting ${replacement}`,async()=>{
    const fixture=parakeetFixture({installed:true});
    const {microphone, audio:sample}=installSpeechCapture();
    const audio=()=>sample;
    let finishOld!:()=>void, finishNew!:()=>void;
    const oldDecode=new Promise<ReturnType<typeof audio>>((resolve,reject)=>{finishOld=()=>outcome==='success'?resolve(audio()):reject(new Error('Cancelled old decode failed'));});
    const newDecode=new Promise<ReturnType<typeof audio>>(resolve=>{finishNew=()=>resolve(audio());});
    const decode=vi.fn().mockReturnValueOnce(oldDecode).mockReturnValueOnce(newDecode);
    vi.stubGlobal('AudioContext',class {decodeAudioData(){return decode();}async close(){}});
    render(<VoicePanel/>);await chooseParakeet();
    fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
    fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
    await waitFor(()=>expect(decode).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    await act(async()=>{});
    let grantMicrophone:undefined|(()=>void);
    if(replacement==='microphone')microphone.mockImplementationOnce(()=>new Promise(resolve=>{grantMicrophone=()=>resolve({getTracks:()=>[{stop:vi.fn()}]});}));
    fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
    if(replacement==='decode') {
      fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
      await waitFor(()=>expect(decode).toHaveBeenCalledTimes(2));
    }
    expect(screen.getByRole('button',{name:'Record speech'})).toHaveProperty('disabled',true);
    const statusReads=vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_parakeet_status').length;
    await act(async()=>finishOld());
    expect(screen.getByLabelText('Speech engine')).toHaveProperty('disabled',true);
    expect(screen.getByRole('button',{name:'Record speech'})).toHaveProperty('disabled',true);
    expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_parakeet_status')).toHaveLength(statusReads);
    expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='voice_parakeet_transcribe'||name==='voice_parakeet_cancel')).toBe(false);
    expect(screen.queryAllByRole('alert').filter(alert=>!alert.closest('[aria-label="Dictation history"]'))).toEqual([]);
    const grant=grantMicrophone;
    if(grant) {
      await act(async()=>grant());
      fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
    }
    await act(async()=>finishNew());
    await waitFor(()=>expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_parakeet_transcribe')).toHaveLength(1));
    const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='voice_parakeet_transcribe')![1] as {requestId:string};
    Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null});
    await act(async()=>fixture.complete(request.requestId,'Replacement result'));
    expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','Replacement result');
    expect(screen.getByRole('button',{name:'Record speech'})).toHaveProperty('disabled',false);
  });
}
it('retains real cancelled UUID cleanup and waits for native finishing capacity before recording again',async()=>{
  const fixture=parakeetFixture({installed:true});parakeetMicrophone();
  render(<VoicePanel/>);await chooseParakeet();vi.useFakeTimers();
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Record speech'}));});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Stop and transcribe'}));});
  const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='voice_parakeet_transcribe')![1] as {requestId:string};
  expect(request.requestId).not.toBe('');
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Cancel'}));});
  expect(invoke).toHaveBeenCalledWith('voice_parakeet_cancel',{requestId:request.requestId},expect.anything());
  await act(async()=>fixture.complete(request.requestId,'Cancelled native result'));
  expect(screen.getByRole('button',{name:'Finishing cancelled work…'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Record speech'})).toHaveProperty('disabled',true);
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('disabled',true);
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','');
  Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null});
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByRole('button',{name:'Record speech'})).toHaveProperty('disabled',false);
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('disabled',false);
});
it('keeps Whisper default and requires explicit fixed Parakeet download with bounded request-scoped progress',async()=>{
  const fixture=parakeetFixture();render(<VoicePanel/>);
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('value','whisper');
  await chooseParakeet();
  expect(screen.queryByLabelText('Language')).toBeNull();
  expect(screen.getByText(/automatic language detection/)).toBeTruthy();
  expect(screen.getByText(/487,170,055 bytes/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith('voice_parakeet_install',expect.anything(),expect.anything());
  fireEvent.click(screen.getByRole('button',{name:'Download Parakeet model'}));
  const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='voice_parakeet_install')![1] as {requestId:string;events:{onmessage:(event:unknown)=>void}};
  expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.keys(request).sort()).toEqual(['events','requestId']);
  await act(async()=>request.events.onmessage({...fixture.status,requestId:crypto.randomUUID(),received:123}));
  expect(screen.getByRole('progressbar',{name:'Parakeet model download'})).toHaveProperty('value',0);
  await act(async()=>request.events.onmessage({...fixture.status,received:123}));
  expect(screen.getByRole('progressbar',{name:'Parakeet model download'})).toHaveProperty('value',123);
  expect(screen.getByRole('button',{name:'Record speech'})).toHaveProperty('disabled',true);
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('disabled',true);
  Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null,installed:true,ready:true});
  await act(async()=>fixture.install());
  expect(screen.getByRole('button',{name:'Download Parakeet model'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Record speech'})).toHaveProperty('disabled',false);
  fireEvent.click(screen.getByRole('button',{name:'Remove Parakeet model'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Download Parakeet model'})).toHaveProperty('disabled',false));
  expect(invoke).toHaveBeenCalledWith('voice_parakeet_remove',{requestId:expect.any(String)},expect.anything());
});
it('cancels before install replies and keeps finishing controls blocked until native status releases capacity',async()=>{
  const fixture=parakeetFixture();render(<VoicePanel/>);await chooseParakeet();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button',{name:'Download Parakeet model'}));
  const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='voice_parakeet_install')![1] as {requestId:string;events:{onmessage:(event:unknown)=>void}};
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(invoke).toHaveBeenCalledWith('voice_parakeet_cancel',{requestId:request.requestId},expect.anything());
  await act(async()=>{ request.events.onmessage({...fixture.status,stage:'downloading',received:999}); fixture.failInstall(); });
  expect(screen.getByRole('status').textContent).toContain('Native work is still finishing');
  expect(screen.getByRole('button',{name:'Finishing cancelled work…'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Download Parakeet model'})).toHaveProperty('disabled',true);
  expect(screen.queryAllByRole('alert').filter(alert=>!alert.closest('[aria-label="Dictation history"]'))).toEqual([]);
  Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null});
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByRole('button',{name:'Download Parakeet model'})).toHaveProperty('disabled',false);
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='voice_parakeet_install')).toHaveLength(1);
});
it('recovers finishing native work on remount and blocks all engine controls until native idle',async()=>{
  const requestId=crypto.randomUUID();
  const fixture=parakeetFixture({installed:true,ready:true,busy:true,stage:'finishing',requestId});
  vi.useFakeTimers();
  const view=render(<VoicePanel/>);await act(async()=>{});
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('value','whisper');
  expect(screen.getByLabelText('Import model')).toHaveProperty('disabled',true);
  view.unmount();
  expect(invoke).toHaveBeenCalledWith('voice_parakeet_cancel',{requestId},expect.anything());
  render(<VoicePanel/>);await act(async()=>{});
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('disabled',true);
  Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null});
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('disabled',false);
  expect(screen.getByLabelText('Import model')).toHaveProperty('disabled',false);
});
it('transcribes the installed cold Parakeet model to an editable draft with no forced language or automatic delivery',async()=>{
  const fixture=parakeetFixture({installed:true});parakeetMicrophone();const deliver=vi.fn();
  render(<VoicePanel sessionId="ssh1" onDirectDictation={deliver}/>);await chooseParakeet();
  const request=await recordParakeet();
  expect(Object.keys(request).sort()).toEqual(['requestId','samples']);expect(request.samples).toHaveLength(1600);
  Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null,ready:true});
  await act(async()=>fixture.complete(request.requestId,'local review draft'));
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','local review draft');
  expect(deliver).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Dictation draft'),{target:{value:'edited local draft'}});
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','edited local draft');
  expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='voice_transcribe'||name==='voice_cloud_transcribe')).toBe(false);
});
for (const action of ['cancel','session','background','unmount'] as const) {
  it(`cancels exact Parakeet inference and discards late result after ${action}`,async()=>{
    const fixture=parakeetFixture({installed:true});parakeetMicrophone();const deliver=vi.fn();
    const view=render(<VoicePanel sessionId="ssh1" onDirectDictation={deliver}/>);await chooseParakeet();
    fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));
    const request=await recordParakeet();
    if(action==='cancel')fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    if(action==='session')view.rerender(<VoicePanel sessionId="ssh2" onDirectDictation={deliver}/>);
    if(action==='background'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});fireEvent(document,new Event('visibilitychange'));}
    if(action==='unmount'){view.unmount();render(<VoicePanel sessionId="ssh2" onDirectDictation={deliver}/>);}
    expect(invoke).toHaveBeenCalledWith('voice_parakeet_cancel',{requestId:request.requestId},expect.anything());
    await act(async()=>fixture.complete(request.requestId,'must never reach a terminal'));
    expect(deliver).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','');
    expect(screen.queryByRole('button',{name:'Reuse dictation 1'})).toBeNull();
  });
}
it('shows native unavailable reason and does not offer Parakeet recording or implicit installation',async()=>{
  parakeetFixture({available:false,reason:'Parakeet CPU is unavailable on this platform.'});render(<VoicePanel/>);
  expect(await screen.findByText('Parakeet: Parakeet CPU is unavailable on this platform.')).toBeTruthy();
  expect(screen.getByRole('option',{name:'Parakeet · local — unavailable'})).toHaveProperty('disabled',true);
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('value','whisper');
  expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='voice_parakeet_install'||name==='voice_parakeet_transcribe')).toBe(false);
});
it('rejects a mismatched native result without changing the draft or falling back',async()=>{
  const fixture=parakeetFixture({installed:true});parakeetMicrophone();const deliver=vi.fn();
  render(<VoicePanel sessionId="ssh1" onDirectDictation={deliver}/>);await chooseParakeet();
  fireEvent.change(screen.getByLabelText('Dictation draft'),{target:{value:'keep my edit'}});
  await recordParakeet();
  Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null});
  await act(async()=>fixture.complete(crypto.randomUUID(),'wrong request result'));
  expect(await screen.findByText('Invalid Parakeet transcription result.')).toBeTruthy();
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','keep my edit');
  expect(deliver).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='voice_transcribe'||name==='voice_cloud_transcribe')).toBe(false);
});
it('waits for shared local capacity without cancelling an operation whose UUID is unknown',async()=>{
  const fixture=parakeetFixture({busy:true});vi.useFakeTimers();
  render(<VoicePanel/>);await act(async()=>{});
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('disabled',true);
  expect(screen.getByLabelText('Import model')).toHaveProperty('disabled',true);
  expect(screen.queryByRole('button',{name:'Cancel'})).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('local speech engine is busy');
  fixture.status.busy=false;
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByLabelText('Import model')).toHaveProperty('disabled',false);
  expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='voice_parakeet_cancel')).toBe(false);
});
function changeVoiceAccess(locked: boolean) {
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'',
    generation:String(BigInt(accessSnapshot().status?.generation ?? '0')+1n),
    ...(locked ? {} : {nonce:'a'.repeat(64)})});
}
for (const operation of ['install','transcribe'] as const) {
  it(`does not publish revoked ${operation} errors or completion on the same old mount after lock and unlock`,async()=>{
    const fixture=parakeetFixture({installed:operation==='transcribe'});parakeetMicrophone();const deliver=vi.fn();
    const view=render(<VoicePanel sessionId="ssh1" onDirectDictation={deliver}/>);await chooseParakeet();
    let requestId='';
    if(operation==='install')fireEvent.click(screen.getByRole('button',{name:'Download Parakeet model'}));
    else requestId=(await recordParakeet()).requestId;
    await act(async()=>changeVoiceAccess(true));
    await act(async()=>changeVoiceAccess(false));
    const calls=vi.mocked(invoke).mock.calls.length;
    await act(async()=>{if(operation==='install')fixture.failInstall();else fixture.complete(requestId,'revoked private text');});
    expect(screen.queryAllByRole('alert').filter(alert=>!alert.closest('[aria-label="Dictation history"]'))).toEqual([]);
    expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','');
    expect(deliver).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(calls);
    view.unmount();
    Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null});
    render(<VoicePanel/>);await chooseParakeet();
    expect(screen.getByLabelText('Speech engine')).toHaveProperty('disabled',false);
  });
}
it.each(['success','failure'])('does not let an older cancel status %s overwrite the newer final idle status',async outcome=>{
  const fixture=parakeetFixture();const implementation=vi.mocked(invoke).getMockImplementation()!;
  let holdStatus=false, finishStatus!:()=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='voice_parakeet_status' && holdStatus){
      holdStatus=false;const stale={...fixture.status};
      return new Promise((resolve,reject)=>{finishStatus=()=>outcome==='success'?resolve(stale):reject(new Error('Old status failure'));}) as never;
    }
    return implementation(command,args,options);
  });
  render(<VoicePanel/>);await chooseParakeet();vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button',{name:'Download Parakeet model'}));
  holdStatus=true;
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  await act(async()=>{});
  Object.assign(fixture.status,{busy:false,stage:'idle',requestId:null});
  await act(async()=>fixture.failInstall());
  expect(screen.getByRole('button',{name:'Download Parakeet model'})).toHaveProperty('disabled',false);
  await act(async()=>finishStatus());
  expect(screen.getByRole('button',{name:'Download Parakeet model'})).toHaveProperty('disabled',false);
  expect(screen.queryByText(/Native work is still finishing/)).toBeNull();
  expect(screen.queryAllByRole('alert').filter(alert=>!alert.closest('[aria-label="Dictation history"]'))).toEqual([]);
});
