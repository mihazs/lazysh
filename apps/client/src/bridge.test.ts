import {beforeEach,expect,it,vi} from 'vitest';
const invoke=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>true,Channel:class {onmessage?:unknown;}}));
import {api} from './bridge';
import {registerSessionOutput,disposeSessionOutput} from './pendingSessions';
import { accessSnapshot, acknowledgeAccessReady, applyAccessStatus, bindProtectedApi, captureAccess, StaleAccessError } from './access';
beforeEach(()=>invoke.mockClear());
it('passes typed Mosh entry separately from transport options on the owned native channel',async()=>{
  invoke.mockResolvedValueOnce({sessionId:'composed-mosh'});
  const entry={kind:'tmux' as const,name:'work',tmuxServer:'agents'};
  await api.connectMosh('entry-parent',{},()=>{},entry);
  expect(invoke).toHaveBeenLastCalledWith('connect_mosh',{sessionId:'entry-parent',options:{},cols:100,rows:30,events:expect.any(Object),entry},expect.anything());
});
it('attaches a multiplexer from a local session by starting a local terminal with the typed entry',async()=>{
  invoke.mockResolvedValue({sessionId:'local:attached'});
  await api.attachTmux('local:shell','work',()=>{},'agents');
  await api.attachMultiplexer('local:shell','zellij','dev',()=>{},true);
  expect(invoke.mock.calls.map(([command,args])=>[command,args.attach,args.sessionId])).toEqual([
    ['local_connect',{kind:'tmux',name:'work',tmuxServer:'agents'},undefined],
    ['local_connect',{kind:'zellij',name:'dev',createIfMissing:false},undefined],
  ]);
  invoke.mockClear();
  await api.muxSessions('local:shell');await api.tmuxJumpSnapshot('local:shell');
  expect(invoke.mock.calls.map(([command,args])=>[command,args.sessionId])).toEqual([['list_multiplexer_sessions','local:shell'],['tmux_jump_snapshot','local:shell']]);
});
it('sends a pane id with a Jump To request only when a pane row was chosen',async()=>{
  const generation='g'.repeat(36);
  await api.tmuxJump('display',generation,'$1','@2');
  await api.tmuxJump('display',generation,'$1','@2','%3');
  expect(invoke.mock.calls.map(([command,args])=>[command,args])).toEqual([
    ['tmux_jump',{sessionId:'display',generation,targetSessionId:'$1',windowId:'@2'}],
    ['tmux_jump',{sessionId:'display',generation,targetSessionId:'$1',windowId:'@2',paneId:'%3'}],
  ]);
});
it('asks the native side to inspect and open a sign-in page, which checks the tunnel itself',async()=>{
  invoke.mockResolvedValueOnce({host:'idp.example',warnings:[],callbackPorts:[8085]}).mockResolvedValueOnce('notified');
  expect(await api.inspectAuthUrl('https://idp.example/a')).toEqual({host:'idp.example',warnings:[],callbackPorts:[8085]});
  expect(await api.openAuthUrl('https://idp.example/a','system')).toBe('notified');
  expect(invoke.mock.calls.map(([command,args])=>[command,args])).toEqual([
    ['inspect_auth_url',{url:'https://idp.example/a'}],
    ['open_auth_url',{url:'https://idp.example/a',browser:'system'}],
  ]);
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
it('sends the offline fallback through its own protected command so the default never downloads on the device',async()=>{
  const progress=vi.fn();
  await api.installCompanionFromDevice('ssh-installer',progress);
  expect(invoke).toHaveBeenCalledWith('install_companion_from_device',{sessionId:'ssh-installer',progress:expect.any(Object)},expect.anything());
  expect(Object.keys(invoke.mock.calls[0][1]).sort()).toEqual(['progress','sessionId']);
  invoke.mockClear();await expect(api.installCompanionFromDevice('local:owned',progress)).rejects.toThrow('SSH connection');expect(invoke).not.toHaveBeenCalled();
});
it('sends the read-only check through a protected command',async()=>{
  await api.checkCompanionUpdate('ssh-installer');
  expect(invoke).toHaveBeenLastCalledWith('check_companion_update',{sessionId:'ssh-installer'},expect.anything());
  invoke.mockClear();
  await expect(api.checkCompanionUpdate('local:owned')).rejects.toThrow('SSH connection');
  expect(invoke).not.toHaveBeenCalled();
});
it('sends the managed Herdr install and removal as protected commands that carry only the session and never a path or command',async()=>{
  const progress=vi.fn();
  await api.installManagedHerdr('ssh-herdr',progress);
  expect(invoke).toHaveBeenCalledWith('install_managed_herdr',{sessionId:'ssh-herdr',progress:expect.any(Object)},expect.anything());
  expect(Object.keys(invoke.mock.calls[0][1]).sort()).toEqual(['progress','sessionId']);
  invoke.mockClear();await api.removeManagedHerdr('ssh-herdr');
  expect(invoke).toHaveBeenCalledWith('remove_managed_herdr',{sessionId:'ssh-herdr'},expect.anything());
  invoke.mockClear();
  await expect(api.installManagedHerdr('local:owned',progress)).rejects.toThrow('SSH connection');
  await expect(api.removeManagedHerdr('local:owned')).rejects.toThrow('SSH connection');
  expect(invoke).not.toHaveBeenCalled();
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
it('rejects local sessions before invoking SSH-only file or transport tools',async()=>{
  const id='local:7d019ac3-f86f-41fb-82be-49531d36b459';
  for(const operation of [()=>api.hostClipboardCopy(id,'receipt'),()=>api.attachDefaultMultiplexer(id,{kind:'tmux',name:'work'},()=>{}),()=>api.connectEt(id,{},()=>{}),()=>api.connectMosh(id,{},()=>{})]) {
    await expect(operation()).rejects.toThrow('requires an SSH connection');
  }
  expect(invoke).not.toHaveBeenCalled();
});
it('sends local uploads to the native host context and keeps the host clipboard for SSH',async()=>{
  const id='local:7d019ac3-f86f-41fb-82be-49531d36b459';
  await api.reserveUpload(id,3);await api.uploadFile(id,'shot.png',[1,2,3],'receipt',true);await api.cancelUpload(id,'receipt');
  expect(invoke.mock.calls.map(([command,args])=>[command,args])).toEqual([['upload_reserve',{sessionId:id,size:3}],['upload_file',{sessionId:id,path:'shot.png',data:[1,2,3],uploadId:'receipt',temporary:true}],['upload_cancel',{sessionId:id,uploadId:'receipt'}]]);
});
it('sends local file reads and Git diffs to the native host context',async()=>{
  const id='local:7d019ac3-f86f-41fb-82be-49531d36b459';
  await api.listDirectory(id,'/');await api.readFile(id,'/a');await api.diff(id,'/repo',true);
  expect(invoke.mock.calls.map(([command,args])=>[command,args])).toEqual([['list_directory',{sessionId:id,path:'/'}],['read_file',{sessionId:id,path:'/a'}],['get_diff',{sessionId:id,path:'/repo',staged:true}]]);
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

it('preserves native discovery rejection identity through both guarded layers and lets revocation win',async()=>{
  const generation=BigInt(accessSnapshot().status?.generation??'0')+1n;
  const unlocked={initialized:true,supported:true,enabled:true,locked:false,reason:'',generation:String(generation),nonce:'c'.repeat(64)};
  applyAccessStatus(unlocked);
  const guarded=bindProtectedApi(api,captureAccess());
  const failure=Object.freeze({kind:'remote_command_failed',message:'owned unsupported schema'});
  invoke.mockRejectedValueOnce(failure);
  await expect(guarded.companionHookDiscovery('owned-discovery',2)).rejects.toBe(failure);
  expect(invoke).toHaveBeenLastCalledWith('companion_hook_discovery',{sessionId:'owned-discovery',schemaVersion:2},expect.anything());
  let reject!:(value:unknown)=>void;
  invoke.mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail;}));
  const pending=expect(guarded.companionHookDiscovery('owned-discovery',2)).rejects.toBeInstanceOf(StaleAccessError);
  applyAccessStatus({...unlocked,locked:true,generation:String(generation+1n),nonce:undefined});
  reject(failure);await pending;
  applyAccessStatus({...unlocked,generation:String(generation+2n)});
});
it('sends hook discovery and setup for a local session to the native companion while keeping its SSH-only helpers rejected',async()=>{
  const id='local:7d019ac3-f86f-41fb-82be-49531d36b459';
  await api.companionHookDiscovery(id,3);
  await api.companionHooks(id,{agent:'claude',action:'status',profileRoot:'/home/user/.claude'});
  expect(invoke.mock.calls.map(([command,args])=>[command,args])).toEqual([
    ['companion_hook_discovery',{sessionId:id,schemaVersion:3}],
    ['companion_hooks',{sessionId:id,request:{agent:'claude',action:'status',profileRoot:'/home/user/.claude'}}],
  ]);
  invoke.mockClear();
  for(const operation of [()=>api.connectMosh(id,{},()=>{}),()=>api.connectEt(id,{},()=>{})])await expect(operation()).rejects.toThrow('requires an SSH connection');
  expect(invoke).not.toHaveBeenCalled();
});
it('starts a session on the native data path with the core\'s own channel and binds the session it started',async()=>{
  const events={};const bind=vi.fn();
  invoke.mockResolvedValueOnce({sessionId:'local:9'});
  await api.connectLocal(Object.assign(()=>{},{link:{events,bind}}));
  expect(invoke).toHaveBeenLastCalledWith('local_connect',expect.objectContaining({events}),expect.anything());
  expect(invoke.mock.calls.at(-1)![1].events).toBe(events);
  await expect(bind.mock.calls[0][0]).resolves.toBe('local:9');
});
it('binds the failure of a native-path start so the core\'s commands do not wait for a session that never came',async()=>{
  const bind=vi.fn();
  invoke.mockRejectedValueOnce(new Error('refused'));
  await expect(api.connectLocal(Object.assign(()=>{},{link:{events:{},bind}}))).rejects.toThrow('refused');
  await expect(bind.mock.calls[0][0]).rejects.toThrow('refused');
});

it('detaches the renderer callback when a terminal session retires', async () => {
  invoke.mockResolvedValueOnce({sessionId:'local:output-retirement'});
  await api.connectLocal(vi.fn());
  const active=invoke.mock.calls.at(-1)![1].events;
  const deliver=active.onmessage;
  disposeSessionOutput('local:output-retirement');
  expect(active.onmessage).not.toBe(deliver);

});

it('detaches the renderer callback when terminal startup fails', async () => {
  let deliver: unknown;
  invoke.mockImplementationOnce(async (_command, args) => {
    deliver = args.events.onmessage;
    throw new Error('start failed');
  });
  await expect(api.connectLocal(vi.fn())).rejects.toThrow('start failed');
  expect(deliver).toBeTypeOf('function');
  expect(invoke.mock.calls.at(-1)![1].events.onmessage).not.toBe(deliver);
});
