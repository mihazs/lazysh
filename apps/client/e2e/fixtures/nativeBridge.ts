import type { Page } from '@playwright/test';
declare global { interface Window {
  nativeFixtureInvoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
} }
/** Shared synthetic native admission; each spec retains its own command behavior. */
export async function installNativeBridge(page: Page, access = {reason:'Browser fixture', generation:'0'}) {
  await page.addInitScript(access => {
    Object.defineProperty(window, 'isTauri', {value:true});
    Object.defineProperty(window, '__TAURI_INTERNALS__', {value: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'app_lock_status') return {initialized:true,supported:false,enabled:false,locked:false,...access};
        if (command === 'app_lock_ready' || command === 'adopt_session') return;
        if (command === 'desktop_launch_read') return {directoryReceipt:null,notice:null};
        return window.nativeFixtureInvoke(command, args);
      },
    }});
  }, access);
}
/** Synthetic final audio only: never asks the host browser for a microphone. */
export async function installSyntheticAudio(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
    Object.defineProperty(window,'MediaRecorder',{value:class {
      state='inactive';mimeType='audio/webm';onstop?:()=>void;ondataavailable?:(event:{data:Blob})=>void;
      start(){this.state='recording';}
      stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array([0])])});this.onstop?.();}
    }});
    Object.defineProperty(window,'AudioContext',{value:class {
      async decodeAudioData(){return {sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(1600)};}
      async close(){}
    }});
  });
}
