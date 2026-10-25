// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import VoicePanel from './VoicePanel';
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('requires a local model and explicit recording and handles microphone denial', async () => {
  vi.mocked(invoke).mockResolvedValue([{id:'ggml-tiny.en.bin',bytes:75*1024*1024}]);
  const getUserMedia = vi.fn().mockRejectedValue(new Error('Microphone permission denied'));
  vi.stubGlobal('MediaRecorder',class {});
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}});
  render(<VoicePanel sessionId="ssh1" />);
  await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('ggml-tiny.en.bin'));
  expect(getUserMedia).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Microphone permission denied');
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
  expect(vi.mocked(invoke).mock.calls.every(([name]) => name === 'voice_models' || name === 'apple_speech_capability')).toBe(true);
  window.removeEventListener('lazysh-prompt-draft',listener);
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
