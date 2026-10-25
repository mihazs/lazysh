// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import VoicePanel from './VoicePanel';
import { validateCloudSnapshot, type CloudSnapshot } from './cloudVoice';

vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
const id = '12345678-1234-4234-8234-123456789abc';
function snapshot(): CloudSnapshot {
  return { origin: 'https://voice.example.com', checkedAt: 1792900000000,
    capabilities: {schemaVersion:1, model:'gpt-transcribe', languages:['auto','pt'],maxWavBytes:960044,sampleRate:16000,maxSamples:480000},
    quota: {windowStart:1792800000,windowEnd:1792886400,deviceLimitSamples:480000,deviceUsedSamples:0,deviceRemainingSamples:480000,
      globalLimitSamples:960000,globalUsedSamples:0,globalRemainingSamples:960000} };
}
function deferred<T>() {
  let resolve!: (value:T) => void; let reject!: (reason:Error) => void;
  const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function fixture(options: {begin?:Promise<string>;decode?:Promise<unknown>;value?:CloudSnapshot;configured?:boolean} = {}) {
  const result = deferred<unknown>(); const value = options.value ?? snapshot();
  vi.mocked(invoke).mockImplementation(command => {
    if(command==='voice_models' || command==='voice_model_catalog')return Promise.resolve([]) as never;
    if(command==='voice_cloud_status')return Promise.resolve({configured:options.configured ?? true,origin:value.origin}) as never;
    if(command==='voice_cloud_refresh' || command==='voice_cloud_enroll')return Promise.resolve(value) as never;
    if(command==='voice_cloud_begin')return (options.begin ?? Promise.resolve(id)) as never;
    if(command==='voice_cloud_transcribe')return result.promise as never;
    if(command==='voice_cloud_cancel')return Promise.resolve({cancelled:true,cleanup:'confirmed'}) as never;
    return Promise.resolve() as never;
  });
  const captures: Capture[]=[];
  class Capture {
    constructor(){captures.push(this);}
    onerror:(()=>void)|undefined; ondataavailable:((event:{data:Blob})=>void)|undefined;
    state='inactive';mimeType='audio/webm';onstop:(()=>void)|undefined;
    start(){this.state='recording';} stop(){this.state='inactive';this.onstop?.();}
  }
  vi.stubGlobal('MediaRecorder',Capture);
  vi.stubGlobal('Blob',class { async arrayBuffer(){return new ArrayBuffer(0);} });
  const audio = {sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(1600)};
  vi.stubGlobal('AudioContext',class { async decodeAudioData(){return options.decode ? await options.decode : audio;} async close(){} });
  const stop = vi.fn();
  const microphone = vi.fn().mockResolvedValue({getTracks:()=>[{stop}]});
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:microphone}});
  return {value,result,microphone,stop,audio,captures,complete:async(text='hello',requestId=id)=>act(async()=>result.resolve({requestId,text,quota:value.quota,checkedAt:value.checkedAt+1000}))};
}
async function selectCloud() {
  fireEvent.change(screen.getByLabelText('Speech engine'),{target:{value:'cloud'}});
  await waitFor(()=>expect((screen.getByRole('button',{name:'Refresh Cloud service'}) as HTMLButtonElement).disabled).toBe(false));
}
async function record() {
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('voice_cloud_transcribe',expect.anything()));
}
it('keeps default local without Cloud IPC and verifies metadata only when Cloud is selected',async()=>{
  fixture();render(<VoicePanel sessionId="one"/>);
  expect(screen.getByLabelText('Speech engine')).toHaveProperty('value','whisper');
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command.startsWith('voice_cloud_'))).toBe(false);
  await selectCloud();
  expect(screen.getByLabelText('Cloud speech language')).toHaveProperty('value','auto');
  expect(Array.from((screen.getByLabelText('Cloud speech language') as HTMLSelectElement).options).map(option=>option.value)).toEqual(['auto','pt']);
  expect(screen.getByText(/Service audio quota remaining/).textContent).toContain('device 30.0 seconds; shared 60.0 seconds');
  expect(invoke).not.toHaveBeenCalledWith('voice_cloud_begin',expect.anything());
});
it('sends decoded mono PCM using the reserved ID, independent Cloud language, and review by default',async()=>{
  const f=fixture(); const direct=vi.fn();render(<VoicePanel sessionId="one" onDirectDictation={direct}/>);await selectCloud();
  fireEvent.change(screen.getByLabelText('Cloud speech language'),{target:{value:'pt'}});
  await record();
  expect(invoke).toHaveBeenCalledWith('voice_cloud_begin',{sessionId:'one'});
  expect(invoke).toHaveBeenCalledWith('voice_cloud_transcribe',{requestId:id,sessionId:'one',samples:Array(1600).fill(0),language:'pt'});
  await f.complete('Cloud draft');
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','Cloud draft');
  expect(direct).not.toHaveBeenCalled();expect(localStorage.length).toBe(0);
  expect(screen.getByRole('button',{name:'Reuse dictation 1'})).toBeTruthy();
});
for (const action of ['cancel','unmount','session','hide'] as const) {
  it(`cancels a late begin after ${action} without opening the microphone`,async()=>{
    const begin=deferred<string>();const f=fixture({begin:begin.promise});
    const view=render(<VoicePanel sessionId="one"/>);await selectCloud();
    fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
    expect(f.microphone).not.toHaveBeenCalled();
    if(action==='cancel')fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    if(action==='unmount')view.unmount();
    if(action==='session')view.rerender(<VoicePanel sessionId="two"/>);
    if(action==='hide')fireEvent(window,new Event('pagehide'));
    await act(async()=>begin.resolve(id));
    expect(invoke).toHaveBeenCalledWith('voice_cloud_cancel',{requestId:id});
    expect(f.microphone).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('voice_cloud_transcribe',expect.anything());
  });
}
for (const action of ['cancel','unmount','session','hide'] as const) {
  it(`ignores a late Cloud result after ${action} including direct+Enter`,async()=>{
    const f=fixture();const direct=vi.fn();const view=render(<VoicePanel sessionId="one" onDirectDictation={direct}/>);await selectCloud();
    fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));
    fireEvent.click(screen.getByLabelText('Auto-send: press Enter'));
    await record();
    if(action==='cancel')fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    if(action==='unmount')view.unmount();
    if(action==='session')view.rerender(<VoicePanel sessionId="two" onDirectDictation={direct}/>);
    if(action==='hide')fireEvent(window,new Event('pagehide'));
    await f.complete('stale command');
    expect(invoke).toHaveBeenCalledWith('voice_cloud_cancel',{requestId:id});
    expect(direct).not.toHaveBeenCalled();
    if(action!=='unmount')expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','');
  });
}
it('cancels the reservation when cancellation beats PCM decoding',async()=>{
  const decode=deferred<unknown>();const f=fixture({decode:decode.promise});render(<VoicePanel/>);await selectCloud();
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stop and transcribe'}));
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  await act(async()=>decode.resolve(f.audio));
  expect(invoke).toHaveBeenCalledWith('voice_cloud_cancel',{requestId:id});
  expect(invoke).not.toHaveBeenCalledWith('voice_cloud_transcribe',expect.anything());
});
it('releases a late microphone grant and cancels its reservation',async()=>{
  const f=fixture();const media=deferred<unknown>();f.microphone.mockReturnValue(media.promise);
  render(<VoicePanel/>);await selectCloud();fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  await waitFor(()=>expect(f.microphone).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  await act(async()=>media.resolve({getTracks:()=>[{stop:f.stop}]}));
  expect(f.stop).toHaveBeenCalledOnce();expect(invoke).toHaveBeenCalledWith('voice_cloud_cancel',{requestId:id});
  expect(screen.queryByRole('button',{name:'Stop and transcribe'})).toBeNull();
});
it('does not cancel on window blur from a permission dialog',async()=>{
  const f=fixture();render(<VoicePanel/>);await selectCloud();
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));await screen.findByRole('button',{name:'Stop and transcribe'});
  fireEvent(window,new Event('blur'));
  expect(invoke).not.toHaveBeenCalledWith('voice_cloud_cancel',expect.anything());expect(f.stop).not.toHaveBeenCalled();
});
it('keeps direct delivery opt-in and protects a deferred claim after cancellation',async()=>{
  const f=fixture();const claim=deferred<void>();const requests: {claim:()=>boolean;autoSend:boolean}[]=[];
  const direct=vi.fn(async request=>{requests.push(request);await claim.promise;});
  render(<VoicePanel sessionId="one" onDirectDictation={direct}/>);await selectCloud();
  expect(screen.getByLabelText('Type final result directly into terminal')).toHaveProperty('checked',false);
  expect(screen.getByLabelText('Auto-send: press Enter')).toHaveProperty('checked',false);
  fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));
  fireEvent.click(screen.getByLabelText('Auto-send: press Enter'));
  await record();await f.complete('echo hello');
  expect(requests[0].autoSend).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(requests[0].claim()).toBe(false);await act(async()=>claim.resolve());
});
it('updates the current draft but cannot refill history cleared during Cloud inference',async()=>{
  const f=fixture();render(<VoicePanel/>);await selectCloud();await record();
  fireEvent.click(screen.getByRole('button',{name:'Clear history'}));await f.complete('after clear');
  expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','after clear');
  expect(screen.queryByRole('button',{name:'Reuse dictation 1'})).toBeNull();
});
for (const invalid of ['wrong-id','utf8-size','quota'] as const) {
  it(`rejects a ${invalid} result without history or direct delivery`,async()=>{
    const f=fixture();const direct=vi.fn();render(<VoicePanel sessionId="one" onDirectDictation={direct}/>);await selectCloud();
    fireEvent.click(screen.getByLabelText('Type final result directly into terminal'));await record();
    await act(async()=>f.result.resolve({requestId:invalid==='wrong-id'?'another':id,text:invalid==='utf8-size'?'界'.repeat(6000):'hi',
      quota:invalid==='quota'?{}:f.value.quota,checkedAt:f.value.checkedAt}));
    expect(await screen.findByText(invalid==='quota'?'Invalid Cloud service quota response.':'Invalid Cloud transcription result.')).toBeTruthy();
    expect(screen.getByLabelText('Dictation draft')).toHaveProperty('value','');expect(direct).not.toHaveBeenCalled();
  });
}
it('does not fall back to local after service failure and reports unconfirmed cleanup',async()=>{
  const f=fixture();vi.mocked(invoke).mockImplementationOnce(()=>Promise.resolve([]) as never);
  render(<VoicePanel/>);await selectCloud();await record();
  vi.mocked(invoke).mockImplementation(command=>command==='voice_cloud_cancel'?Promise.resolve({cancelled:true,cleanup:'unconfirmed'}) as never:Promise.resolve() as never);
  await act(async()=>f.result.reject(new Error('Cloud provider denied request')));
  expect(await screen.findByText(/cleanup could not be confirmed/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith('voice_transcribe',expect.anything());
});
it('requires a verified snapshot and both quota balances to record',async()=>{
  const value=snapshot();value.quota.globalLimitSamples=1000;value.quota.globalRemainingSamples=1000;
  fixture({value});render(<VoicePanel/>);await selectCloud();
  expect((screen.getByRole('button',{name:'Record speech'}) as HTMLButtonElement).disabled).toBe(true);
});
it('requires a new explicit token on origin change and clears tokens after failed verification',async()=>{
  fixture();render(<VoicePanel/>);await selectCloud();
  fireEvent.change(screen.getByLabelText('Device token'),{target:{value:'a'.repeat(64)}});
  fireEvent.change(screen.getByLabelText('Cloud service origin'),{target:{value:'https://new.example.com'}});
  expect(screen.getByLabelText('Device token')).toHaveProperty('value','');
  expect((screen.getByRole('button',{name:'Refresh Cloud service'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:'Record speech'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Device token'),{target:{value:'b'.repeat(64)}});
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Cloud service denied device'));
  fireEvent.click(screen.getByRole('button',{name:'Verify and save Cloud device'}));
  expect(await screen.findByText('Cloud service denied device')).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith('voice_cloud_enroll',{origin:'https://new.example.com',token:'b'.repeat(64)});
  expect(screen.getByLabelText('Device token')).toHaveProperty('value','');
});
it('forgets configured credentials and disables recording until verified enrollment',async()=>{
  fixture();render(<VoicePanel/>);await selectCloud();
  fireEvent.click(screen.getByRole('button',{name:'Forget Cloud device'}));
  await waitFor(()=>expect(screen.getByLabelText('Cloud service origin')).toHaveProperty('value',''));
  expect(invoke).toHaveBeenCalledWith('voice_cloud_forget');
  expect((screen.getByRole('button',{name:'Record speech'}) as HTMLButtonElement).disabled).toBe(true);
});
it('accepts lowered limits with saturated balances and global limits below device limits',()=>{
  const value=snapshot();value.quota.deviceUsedSamples=500000;value.quota.deviceRemainingSamples=0;
  value.quota.globalLimitSamples=1000;value.quota.globalUsedSamples=2000;value.quota.globalRemainingSamples=0;
  expect(validateCloudSnapshot(value)).toBe(value);
  value.capabilities.languages=['unknown'];expect(()=>validateCloudSnapshot(value)).toThrow('capabilities');
});

it('ignores stale recorder errors and oversized chunks after a new recording starts',async()=>{
  const f=fixture();render(<VoicePanel/>);await selectCloud();
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));await screen.findByRole('button',{name:'Stop and transcribe'});
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));await screen.findByRole('button',{name:'Stop and transcribe'});
  act(()=>{f.captures[0].onerror?.();f.captures[0].ondataavailable?.({data:{size:9*1024*1024} as Blob});});
  expect(screen.getByRole('button',{name:'Stop and transcribe'})).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='voice_cloud_cancel')).toHaveLength(1);
});
it('rejects metadata for a different origin and keeps recording disabled',async()=>{
  fixture();const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,...args)=>command==='voice_cloud_refresh'
    ? Promise.resolve({...snapshot(),origin:'https://other.example.com'}) as never : original(command,...args));
  render(<VoicePanel/>);await selectCloud();
  expect(await screen.findByText('Cloud service origin did not match the configured device.')).toBeTruthy();
  expect((screen.getByRole('button',{name:'Record speech'}) as HTMLButtonElement).disabled).toBe(true);
});

