import {vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
export const catalogEntry={id:'tiny.en',file:'ggml-tiny.en.bin',label:'Tiny · English',bytes:77704715,sha256:'921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',revision:'5359861c739e955e79d9a303bcbc70fb988958b1'};
export type DownloadCall={id:string;requestId:string;events:{onmessage:(event:unknown)=>void}};
export function downloadFixture(installed:{id:string;bytes:number}[]=[],entry=catalogEntry) {
  let complete!:()=>void;let fail!:(error:Error)=>void;
  vi.mocked(invoke).mockImplementation(command=>{
    if(command==='voice_models')return Promise.resolve(installed) as never;
    if(command==='voice_model_catalog')return Promise.resolve([entry]) as never;
    if(command==='voice_download_model')return new Promise<void>((resolve,reject)=>{complete=resolve;fail=reject;}) as never;
    if(command==='voice_download_cancel')return Promise.resolve(true) as never;
    return Promise.resolve() as never;
  });
  return {installed,complete:()=>complete(),fail:(message:string)=>fail(new Error(message))};
}
