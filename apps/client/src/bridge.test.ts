import {beforeEach,expect,it,vi} from 'vitest';
const invoke=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>true,Channel:class {onmessage?:unknown;}}));
import {api} from './bridge';
import {registerSessionOutput,disposeSessionOutput} from './pendingSessions';
import { accessSnapshot, acknowledgeAccessReady, applyAccessStatus } from './access';
beforeEach(()=>invoke.mockClear());
it('passes typed Mosh entry separately from transport options on the owned native channel',async()=>{
  invoke.mockResolvedValueOnce({sessionId:'composed-mosh'});
  const entry={kind:'tmux' as const,name:'work',tmuxServer:'agents'};
  await api.connectMosh('entry-parent',{},()=>{},entry);
  expect(invoke).toHaveBeenLastCalledWith('connect_mosh',{sessionId:'entry-parent',options:{},cols:100,rows:30,events:expect.any(Object),entry},expect.anything());
});
it('sends installation through one protected native command with no renderer URL or binary data',async()=>{
  const progress=vi.fn();
  await api.installCompanion('ssh-installer',progress);
  expect(invoke).toHaveBeenCalledWith('install_companion',{sessionId:'ssh-installer',progress:expect.any(Object)},expect.anything());
  expect(Object.keys(invoke.mock.calls[0][1]).sort()).toEqual(['progress','sessionId']);
  const channel=invoke.mock.calls[0][1].progress;
  channel.onmessage({stage:'uploading'});expect(progress).not.toHaveBeenCalled();
  invoke.mockClear();await expect(api.installCompanion('local:owned',progress)).rejects.toThrow('SSH connection');expect(invoke).not.toHaveBeenCalled();
});
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
  for(const operation of [()=>api.readFile(id,'/a'),()=>api.uploadFile(id,'/a',[],'receipt'),()=>api.listDirectory(id,'/'),()=>api.diff(id,'/a'),()=>api.muxSessions(id),()=>api.tmuxJumpSnapshot(id),()=>api.tmuxJump(id,'generation','$1','@2'),()=>api.attachTmux(id,'work',()=>{}),()=>api.attachDefaultMultiplexer(id,{kind:'tmux',name:'work'},()=>{}),()=>api.connectEt(id,{},()=>{}),()=>api.connectMosh(id,{},()=>{})]) {
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

it('requests only the typed named default entry through the existing native attachment command',async()=>{
  invoke.mockResolvedValueOnce({sessionId:'named-child'});
  await api.attachDefaultMultiplexer('verified-parent',{kind:'tmux',name:'exact-work'},()=>{});
  expect(invoke).toHaveBeenCalledWith('attach_multiplexer',expect.objectContaining({sessionId:'verified-parent',kind:'tmux',name:'exact-work',createIfMissing:true,cols:100,rows:30}),expect.anything());
  expect(invoke.mock.calls[0][1]).not.toHaveProperty('command');
});

it.each(['files','hostTools'] as const)('restores %s through a guarded ordinary request without replacing terminal output ownership',async purpose=>{
  const original=vi.fn();registerSessionOutput('original-mosh',original);
  invoke.mockResolvedValueOnce({schemaVersion:1,status:'restored'});
  await (purpose==='files'?api.restoreFileTransfer:api.restoreHostTools)('original-mosh',{privateKey:'owned-ephemeral-key'},{useSavedCredentials:false});
  expect(invoke).toHaveBeenLastCalledWith(purpose==='files'?'restore_file_transfer':'restore_host_tools',{sessionId:'original-mosh',privateKey:'owned-ephemeral-key',useSavedCredentials:false},expect.anything());
  expect(invoke.mock.calls.at(-1)?.[1]).not.toHaveProperty('events');
  disposeSessionOutput('original-mosh');expect(original).toHaveBeenCalledOnce();
});
