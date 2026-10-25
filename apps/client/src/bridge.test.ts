import {beforeEach,expect,it,vi} from 'vitest';
const invoke=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>true,Channel:class {onmessage?:unknown;}}));
import {api} from './bridge';
beforeEach(()=>invoke.mockClear());
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
