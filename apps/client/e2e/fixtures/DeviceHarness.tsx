import {createRoot} from 'react-dom/client';
import DevicePanel from '../../src/DevicePanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {deviceFrame,deviceInventory,androidVideoProbe,iosDeviceRecord,iosDeviceProbe} from '../../src/test/deviceData';
/** Real device renderer and JPEG decoder; all host IO is synthetic and held. */
export function mountDevices(){
  const calls:{command:string;args:unknown}[]=[];
  let begin!:(token:string)=>void,pull!:(packet:unknown)=>void;
  const pixels=document.createElement('canvas');pixels.width=108;pixels.height=192;
  const brush=pixels.getContext('2d')!;brush.fillStyle='#2255aa';brush.fillRect(0,0,108,192);brush.fillStyle='#ff8800';brush.fillRect(20,35,40,50);
  const frame={...deviceFrame,imageWidth:108,imageHeight:192,base64:pixels.toDataURL('image/jpeg').split(',')[1]};
  pixels.width=0;pixels.height=0;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic device preview authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'e'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{
    calls.push({command,args});
    if(command==='list_devices')return (args as {devicePlatform:string}).devicePlatform==='ios'?{schemaVersion:1,devices:[iosDeviceRecord],avds:[]}:deviceInventory;
    if(command==='device_frame')return frame;
    if(command==='android_device_probe')return androidVideoProbe;
    if(command==='ios_device_probe')return iosDeviceProbe;
    if(command==='device_stream_start')return new Promise<string>(resolve=>{begin=resolve;});
    if(command==='device_stream_next')return new Promise(resolve=>{pull=resolve;});
    if(command==='device_stream_stop'||command==='device_action'||command==='ios_device_action')return;
    throw new Error('Unexpected synthetic device operation');
  }}});
  const host=document.createElement('aside');host.className='device-fixture';host.style.cssText='position:fixed;inset:0;overflow:auto;z-index:100;background:var(--background);padding:12px';
  document.body.append(host);const root=createRoot(host);root.render(<DevicePanel sessionId="browser-device-host"/>);
  return {calls,begin(){begin('browser-device-stream');},deliver(sequence:number){pull({sequence,frame});},dispose(){root.unmount();host.remove();}};
}
