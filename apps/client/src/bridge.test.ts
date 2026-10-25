import {beforeEach,expect,it,vi} from 'vitest';
const invoke=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>true,Channel:class {onmessage?:unknown;}}));
import {api} from './bridge';
import { accessSnapshot, acknowledgeAccessReady, applyAccessStatus } from './access';
beforeEach(()=>invoke.mockClear());
it('submits a complete sequence through one protected native request for either transport',async()=>{
  for (const [id,command] of [['local:sequence','local_write'],['ssh-sequence','write_stdin']]) {
    await api.writeSequence(id,['\x02','T']);
    expect(invoke).toHaveBeenLastCalledWith(command,{sessionId:id,data:'',steps:['\x02','T']},expect.anything());
  }
  expect(invoke).toHaveBeenCalledTimes(2);
});
it('routes local terminal IO exclusively through its native registry',async()=>{
  const id='local:7d019ac3-f86f-41fb-82be-49531d36b459';
  await api.write(id,'hello');await api.resize(id,80,24);await api.ackOutput(id,5);await api.disconnect(id);
  expect(invoke.mock.calls.map(([command])=>command)).toEqual(['local_write','local_resize','local_ack','local_disconnect']);
});
it('preserves the existing SSH terminal IO contract',async()=>{
  await api.write('ssh-id','hello');await api.resize('ssh-id',80,24);await api.ackOutput('ssh-id',5);await api.disconnect('ssh-id');
  expect(invoke.mock.calls.map(([command])=>command)).toEqual(['write_stdin','resize','ack_output','disconnect']);
});
it('rejects local sessions before invoking SSH-only file or multiplexer tools',async()=>{
  const id='local:7d019ac3-f86f-41fb-82be-49531d36b459';
  for(const operation of [()=>api.readFile(id,'/a'),()=>api.uploadFile(id,'/a',[]),()=>api.listDirectory(id,'/'),()=>api.diff(id,'/a'),()=>api.muxSessions(id),()=>api.attachTmux(id,'work',()=>{}),()=>api.connectEt(id,{},()=>{}),()=>api.connectMosh(id,{},()=>{})]) {
    await expect(operation()).rejects.toThrow('requires an SSH connection');
  }
  expect(invoke).not.toHaveBeenCalled();
});
it('retains the same terminal channel and ordered output across lock and acknowledges delivered bytes safely',async()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'',generation:'1',nonce:'a'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  const output: number[]=[];
  invoke.mockResolvedValueOnce({sessionId:'same-native-session'});
  await api.connect('host',{},event=>{if(event.type==='data')output.push(...event.data);});
  const events=(invoke.mock.calls[0][1] as {events:{onmessage:(event:unknown)=>void}}).events;
  events.onmessage({type:'data',data:[1]});
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:true,reason:'',generation:'2'});
  events.onmessage({type:'data',data:[2]});events.onmessage({type:'data',data:[3,4]});
  await api.ackOutput('same-native-session',1);
  expect(invoke).toHaveBeenLastCalledWith('ack_output',{sessionId:'same-native-session',bytes:1});
  expect(output).toEqual([1]);
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'',generation:'3',nonce:'b'.repeat(64)});
  expect(output).toEqual([1]);acknowledgeAccessReady(accessSnapshot().epoch);
  expect(output).toEqual([1,2,3,4]);
  expect(invoke.mock.calls.filter(([command])=>command==='connect')).toHaveLength(1);
});