it('does not stop a new microphone when an earlier cancelled begin rejects late',async()=>{
  const begin=deferred<string>();const f=fixture();const original=vi.mocked(invoke).getMockImplementation()!;let starts=0;
  vi.mocked(invoke).mockImplementation((command,...args)=>command==='voice_cloud_begin' && starts++===0
    ? begin.promise as never : original(command,...args));
  render(<VoicePanel/>);await selectCloud();
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  fireEvent.click(screen.getByRole('button',{name:'Record speech'}));await screen.findByRole('button',{name:'Stop and transcribe'});
  await act(async()=>begin.reject(new Error('Earlier reservation cancelled')));
  expect(f.stop).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Stop and transcribe'})).toBeTruthy();
  expect(screen.queryByText('Earlier reservation cancelled')).toBeNull();
});

for (const event of ['hidden','pagehide'] as const) {
  function hideCloudSettings() {
    if (event === 'hidden') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      fireEvent(document, new Event('visibilitychange'));
    } else fireEvent(window, new Event('pagehide'));
  }
  it(`clears an unsubmitted Cloud token on ${event} without enrolling or forgetting credentials`,async()=>{
    fixture();render(<VoicePanel/>);await selectCloud();
    fireEvent.change(screen.getByLabelText('Device token'),{target:{value:'a'.repeat(64)}});
    expect(screen.getByLabelText('Device token')).toHaveProperty('value','a'.repeat(64));
    hideCloudSettings();
    expect(screen.getByLabelText('Device token')).toHaveProperty('value','');
    expect(invoke).not.toHaveBeenCalledWith('voice_cloud_enroll',expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('voice_cloud_forget');
    expect((screen.getByRole('button',{name:'Record speech'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it(`does not refill a cleared token when submitted enrollment finishes after ${event}`,async()=>{
    const f=fixture();const enrollment=deferred<CloudSnapshot>();
    const original=vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation((command,...args)=>command==='voice_cloud_enroll' ? enrollment.promise as never : original(command,...args));
    render(<VoicePanel/>);await selectCloud();
    fireEvent.change(screen.getByLabelText('Device token'),{target:{value:'b'.repeat(64)}});
    fireEvent.click(screen.getByRole('button',{name:'Verify and save Cloud device'}));
    expect(invoke).toHaveBeenCalledWith('voice_cloud_enroll',{origin:f.value.origin,token:'b'.repeat(64)});
    hideCloudSettings();
    expect(screen.getByLabelText('Device token')).toHaveProperty('value','');
    expect(invoke).not.toHaveBeenCalledWith('voice_cloud_forget');
    await act(async()=>enrollment.resolve(f.value));
    expect(screen.getByLabelText('Device token')).toHaveProperty('value','');
    expect(screen.getByText(/Service audio quota remaining/)).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='voice_cloud_enroll')).toHaveLength(1);
  });
}

it('shows service quota totals and the exact UTC window when lowered limits leave used above total',async()=>{
  const value=snapshot();value.quota.deviceUsedSamples=500000;value.quota.deviceRemainingSamples=0;
  value.quota.globalLimitSamples=16000;value.quota.globalUsedSamples=32000;value.quota.globalRemainingSamples=0;
  fixture({value});render(<VoicePanel/>);await selectCloud();
  expect(screen.getByText(/Service audio quota remaining/).textContent).toBe('Service audio quota remaining: device 0.0 seconds; shared 0.0 seconds.');
  expect(screen.getByText(/Service audio quota totals/).textContent).toBe('Service audio quota totals: device 30.0 seconds; shared 1.0 seconds.');
  expect(screen.getByText(/Quota window/).textContent).toBe(`Quota window (UTC): ${new Date(value.quota.windowStart*1000).toISOString()} – ${new Date(value.quota.windowEnd*1000).toISOString()}`);
  expect((screen.getByRole('button',{name:'Record speech'}) as HTMLButtonElement).disabled).toBe(true);
  value.quota.windowEnd=Number.MAX_SAFE_INTEGER;
  expect(()=>validateCloudSnapshot(value)).toThrow('Invalid Cloud service quota response.');
});
