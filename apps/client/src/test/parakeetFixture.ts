import {vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
export const parakeetBytes = 487170055;
export function parakeetFixture(overrides: Record<string, unknown> = {}) {
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
