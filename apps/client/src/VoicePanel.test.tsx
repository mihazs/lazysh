// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import VoicePanel from './VoicePanel';

vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(), Channel:class {onmessage:((event:unknown)=>void)|undefined;} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

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
  expect(invoke).not.toHaveBeenCalledWith('voice_transcribe',expect.anything());
});

it('stages an edited draft only on explicit request and never sends terminal input', async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  const listener = vi.fn(); window.addEventListener('lazysh-prompt-draft',listener);
  render(<VoicePanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText('Dictation draft'),{target:{value:'review this code'}});
  expect(listener).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Stage in terminal composer'}));
  expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'ssh1',text:'review this code'});
  expect(vi.mocked(invoke).mock.calls.every(([name]) => name === 'voice_models' || name === 'apple_speech_capability' || name==='voice_model_catalog')).toBe(true);
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
  expect(invoke).not.toHaveBeenCalledWith('voice_download_model',expect.anything());
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
  expect(invoke).not.toHaveBeenCalledWith('voice_transcribe',expect.anything());
});
it('waits for cancellation cleanup and ignores stale download progress without installing',async()=>{
  const fixture=downloadFixture();render(<VoicePanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Download selected model'}));
  const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='voice_download_model')![1] as DownloadCall;
  fireEvent.click(screen.getByRole('button',{name:'Cancel download'}));
  expect(invoke).toHaveBeenCalledWith('voice_download_cancel',{requestId:request.requestId});
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
  expect(invoke).toHaveBeenCalledWith('voice_download_cancel',{requestId:request.requestId});
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
  expect(invoke).not.toHaveBeenCalledWith('voice_download_model',expect.anything());
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
  expect(invoke).not.toHaveBeenCalledWith('apple_speech_install',expect.anything());
  fireEvent.click(screen.getByRole('button',{name:'Download Apple speech language'}));
  const request=vi.mocked(invoke).mock.calls.find(([name])=>name==='apple_speech_install')?.[1];
  expect(request).toEqual({language:'en-US',requestId:expect.stringMatching(/^[0-9a-f-]{36}$/)});
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(invoke).toHaveBeenCalledWith('apple_speech_cancel',{requestId:(request as {requestId:string}).requestId});
  complete?.();
  await waitFor(()=>expect(screen.queryByText('Downloading Apple speech assets…')).toBeNull());
  expect(invoke).not.toHaveBeenCalledWith('apple_speech_transcribe',expect.anything());
});
it('preserves current-view dictation and cannot refill cleared history from late inference',async()=>{
  let complete!:(text:string)=>void;
  vi.mocked(invoke).mockImplementation(command=>{
    if(command==='voice_models')return Promise.resolve([{id:'tiny.bin',bytes:1024}]) as never;
    if(command==='voice_model_catalog')return Promise.resolve([]) as never;
    if(command==='voice_transcribe')return new Promise<string>(resolve=>{complete=resolve;}) as never;
    return Promise.resolve() as never;
  });
  class Capture {
    state='inactive';mimeType='audio/webm';onstop:(()=>void)|undefined;
    start(){this.state='recording';}stop(){this.state='inactive';this.onstop?.();}
  }
  vi.stubGlobal('MediaRecorder',Capture);
  vi.stubGlobal('Blob',class {async arrayBuffer(){return new ArrayBuffer(0);}});
  vi.stubGlobal('AudioContext',class {
    async decodeAudioData(){return {sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(1600)};}
    async close(){}
  });
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop:vi.fn()}]})}});
  const stage=vi.fn();window.addEventListener('lazysh-prompt-draft',stage);
  const view=render(<VoicePanel sessionId="ssh1"/>);
  await waitFor(()=>expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('tiny.bin'));
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('voice_transcribe',expect.anything()));
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
