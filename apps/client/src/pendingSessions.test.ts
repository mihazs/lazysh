import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const invoke=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
import { disposeStaleSessionResult, forgetSession, PendingSessions, registerSessionOutput, retainSession } from './pendingSessions';
import { accessSnapshot, acknowledgeAccessReady, applyAccessStatus, sessionOutput } from './access';
beforeEach(()=>invoke.mockClear());
afterEach(()=>{for(const id of ['pending','adopted','queued'])forgetSession(id);});
it('tears down only exact pending IDs and never an already-retained final session',async()=>{
  const owner=new PendingSessions();const pendingOutput=vi.fn();const adoptedOutput=vi.fn();
  owner.add('pending');owner.add('adopted');retainSession('adopted');
  registerSessionOutput('pending',pendingOutput);registerSessionOutput('adopted',adoptedOutput);
  await owner.closeAll();await owner.close('unowned');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('disconnect',{sessionId:'pending'});
  expect(pendingOutput).toHaveBeenCalledOnce();expect(adoptedOutput).not.toHaveBeenCalled();
});
it('allows only late creation-result cleanup and refuses to cancel a retained result',async()=>{
  await disposeStaleSessionResult('read_file',{sessionId:'pending'});
  retainSession('adopted');await disposeStaleSessionResult('connect',{sessionId:'adopted'});
  expect(invoke).not.toHaveBeenCalled();
  await disposeStaleSessionResult('attachDefaultMultiplexer',{sessionId:'late-default'});
  expect(invoke).toHaveBeenLastCalledWith('disconnect',{sessionId:'late-default'});
  invoke.mockClear();
  await disposeStaleSessionResult('local_connect',{sessionId:'local:late-created'});
  expect(invoke).toHaveBeenCalledExactlyOnceWith('local_disconnect',{sessionId:'local:late-created'});
});
it('disables queued terminal replay before native teardown returns',async()=>{
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:'1'});
  const write=vi.fn();const deliver=sessionOutput(write);registerSessionOutput('queued',deliver.dispose);
  const owner=new PendingSessions();owner.add('queued');deliver({type:'data',data:[1,2,3]});
  const closed=owner.close('queued');
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:'2',nonce:'a'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);deliver({type:'data',data:[4]});
  await closed;expect(write).not.toHaveBeenCalled();
});
