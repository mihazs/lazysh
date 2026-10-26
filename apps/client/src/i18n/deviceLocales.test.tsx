// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import DevicePanel from '../DevicePanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {deviceFrame,deviceRecord,deviceInventory,androidVideoProbe,iosDeviceRecord,iosDeviceProbe} from '../test/deviceData';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic device locale fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'e'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  vi.mocked(invoke).mockImplementation(async command=>command==='list_devices'?deviceInventory:command==='device_frame'?deviceFrame:command==='android_device_probe'?androidVideoProbe:undefined);
});
afterEach(async()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllGlobals();await uiI18n.changeLanguage('en');});
async function readDevice(){
  fireEvent.click(screen.getByRole('button',{name:t('devicesFind')}));
  await screen.findByRole('option',{name:`${deviceRecord.name} · ${deviceRecord.state}`});
  fireEvent.change(screen.getByLabelText(t('devicesDevice')),{target:{value:deviceFrame.id}});
}
async function startVideo(){
  fireEvent.click(screen.getByRole('button',{name:t('devicesVerifyAndroid')}));
  await waitFor(()=>expect(screen.getByRole('button',{name:t('devicesStartVideo')})).toHaveProperty('disabled',false));
  fireEvent.click(screen.getByRole('button',{name:t('devicesStartVideo')}));
}
async function cycleDeviceUi(assertView:()=>void){
  const requests=vi.mocked(invoke).mock.calls.slice();
  for(const language of ['es','pt-BR','en']){
    await act(async()=>{await uiI18n.changeLanguage(language);});assertView();
    expect(vi.mocked(invoke).mock.calls).toEqual(requests);
  }
}
function pointerSurface(image:HTMLElement,width:number,height:number){
  vi.stubGlobal('PointerEvent',MouseEvent);
  Object.defineProperties(image,{getBoundingClientRect:{value:()=>({left:10,top:20,width,height})},setPointerCapture:{value:vi.fn()}});
}
it('preserves the frame and exact coordinates/key/confirmation targets while only captions change',async()=>{
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
  render(<DevicePanel sessionId="device-host"/>);
  await cycleDeviceUi(()=>expect(screen.getByRole('button',{name:t('devicesFind')})).toBeTruthy());expect(invoke).not.toHaveBeenCalled();
  await readDevice();fireEvent.click(screen.getByRole('button',{name:t('devicesCapture')}));const image=await screen.findByRole('img');
  pointerSurface(image,270,480);
  await cycleDeviceUi(()=>{expect(screen.getByRole('img')).toBe(image);expect(image.getAttribute('src')).toBe(`data:image/jpeg;base64,${deviceFrame.base64}`);expect(image.getAttribute('alt')).toBe(t('devicesScreen',{name:deviceRecord.name}));expect(screen.getByText(deviceInventory.warnings[0])).toBeTruthy();expect(screen.getByRole('button',{name:t('devicesHome')})).toHaveProperty('disabled',true);});
  fireEvent.pointerDown(image,{clientX:145,clientY:260});fireEvent.pointerUp(image,{clientX:145,clientY:260});expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='device_action')).toBe(false);
  fireEvent.click(screen.getByLabelText(t('devicesEnableInput')));
  await cycleDeviceUi(()=>expect(screen.getByLabelText(t('devicesEnableInput'))).toHaveProperty('checked',true));
  fireEvent.pointerDown(image,{clientX:145,clientY:260});fireEvent.pointerUp(image,{clientX:145,clientY:260});
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('device_action',{sessionId:'device-host',devicePlatform:'android',id:deviceFrame.id,action:{type:'tap',x:540,y:960}},{headers:{'X-Lazysh-Access':'e'.repeat(64)}}));
  await waitFor(()=>expect(screen.getByRole('button',{name:t('devicesHome')})).toHaveProperty('disabled',false));fireEvent.click(screen.getByRole('button',{name:t('devicesHome')}));
  await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('device_action',{sessionId:'device-host',devicePlatform:'android',id:deviceFrame.id,action:{type:'key',key:'home'}},expect.anything()));
  await waitFor(()=>expect(screen.getByRole('button',{name:t('devicesReboot')})).toHaveProperty('disabled',false));const before=vi.mocked(invoke).mock.calls.length;
  for(const language of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(language);});fireEvent.click(screen.getByRole('button',{name:t('devicesReboot')}));expect(confirm).toHaveBeenLastCalledWith(t('devicesConfirmReboot',{name:deviceRecord.name}));expect(vi.mocked(invoke).mock.calls).toHaveLength(before);}
  confirm.mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:t('devicesShutdown')}));await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('device_action',{sessionId:'device-host',devicePlatform:'android',id:deviceFrame.id,action:{type:'shutdown'}},expect.anything()));
});
it.each([
  {name:'sequence',packet:{sequence:1,frame:deviceFrame},key:'devicesInvalidSequence'},
  {name:'idle',packet:{sequence:2,idle:true},key:'devicesInvalidIdle'},
  {name:'identity',packet:{sequence:2,frame:{...deviceFrame,id:'other-device'}},key:'devicesStreamIdentity'},
] as const)('keeps pending startup and one pull on their original lease, and retranslates a retained $name failure without restarting',async scenario=>{
  let begin!:(id:string)=>void,next!:(value:unknown)=>void;
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,...args)=>command==='device_stream_start'?new Promise(resolve=>{begin=resolve as typeof begin;}):command==='device_stream_next'?new Promise(resolve=>{next=resolve;}):fallback(command,...args));
  render(<DevicePanel sessionId="stream-host"/>);await readDevice();await startVideo();
  await waitFor(()=>expect(begin).toBeTypeOf('function'));await cycleDeviceUi(()=>expect(screen.getByLabelText(t('devicesEnableInput'))).toHaveProperty('disabled',true));
  await act(async()=>{begin('original-stream');});await waitFor(()=>expect(next).toBeTypeOf('function'));
  expect(invoke).toHaveBeenLastCalledWith('device_stream_next',{sessionId:'stream-host',streamId:'original-stream',after:0},{headers:{'X-Lazysh-Access':'e'.repeat(64)}});
  await cycleDeviceUi(()=>expect(screen.getByRole('button',{name:t('devicesStopVideo')})).toBeTruthy());
  await act(async()=>{next({sequence:1,frame:deviceFrame});});const image=screen.getByRole('img');await cycleDeviceUi(()=>expect(screen.getByRole('img')).toBe(image));
  await act(async()=>{next(scenario.packet);});await screen.findByRole('alert');await cycleDeviceUi(()=>expect(screen.getByRole('alert').textContent).toBe(t(scenario.key)));
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='device_stream_start')).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith('device_stream_stop',{sessionId:'stream-host',streamId:'original-stream'},{headers:{'X-Lazysh-Access':'e'.repeat(64)}});
});
it('closes a late original startup after replacing the session without publishing or pulling into the new view',async()=>{
  let finish!:(id:string)=>void;const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,...args)=>command==='device_stream_start'?new Promise(resolve=>{finish=resolve as typeof finish;}):original(command,...args));
  // App keys this panel by native session identity; retain that ownership boundary.
  const view=render(<DevicePanel key="retired-device-host" sessionId="retired-device-host"/>);await readDevice();await startVideo();await waitFor(()=>expect(finish).toBeTypeOf('function'));
  view.rerender(<DevicePanel key="replacement-device-host" sessionId="replacement-device-host"/>);await cycleDeviceUi(()=>{expect(screen.queryByRole('img')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();});
  await act(async()=>{finish('late-original-stream');});
  expect(invoke).toHaveBeenLastCalledWith('device_stream_stop',{sessionId:'retired-device-host',streamId:'late-original-stream'},{headers:{'X-Lazysh-Access':'e'.repeat(64)}});
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='device_stream_next')).toBe(false);expect(screen.queryByRole('alert')).toBeNull();
});
it('retains the original screenshot interval through locale changes and clears it only on explicit stop',async()=>{
  render(<DevicePanel sessionId="capture-clock"/>);await readDevice();vi.useFakeTimers();
  const timer=vi.spyOn(globalThis,'setInterval');const clear=vi.spyOn(globalThis,'clearInterval');
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:t('devicesStartLive')}));});
  expect(timer).toHaveBeenCalledExactlyOnceWith(expect.any(Function),1000);await cycleDeviceUi(()=>expect(screen.getByRole('button',{name:t('devicesStopLive')})).toBeTruthy());
  expect(clear).not.toHaveBeenCalled();await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='device_frame')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:t('devicesStopLive')}));expect(clear).toHaveBeenCalledOnce();
});
it('preserves the iOS socket draft/focus and uses verified point dimensions with literal key values',async()=>{
  const ios=iosDeviceRecord;
  vi.mocked(invoke).mockImplementation(async command=>command==='list_devices'?{schemaVersion:1,devices:[ios],avds:[]}:command==='ios_device_probe'?iosDeviceProbe:command==='device_frame'?{...deviceFrame,id:ios.id,platform:'ios',width:1170,height:2532,imageWidth:390,imageHeight:844}:undefined);
  render(<DevicePanel sessionId="ios-host"/>);fireEvent.change(screen.getByLabelText(t('devicesPlatform')),{target:{value:'ios'}});fireEvent.click(screen.getByRole('button',{name:t('devicesFind')}));await screen.findByRole('option',{name:`${ios.name} · running`});fireEvent.change(screen.getByLabelText(t('devicesDevice')),{target:{value:ios.id}});
  const socket=screen.getByLabelText(t('devicesSocket'));fireEvent.change(socket,{target:{value:'/private/raw {{socket}}.sock'}});socket.focus();
  await cycleDeviceUi(()=>{expect(screen.getByLabelText(t('devicesSocket'))).toBe(socket);expect(document.activeElement).toBe(socket);expect(socket).toHaveProperty('value','/private/raw {{socket}}.sock');});
  fireEvent.click(screen.getByRole('button',{name:t('devicesVerifyIos')}));await waitFor(()=>expect(screen.getByLabelText(t('devicesEnableInput'))).toHaveProperty('disabled',false));fireEvent.click(screen.getByLabelText(t('devicesEnableInput')));fireEvent.click(screen.getByRole('button',{name:t('devicesPower')}));
  await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('ios_device_action',{sessionId:'ios-host',id:ios.id,socket:'/private/raw {{socket}}.sock',width:390,height:844,action:{type:'key',key:'power'}},{headers:{'X-Lazysh-Access':'e'.repeat(64)}}));
  await waitFor(()=>expect(screen.getByRole('button',{name:t('devicesCapture')})).toHaveProperty('disabled',false));fireEvent.click(screen.getByRole('button',{name:t('devicesCapture')}));const image=await screen.findByRole('img');pointerSurface(image,390,844);
  await cycleDeviceUi(()=>expect(screen.getByRole('img')).toBe(image));fireEvent.pointerDown(image,{clientX:205,clientY:442});fireEvent.pointerUp(image,{clientX:205,clientY:442});
  await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('ios_device_action',{sessionId:'ios-host',id:ios.id,socket:'/private/raw {{socket}}.sock',width:390,height:844,action:{type:'tap',x:195,y:422}},{headers:{'X-Lazysh-Access':'e'.repeat(64)}}));
});
it.each([
  {name:'owned list',value:null,key:'devicesInvalidList'},
  {name:'owned identity',value:{...deviceInventory,devices:[{}]},key:'devicesInvalidIdentity'},
  {name:'owned capabilities',value:{...deviceInventory,devices:[{...deviceRecord,capabilities:{tap:'yes'}}]},key:'devicesInvalidCapabilities'},
  {name:'raw SDK diagnostic',raw:'devicesInvalidList <SDK path> {{id}}'},
] as const)('keeps an already-visible $name current without invoking the SDK again',async scenario=>{
  vi.mocked(invoke).mockImplementation(async()=>{if('raw' in scenario)throw {key:'devicesInvalidList',message:scenario.raw};return scenario.value;});render(<DevicePanel sessionId="errors-host"/>);fireEvent.click(screen.getByRole('button',{name:t('devicesFind')}));await screen.findByRole('alert');
  await cycleDeviceUi(()=>expect(screen.getByRole('alert').textContent).toBe('raw' in scenario?scenario.raw:t(scenario.key)));
});
