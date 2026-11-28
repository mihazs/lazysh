import {expect,test} from 'bun:test';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {TmuxFixture,muxVariable,tmuxAttachHistoryVerified,tmuxChatDeliveredOnce,tmuxClientCount,tmuxCopyModeVerified,tmuxCommandFailure,tmuxDefaultAttachVerified,tmuxDefaultDirectory,tmuxDefaultName,tmuxDefaultSession,tmuxDisplayClients,tmuxGesturesVerified,tmuxPaneRows,tmuxPassthroughSupported,tmuxServerStatus,tmuxSessionRows,tmuxSplitRows,tmuxTeardownObservation,tmuxViewHistory,tmuxWindowLifecycle,tmuxWindowRows,type TmuxView} from './support/androidTmux';
import {listening,OwnedProcess,SshFixture} from './support/androidSsh';
import {androidLostConnectionAcceptance,lostConnectionCase,lostConnectionControl,validateLostConnectionReport} from './support/androidLostConnection';
import {OwnedSshRelay} from '../apps/client/native-e2e/sshRelay';
import {androidForceStopRestoreAcceptance,restoreCases,restoreControl,validateInstrumentationRun} from './support/androidForceStopRestore';
import {close,listen} from './support/androidSshParity';
import {connect,createServer} from 'node:net';
import {reportingAgentDeliveredOnce,reportingAgentKeysAre,reportingAgentPrompts} from './support/androidTmuxAgent';

/** Runs one tmux command against the owned fixture's server over its SSH, as the app's own action does. */
const hostTmux=(owned:TmuxFixture)=>async(command:string)=>(await owned.ssh.client(true,`tmux -u -L default ${command}`)).finish('owned tmux window action',5000);

/** Polls a host condition every 25 ms and fails the test after five seconds. */
const wait=async(predicate:()=>boolean|Promise<boolean>)=>{
  const deadline=performance.now()+5000;
  while(!await predicate()){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(25);}
};

test('tmux host readback admits only the owned two-window topology and display clients',()=>{
  const row=(index:number,name:string,active:number,dead=0)=>`@${index+1}|${index}|${name}|${active}|%${index}|${100+index}|${dead}`;
  expect(tmuxPaneRows(`${row(0,'alpha',1)}\n${row(1,'beta',0,1)}\n`)).toEqual([
    {windowId:'@1',index:0,name:'alpha',active:true,paneId:'%0',pid:100,dead:false},
    {windowId:'@2',index:1,name:'beta',active:false,paneId:'%1',pid:101,dead:true},
  ]);
  for(const invalid of ['',row(0,'alpha',1),`${row(0,'alpha',1)}\n${row(1,'gamma',0)}`,`${row(0,'alpha',1)}\n${row(1,'beta',0)}\n${row(2,'beta',0)}`,
    `${row(0,'alpha',1)}\n${row(1,'beta',0)}|private`,`${row(0,'alpha',1)}\n${row(1,'beta',0).replace('|101|','|0|')}`])
    expect(()=>tmuxPaneRows(invalid)).toThrow('Owned tmux topology changed');
  expect(tmuxDisplayClients('')).toBe(0);
  expect(tmuxDisplayClients('1\n0\n1\n')).toBe(1);
  for(const invalid of ['2\n','0\n'.repeat(9),'private\n'])expect(()=>tmuxDisplayClients(invalid)).toThrow('Owned tmux client readback invalid');
  expect(tmuxClientCount('')).toBe(0);
  expect(tmuxClientCount('123\n456\n')).toBe(2);
  for(const invalid of ['0\n','12a\n','1\n'.repeat(9),'/dev/pts/1\n'])expect(()=>tmuxClientCount(invalid)).toThrow('Owned tmux client readback invalid');
  expect(tmuxAttachHistoryVerified([0,1,0,1,0])).toBe(true);
  for(const history of [[0,1,0],[0,1,0,1],[0,1,2,1,0],[1,0,1,0],[0,1,0,1,0,1,0]])expect(tmuxAttachHistoryVerified(history)).toBe(false);
  expect(tmuxCopyModeVerified([0,1,0])).toBe(true);
  for(const history of [[],[0],[0,1],[1,0],[0,1,0,1],[0,2,0]])expect(tmuxCopyModeVerified(history)).toBe(false);
});

test('tmux window readback follows only the one added window and refuses a touched original',()=>{
  const originals=[{windowId:'@1',name:'alpha'},{windowId:'@2',name:'beta'}],base='@1|alpha|0|0\n@2|beta|1|0';
  const fold=(text:string,seen?:Parameters<typeof tmuxWindowLifecycle>[2])=>tmuxWindowLifecycle(tmuxWindowRows(text),originals,seen);
  let seen=fold(base);
  expect(seen).toBeUndefined();
  seen=fold(`${base}\n@3|scratch|0|0`,seen);
  expect(seen).toEqual({windowId:'@3',names:['scratch'],closed:false});
  expect(fold(`${base}\n@3|scratch|0|0`,seen)).toBe(seen);
  seen=fold(`${base}\n@3|renamed|0|0`,seen);
  expect(seen?.names).toEqual(['scratch','renamed']);
  expect(fold(base,seen)).toEqual({windowId:'@3',names:['scratch','renamed'],closed:true});
  // A closed or renamed original, a second added window, a replaced or reappearing one: never the app's window.
  for(const text of ['@1|alpha|0|0','@1|alpha|0|0\n@2|renamed|1|0',`${base}\n@3|a|0|0\n@4|b|0|0`])expect(()=>fold(text)).toThrow(/Owned tmux (original window|window topology) changed/);
  expect(()=>fold(`${base}\n@4|b|0|0`,{windowId:'@3',names:['a'],closed:false})).toThrow('Owned tmux window topology changed');
  expect(()=>fold(`${base}\n@3|a|0|0`,{windowId:'@3',names:['a'],closed:true})).toThrow('Owned tmux window topology changed');
  for(const invalid of ['','private text','@3|bad name|0|0','@3|'+'x'.repeat(33)+'|0|0','@3|a','@3|a|2|0','@3|a|0|zoomed',`${base}\n@3|a|0|0|private`])expect(()=>tmuxWindowRows(invalid)).toThrow('Owned tmux window topology changed');
});

test('tmux view history keeps the active window and its zoom flag, and the gesture check needs the exact closing order',()=>{
  const originals=[{windowId:'@1',name:'alpha'},{windowId:'@2',name:'beta'}];
  const fold=(history:readonly TmuxView[],active:'@1'|'@2'|'@3',zoomed=false)=>tmuxViewHistory(tmuxWindowRows(
    ['@1|alpha','@2|beta','@3|scratch'].map(line=>`${line}|${line.startsWith(`${active}|`)?1:0}|${line.startsWith(`${active}|`) && zoomed?1:0}`).join('\n')),originals,history);
  let history:readonly TmuxView[]=[];
  for(const [active,zoomed] of [['@1',false],['@1',false],['@2',false],['@3',false],['@2',false],['@2',true],['@2',true],['@2',false],['@2',true],['@2',false],['@1',false],['@2',false],['@2',false]] as const)history=fold(history,active,zoomed);
  expect(history).toEqual([{window:'alpha',zoomed:false},{window:'beta',zoomed:false},{window:'other',zoomed:false},{window:'beta',zoomed:false},{window:'beta',zoomed:true},
    {window:'beta',zoomed:false},{window:'beta',zoomed:true},{window:'beta',zoomed:false},{window:'alpha',zoomed:false},{window:'beta',zoomed:false}]);
  expect(tmuxGesturesVerified(history)).toBe(true);
  // Missing a step, a different order or a zoom of the other window is not the gesture phase.
  const tail=history.slice(-5);
  for(const wrong of [history.slice(0,-1),history.slice(0,-2),[...history.slice(0,-5),tail[0],tail[2],tail[1],tail[3],tail[4]],
    [...history.slice(0,-5),{window:'alpha' as const,zoomed:true},...tail.slice(1)],[...history,{window:'beta' as const,zoomed:true},{window:'beta' as const,zoomed:false}],[],tail.slice(0,4)])
    expect(tmuxGesturesVerified(wrong)).toBe(false);
  // Two active windows or none is not a tmux session, and a runaway history is bounded.
  expect(()=>tmuxViewHistory(tmuxWindowRows('@1|alpha|1|0\n@2|beta|1|0'),originals,[])).toThrow('Owned tmux window topology changed');
  expect(()=>tmuxViewHistory(tmuxWindowRows('@1|alpha|0|0\n@2|beta|0|0'),originals,[])).toThrow('Owned tmux window topology changed');
  const long=Array.from({length:24},(_,index):TmuxView=>({window:'beta',zoomed:index%2===1}));
  expect(()=>fold(long,'@1')).toThrow('Owned tmux view history exceeded');
});

test('tmux split readback admits only the original pane, one added pane and a closed zoom flag',()=>{
  const row=(pane:number,pid:number,zoomed=0,path='/owned')=>`%${pane}|${pid}|${zoomed}|${path}`;
  expect(tmuxSplitRows(`${row(1,101)}\n${row(2,202)}\n`)).toEqual([
    {paneId:'%1',pid:101,zoomed:false,path:'/owned'},{paneId:'%2',pid:202,zoomed:false,path:'/owned'}]);
  expect(tmuxSplitRows(`${row(1,101,1)}\n${row(2,202,1)}\n`).every(value=>value.zoomed)).toBe(true);
  for(const invalid of ['',row(1,101),`${row(1,101)}\n${row(2,202)}\n${row(3,303)}`,`${row(1,101)}\n${row(2,0)}`,`${row(1,101)}\n${row(2,202,2)}`,
    `${row(1,101)}\n${row(2,202,0,'relative')}`,`${row(1,101)}\n${row(2,202)}|private`,`${row(1,101)}\n${row(2,202,0,'/'+'x'.repeat(2048))}`])
    expect(()=>tmuxSplitRows(invalid)).toThrow('Owned tmux split topology changed');
  const owned=(extra:number)=>[0,1,...Array(extra).fill(1)].map((index,line)=>`@${index+1}|${index}|${index===0?'alpha':'beta'}|${index===0?1:0}|%${line}|${100+line}|0`).join('\n');
  expect(tmuxPaneRows(owned(1),1)).toHaveLength(3);
  expect(()=>tmuxPaneRows(owned(1))).toThrow('Owned tmux topology changed');
  expect(()=>tmuxPaneRows(owned(0),1)).toThrow('Owned tmux topology changed');
});

test('tmux Chat readback admits one delivery in the original pane and nothing else',()=>{
  const draft="tmux chat 1: it's $HOME",pane=(paneId:string,text='')=>({paneId,text});
  tmuxChatDeliveredOnce([pane('%0',`marker\n${draft}\n`),pane('%1','marker\n')],draft,'%0');
  const rejected='Owned tmux Chat input did not reach exactly the original pane once';
  for(const captures of [[pane('%0','marker'),pane('%1','marker')],[pane('%0','marker'),pane('%1',draft)],[pane('%0',draft),pane('%1',draft)],[pane('%0',draft+draft),pane('%1')]])
    expect(()=>tmuxChatDeliveredOnce(captures,draft,'%0')).toThrow(rejected);
  for(const [captures,expected,text] of [[[pane('%0',draft)],'%1',draft],[[pane('%0',draft),pane('%0',draft)],'%0',draft],[[pane('%0',draft)],'%0','']] as const)
    expect(()=>tmuxChatDeliveredOnce(captures,expected,text)).toThrow('Owned tmux Chat readback invalid');
});

test('the companion joins only the pinned tmux fixture and only by an absolute path',async()=>{
  await expect(SshFixture.start(undefined,{agentBinary:'/usr/bin/true'})).rejects.toThrow('Owned agent binary requires the pinned tmux fixture');
  await expect(TmuxFixture.start('relative/rmux',undefined,'rmux')).rejects.toThrow('Explicit pinned rmux binary required');
  await expect(TmuxFixture.start('/usr/bin/tmux','lazysh-agent')).rejects.toThrow('Explicit current-source companion required');
});

test('tmux session readback admits the original and at most one default session, once created, and refuses a touched original',()=>{
  const original={sessionId:'$0',name:'owned-tmux'},base='$0|owned-tmux|2',created=`${base}\n$1|${tmuxDefaultName}|1`;
  const fold=(text:string,seen?:Parameters<typeof tmuxDefaultSession>[2])=>tmuxDefaultSession(tmuxSessionRows(text),original,seen);
  let seen=fold(base);
  expect(seen).toBeUndefined();
  seen=fold(created,seen);
  expect(seen).toEqual({sessionId:'$1'});
  // The original's windows belong to the window lifecycle: a third window there is not a session change.
  expect(fold(created.replace('|2','|3'),seen)).toEqual(seen);
  // A second session of the same name, a killed and recreated one, or one that vanished is not the one the app created.
  for(const text of [`${created}\n$2|${tmuxDefaultName}|1`,created.replace('$1','$2'),base])expect(()=>fold(text,seen)).toThrow('Owned tmux default session topology changed');
  expect(()=>fold(created.replace('|1','|2'))).toThrow('Owned tmux default session topology changed');
  expect(()=>fold(`${created}\n$2|other|1`)).toThrow('Owned tmux default session topology changed');
  // An altered original: renamed, replaced under its name, or gone.
  for(const text of [created.replace('owned-tmux','renamed'),created.replace('$0|owned-tmux','$5|owned-tmux'),`$1|${tmuxDefaultName}|1`])expect(()=>fold(text)).toThrow('Owned tmux original session changed');
  for(const invalid of ['','private text','$1|bad name|1',`$1|${'x'.repeat(33)}|1`,`${created}|private`])expect(()=>tmuxSessionRows(invalid)).toThrow('Owned tmux session topology changed');
  // The default's first sighting may already be attached: the app creates the session a moment before it attaches.
  for(const history of [[0,1,0,1,0],[1,0,1,0]])expect(tmuxDefaultAttachVerified(history)).toBe(true);
  for(const history of [[],[0],[0,1],[0,1,0],[0,1,0,1],[0,1,0,1,0,1,0],[1,0,1],[0,0,1,0,1,0]])expect(tmuxDefaultAttachVerified(history)).toBe(false);
  expect(()=>tmuxDefaultDirectory('/tmp/owned\n','/tmp/owned')).not.toThrow();
  for(const text of ['','/tmp/other\n','/tmp/owned\n/tmp/owned\n','/tmp/owned/extra\n'])expect(()=>tmuxDefaultDirectory(text,'/tmp/owned')).toThrow('Owned tmux default session directory changed');
});

test('tmux teardown evidence keeps only fixed fixture messages, counts and supervisor status',()=>{
  const server=(exitCode:number|null,signalCode:NodeJS.Signals|null)=>({child:{exitCode,signalCode}});
  const evidence={serverAtStop:'live' as const,clients:1,processes:{live:1,inSsh:1},detached:'all' as const,straysRetired:0,sockets:4,shutdown:'deadline' as const,exitMs:10000};
  expect(tmuxTeardownObservation(evidence,new Error('Owned tmux root identity lost'),server(137,null))).toEqual({scope:'tmux-teardown',
    ...evidence,failure:'Owned tmux root identity lost',supervisorExit:137,supervisorSignal:'none'});
  for(const failure of [new Error('private /tmp/owned path'),'private text'])
    expect(tmuxTeardownObservation({...evidence,shutdown:'unclean'},failure,server(null,'SIGUSR2'))).toMatchObject({failure:'other',supervisorExit:null,supervisorSignal:'other'});
  expect(tmuxTeardownObservation({serverAtStop:'absent',clients:null,processes:null,detached:'not-requested',straysRetired:null,sockets:null,shutdown:'not-requested',exitMs:null},undefined)).toMatchObject({failure:'none',supervisorExit:null,supervisorSignal:'none'});
});

test('tmux command failures and supervisor status keep only fixed classes and bounded codes',()=>{
  const failed=new Error('Owned fixture failed: owned tmux command; exit=1');
  expect(tmuxCommandFailure('server exited unexpectedly\n',failed)).toBe('lost-server');
  expect(tmuxCommandFailure('no server running on /tmp/private/default\n',failed)).toBe('no-server');
  expect(tmuxCommandFailure("can't find session: private\n",failed)).toBe('no-session');
  expect(tmuxCommandFailure('private text',failed)).toBe('other');
  expect(tmuxCommandFailure('',new Error('Owned fixture deadline: owned tmux command'))).toBe('deadline');
  expect(tmuxServerStatus({exitCode:null,signalCode:null})).toEqual({state:'running',exit:null,signal:'none'});
  expect(tmuxServerStatus({exitCode:139,signalCode:null})).toEqual({state:'exited',exit:139,signal:'none'});
  expect(tmuxServerStatus({exitCode:null,signalCode:'SIGUSR1'})).toEqual({state:'exited',exit:null,signal:'other'});
  expect(tmuxServerStatus()).toEqual({state:'absent',exit:null,signal:'none'});
});

test('lost-connection control answers only its nonce, cuts and restores a real relayed route and reports closed facts',async()=>{
  const upstream=createServer(socket=>{socket.on('error',()=>{});socket.pipe(socket);});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const relay=await OwnedSshRelay.start((upstream.address() as {port:number}).port);
  let clients=1;
  const control=lostConnectionControl(relay,{observe:async()=>clients},'owner');
  const open=()=>new Promise<'echoed'|'closed'>(resolve=>{
    const socket=connect({host:'127.0.0.1',port:relay.port});
    socket.on('error',()=>{});
    socket.once('data',()=>{socket.destroy();resolve('echoed');});
    socket.once('close',()=>resolve('closed'));
    socket.once('connect',()=>socket.write('ping'));
  });
  try {
    for(const request of [undefined,{nonce:'foreign',action:'cut'},{nonce:'owner',action:'remove'}])await expect(control.reply(request)).rejects.toThrow();
    expect(relay.refused).toBe(0);
    expect(await open()).toBe('echoed');
    const held=connect({host:'127.0.0.1',port:relay.port});held.on('error',()=>{});
    await new Promise(resolve=>held.once('connect',resolve));
    expect(await control.reply({nonce:'owner',action:'observe'})).toEqual({clients:1,refused:0,active:1});
    const lost=new Promise<void>(resolve=>held.once('close',()=>resolve()));
    await control.reply({nonce:'owner',action:'cut'});
    await lost;
    expect(await open()).toBe('closed');
    clients=0;
    expect(await control.reply({nonce:'owner',action:'observe'})).toEqual({clients:0,refused:1,active:0});
    await control.reply({nonce:'owner',action:'restore'});
    expect(await open()).toBe('echoed');
  } finally {
    await relay.stop();
    await new Promise<void>(resolve=>upstream.close(()=>resolve()));
  }
});

test('lost-connection report counts only its case passing exactly once',()=>{
  const row=(name:string,body='')=>`<testcase name="${name}" classname="app.lazysh.client.NativeWorkspaceTest" time="1">${body}</testcase>`;
  const report=(rows:string[])=>`<?xml version="1.0"?><testsuites><testsuite tests="${rows.length}">${rows.join('')}</testsuite></testsuites>`;
  expect(validateLostConnectionReport(report([row(lostConnectionCase)]))).toBe(1);
  for(const rows of [[],[row('ownedTmuxThroughRealUi')],[row(lostConnectionCase),row(lostConnectionCase)],[row(lostConnectionCase,'<skipped/>')],[row(lostConnectionCase,'<failure message="x"/>')]])
    expect(()=>validateLostConnectionReport(report(rows))).toThrow();
});

/** An interactive display client attached to `target` through the fixture's SSH, once `marker` shows on its screen. */
const attachDisplay=async(owned:TmuxFixture,target:string,marker='')=>{
  const shell=await owned.ssh.client();
  await wait(()=>shell.stdout.includes(owned.ssh.prompt));
  shell.child.stdin!.write(`exec ${owned.binary} -u -L default attach-session -t '=${target}'\n`);
  await wait(()=>shell.stdout.includes(marker));
  return shell;
};
test('restore control replies the closed host facts over its socket only to its nonce and observe, and fails when the pane changed',async()=>{
  let observe=async()=>({clients:1});
  const channel=await listen(restoreControl({observe:()=>observe()},'owner'));
  const ask=(request:unknown)=>new Promise<unknown>((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:channel.port},()=>socket.write(JSON.stringify(request)+'\n'));
    let text='';
    socket.setEncoding('utf8');
    socket.on('data',chunk=>{text+=chunk;});
    socket.on('error',reject);
    socket.on('close',()=>resolve(JSON.parse(text)));
  });
  try {
    expect(await ask({nonce:'owner',action:'observe'})).toEqual({ok:true,clients:1});
    observe=async()=>({clients:0});
    expect(await ask({nonce:'owner',action:'observe'})).toEqual({ok:true,clients:0});
    // The Herdr case adds whether its receiver holds the typed bytes.
    observe=async()=>({clients:1,typed:true});
    expect(await ask({nonce:'owner',action:'observe'})).toEqual({ok:true,clients:1,typed:true});
    expect(await ask({nonce:'foreign',action:'observe'})).toEqual({ok:false,error:'nonce'});
    for(const action of ['cut','toString'])expect(await ask({nonce:'owner',action})).toEqual({ok:false,error:'action'});
    observe=async()=>{throw new Error('Owned tmux pane identity changed');};
    expect(await ask({nonce:'owner',action:'observe'})).toEqual({ok:false,error:'failed'});
  } finally {await close(channel.server);}
});

test('a restore phase counts only when its own case started and passed in a finished instrumentation run',()=>{
  const status=(name:string,code:number,extra='')=>[
    'INSTRUMENTATION_STATUS: class=app.lazysh.client.NativeWorkspaceTest','INSTRUMENTATION_STATUS: current=1','INSTRUMENTATION_STATUS: id=AndroidJUnitRunner',
    'INSTRUMENTATION_STATUS: numtests=1',code===1?'INSTRUMENTATION_STATUS: stream=\napp.lazysh.client.NativeWorkspaceTest:':'INSTRUMENTATION_STATUS: stream=.',
    ...(extra?[extra]:[]),`INSTRUMENTATION_STATUS: test=${name}`,`INSTRUMENTATION_STATUS_CODE: ${code}`,''].join('\n');
  const finished='INSTRUMENTATION_RESULT: stream=\n\nTime: 12.3\n\nOK (1 test)\n\n\nINSTRUMENTATION_CODE: -1\n';
  const name=restoreCases.tmux.after;
  expect(()=>validateInstrumentationRun(status(name,1)+status(name,0)+finished,name)).not.toThrow();
  const stack='INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: Native workspace not ready at restore offer once the saved hosts load\n\tat org.junit.Assert.fail(Assert.java:89)';
  // A failed assertion names its stage in the thrown message, so the job log says what went wrong.
  expect(()=>validateInstrumentationRun(status(name,1)+status(name,-2,stack)+'INSTRUMENTATION_RESULT: stream=\n\nFAILURES!!!\nINSTRUMENTATION_CODE: -1\n',name))
    .toThrow('Native workspace not ready at restore offer once the saved hosts load');
  for(const output of [
    '',
    status(name,1)+status(name,0),
    status(name,1)+finished,
    status(name,1)+status(name,-1,stack)+finished,
    status(name,1)+status(name,-3)+finished,
    status(name,1)+status(name,-4)+finished,
    status(name,1)+status(name,0)+status(name,1)+status(name,0)+finished,
    status(restoreCases.tmux.before,1)+status(restoreCases.tmux.before,0)+finished,
    status(name,1)+status(name,0)+'INSTRUMENTATION_RESULT: shortMsg=Process crashed.\nINSTRUMENTATION_CODE: 0\n',
    status(name,1)+status(name,0)+'INSTRUMENTATION_FAILED: app.lazysh.client.test/androidx.test.runner.AndroidJUnitRunner\n',
  ])expect(()=>validateInstrumentationRun(output,name)).toThrow('did not pass exactly once');
});

// Real pinned tools are explicit; ordinary host checks never download or guess a binary.
for(const kind of ['tmux','rmux'] as const) {
  test.skipIf(process.platform!=='linux' || !process.env[muxVariable[kind]])(`owned namespaced ${kind} survives a real SSH detach and reattaches the original panes`,async()=>{
    const owned=await TmuxFixture.start(undefined,undefined,kind);
    const [alpha,beta]=owned.metadata().windows;
    let client:OwnedProcess|undefined;
    try {
      expect(owned.metadata().windows.map(({index,name})=>[index,name])).toEqual([[0,'alpha'],[1,'beta']]);
      await expect(owned.verifyDetachedAndReattached()).rejects.toThrow('Owned tmux attach, detach and reattach were not observed');
      const clients=async(count:number)=>wait(async()=>{await owned.observe();return owned.diagnostic().history.at(-1)===count;});
      const attach=(marker:string)=>attachDisplay(owned,owned.name,marker);
      client=await attach(alpha.marker);await clients(1);
      // The host reads a window's original pane: its own marker is there, anything else is not.
      expect(await owned.paneHolds(0,alpha.marker)).toBe(true);
      expect(await owned.paneHolds(0,'NOT_IN_THE_PANE')).toBe(false);
      await expect(owned.paneHolds(9,alpha.marker)).rejects.toThrow('topology');
      client.child.stdin!.write('\x02d');
      await client.finish('owned tmux prefix detach',5000);
      await clients(0);
      client=await attach(alpha.marker);await clients(1);
      // The status line names windows only; beta's pane marker appears after the numbered switch.
      expect(client.stdout.includes(beta.marker)).toBe(false);
      client.child.stdin!.write('\x021');
      await wait(()=>client!.stdout.includes(beta.marker));
      await client.stop();
      await owned.verifyDetachedAndReattached();
      expect(owned.diagnostic()).toEqual({schemaVersion:1,history:[0,1,0,1,0],defaultHistory:[],modes:[0],views:['alpha','beta'],windows:2,server:{state:'running',exit:null,signal:'none'}});
      if(kind==='tmux') {
        // A still-attached control-mode client, like the app's Jump binding, whose reader no
        // longer drains its output must not break teardown: retiring SSH ends it first.
        client=await owned.ssh.client(true,"tmux -u -L default -C attach-session -t '=owned-tmux'");
        await wait(()=>client!.stdout.includes('%session-changed'));
        process.kill(-client.child.pid!,'SIGSTOP');
        // Pane echo becomes undrained control output until the client can no longer leave.
        const pressure=await owned.ssh.client(true,`i=0; while [ $i -lt 400 ]; do tmux -L default send-keys -l -t '=owned-tmux:0' '${'x'.repeat(4000)}'; i=$((i+1)); done`);
        await pressure.finish('owned tmux control output pressure',20000);
        await owned.stop();
        await owned.stop();
        process.kill(-client.child.pid!,'SIGCONT');
        await expect(client.finish('owned tmux control client retired with SSH',5000)).rejects.toThrow('Owned fixture failed');
      }
    } finally {
      await client?.stop();
      await owned.stop();
    }
    await expect(owned.observe()).rejects.toThrow('Owned tmux server identity changed');
    expect(await listening(owned.ssh.port)).toBe(false);
    await expect(stat(owned.ssh.directory)).rejects.toMatchObject({code:'ENOENT'});
  },60_000);
}

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux host readback requires the saved default session created once, attached, detached and attached again',async()=>{
  const owned=await TmuxFixture.start();
  let client:OwnedProcess|undefined;
  try {
    const tmux=async(command:string)=>(await owned.ssh.client(true,`tmux -u -L default ${command}`)).finish('owned tmux default session action',5000);
    const clients=(count:number)=>wait(async()=>{await owned.observe();return owned.diagnostic().defaultHistory.at(-1)===count;});
    const create=`new-session -d -s '${tmuxDefaultName}' -c .`;
    const notObserved='Owned tmux default session create, attach, detach and reattach were not observed';
    // Nothing happened yet, then a session that was created but never attached: neither is the app's final state.
    await expect(owned.verifyDefaultSession()).rejects.toThrow(notObserved);
    // The exact command the saved default's preflight sends when its session is missing, from the login directory like the app's.
    await tmux(create);
    await owned.observe();
    await expect(owned.verifyDefaultSession()).rejects.toThrow(notObserved);
    client=await attachDisplay(owned,tmuxDefaultName);await clients(1);
    client.child.stdin!.write('\x02d');
    await client.finish('owned tmux prefix detach',5000);
    await clients(0);
    client=await attachDisplay(owned,tmuxDefaultName);await clients(1);
    await client.stop();
    await owned.verifyDefaultSession();
    // The original session was never attached or touched, and the default's metadata names the session the app must create.
    expect(owned.diagnostic()).toMatchObject({history:[0],defaultHistory:[0,1,0,1,0],windows:2});
    expect(owned.metadata().defaultName).toBe(tmuxDefaultName);
    // A session killed and created again under the same name is a second creation, not the one the app attached.
    await tmux(`kill-session -t '=${tmuxDefaultName}'`);
    await tmux(create);
    await expect(owned.observe()).rejects.toThrow('Owned tmux default session topology changed');
  } finally {
    await client?.stop();
    await owned.stop();
  }
},60_000);

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux host readback requires the app-style create, rename and close of one added window',async()=>{
  const owned=await TmuxFixture.start();
  try {
    const tmux=hostTmux(owned);
    // Nothing happened yet, then a window that is still open: neither is the app's final state.
    await expect(owned.verifyWindowLifecycle()).rejects.toThrow('Owned tmux window create, rename and close were not observed');
    const [created,renamed]=owned.metadata().lifecycle;
    // The exact commands the app sends for New window (Workspaces panel), Rename window and the tab strip's Close.
    const session=(await tmux("list-sessions -F '#{session_id}'")).trim();
    await tmux(`new-window -d -t '${session}' -n '${created}' -c '${owned.ssh.directory}'`);
    await owned.observe();
    const added=(await tmux("list-windows -F '#{window_id}|#{window_name}'")).split('\n').find(line=>line.endsWith(`|${created}`))!.split('|')[0];
    await expect(owned.verifyWindowLifecycle()).rejects.toThrow('Owned tmux window create, rename and close were not observed');
    await tmux(`rename-window -t '${added}' '${renamed}'`);
    await owned.observe();
    await expect(owned.verifyWindowLifecycle()).rejects.toThrow('Owned tmux window create, rename and close were not observed');
    await tmux(`kill-window -t '${added}'`);
    await owned.verifyWindowLifecycle();
    // The original windows and panes were never touched.
    expect(owned.diagnostic().windows).toBe(2);
  } finally {
    await owned.stop();
  }
},60_000);

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux host readback refuses a rename that reached an original window and an original pane that was replaced',async()=>{
  const owned=await TmuxFixture.start();
  try {
    const tmux=hostTmux(owned);
    const [windowId,name,paneId]=(await tmux("list-windows -F '#{window_id}|#{window_name}|#{pane_id}'")).trim().split('\n')[0].split('|');
    // The app's Rename window on a window other than the one it added is not the lifecycle step; the name restored is accepted again.
    await tmux(`rename-window -t '${windowId}' 'renamed'`);
    await expect(owned.observe()).rejects.toThrow('Owned tmux original window changed');
    await tmux(`rename-window -t '${windowId}' '${name}'`);
    await owned.observe();
    // Same window id and name, but a new pane process: the original pane was lost.
    await tmux(`respawn-pane -k -t '${paneId}' 'exec sleep 3600'`);
    await expect(owned.observe()).rejects.toThrow('Owned tmux pane identity changed');
  } finally {
    await owned.stop();
  }
},60_000);

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux host readback requires the app-style split and a returned zoom on the original panes',async()=>{
  const owned=await TmuxFixture.start();
  try {
    const [,beta]=owned.metadata().windows;
    expect(beta.paneId).toMatch(/^%[0-9]{1,9}$/);
    const tmux=async(command:string)=>(await owned.ssh.client(true,`tmux -u -L default ${command}`)).finish('owned tmux window action',5000);
    // Nothing split yet: the readback refuses to call an untouched window a split one.
    await expect(owned.verifySplitAndZoom()).rejects.toThrow('Owned tmux split topology changed');
    // The exact commands the app sends for Split top/bottom and Zoom.
    await tmux(`split-window -d -v -t '${beta.paneId}' -c '${owned.ssh.directory}'`);
    await owned.verifySplitAndZoom();
    const added=(await tmux(`list-panes -t '=owned-tmux:1' -F '#{pane_id}'`)).split('\n').find(id=>id && id!==beta.paneId)!;
    // A zoom that was never toggled back is not the app's final state.
    await tmux(`resize-pane -Z -t '${added}'`);
    await expect(owned.verifySplitAndZoom()).rejects.toThrow('Owned tmux split and zoom were not observed');
    await tmux(`resize-pane -Z -t '${added}'`);
    await owned.verifySplitAndZoom();
    await expect(owned.verifyDetachedAndReattached()).rejects.toThrow('Owned tmux attach, detach and reattach were not observed');
    // The extra pane alone, with the original pane lost, is a changed topology.
    await tmux(`kill-pane -t '${beta.paneId}'`);
    await expect(owned.verifySplitAndZoom()).rejects.toThrow();
  } finally {
    await owned.stop();
  }
},60_000);

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux host readback requires a copy-mode copy of the first pane line, which the attached client receives over OSC 52',async()=>{
  const owned=await TmuxFixture.start();
  let client:OwnedProcess|undefined;
  try {
    const [alpha]=owned.metadata().windows;
    await expect(owned.verifyCopied()).rejects.toThrow('Owned tmux copy mode was not entered and left');
    client=await owned.ssh.client();
    await wait(()=>client!.stdout.includes(owned.ssh.prompt));
    // The app requests an xterm-256color terminal; the shortcut's prefix and `[` enter copy mode in the active pane.
    client.child.stdin!.write("export TERM=xterm-256color; exec tmux -u -L default attach-session -t '=owned-tmux'\n");
    await wait(()=>client!.stdout.includes(alpha.marker));
    client.child.stdin!.write('\x02[');
    await wait(async()=>{await owned.observe();return client!.stdout.includes('[0/0]');});
    await expect(owned.verifyCopied()).rejects.toThrow('Owned tmux copy mode was not entered and left');
    // The cursor starts below the marker; k moves onto it, V selects the line and Enter copies it and leaves copy mode.
    // Like the app's key presses, one at a time: a burst in one read is not a keystroke sequence to every tmux release.
    for(const key of ['k','V','\r']){client.child.stdin!.write(key);await Bun.sleep(150);}
    const copy=()=>/\x1b\]52;[a-z]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/.exec(client!.stdout)?.[1];
    await wait(()=>copy()!==undefined);
    // A selected line carries its newline.
    expect(Buffer.from(copy()!,'base64').toString()).toBe(`${alpha.marker}\n`);
    await wait(async()=>{try{await owned.verifyCopied();return true;}catch{return false;}});
  } finally {
    await client?.stop();
    await owned.stop();
  }
},60_000);

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux host readback requires the pinch zoom, unzoom and window swipes the default gestures send',async()=>{
  const owned=await TmuxFixture.start();
  try {
    const [,beta]=owned.metadata().windows;
    const tmux=hostTmux(owned);
    const step=async(command:string)=>{await tmux(command);await owned.observe();};
    const missing='Owned tmux pinch zoom, unzoom and two-finger window swipes were not observed';
    await expect(owned.verifyGestures()).rejects.toThrow(missing);
    // tmux refuses to zoom alpha's only pane, so the pinch needs the split the app made in beta. The app's own zoom of the added pane, toggled back, comes first.
    await tmux(`split-window -d -v -t '${beta.paneId}' -c '${owned.ssh.directory}'`);
    const added=(await tmux(`list-panes -t '=owned-tmux:1' -F '#{pane_id}'`)).split('\n').find(id=>id && id!==beta.paneId)!;
    await step("resize-pane -Z -t '=owned-tmux:0'");
    expect(owned.diagnostic().views).toEqual(['alpha']);
    await step("select-window -t '=owned-tmux:1'");
    await step(`resize-pane -Z -t '${added}'`);
    await step(`resize-pane -Z -t '${added}'`);
    await expect(owned.verifyGestures()).rejects.toThrow(missing);
    // The tmux client behind the app runs these for the default gestures: prefix z, n and p (n wraps from the last window to the first).
    await step("resize-pane -Z -t '=owned-tmux:1'");
    await expect(owned.verifyGestures()).rejects.toThrow(missing);
    await step("resize-pane -Z -t '=owned-tmux:1'");
    await step("next-window -t '=owned-tmux'");
    await expect(owned.verifyGestures()).rejects.toThrow(missing);
    await step("previous-window -t '=owned-tmux'");
    await owned.verifyGestures();
    expect(owned.diagnostic().views).toEqual(['alpha','beta','beta+zoom','beta','beta+zoom','beta','alpha','beta']);
    // Neither original window was replaced.
    expect(owned.metadata().windows.map(({name})=>name)).toEqual(['alpha','beta']);
  } finally {
    await owned.stop();
  }
},60_000);

for(const kind of ['tmux','rmux'] as const) {
  test.skipIf(process.platform!=='linux' || !process.env[muxVariable[kind]])(`owned ${kind} teardown detaches a running control-mode client through the server before retiring SSH`,async()=>{
    const owned=await TmuxFixture.start(undefined,undefined,kind);
    // Like the app's Jump binding, this control client is still attached and draining when teardown starts.
    const client=await owned.ssh.client(true,`${kind} -u -L default -C attach-session ${kind==='tmux'?'-f no-output,ignore-size ':''}-t '=${owned.name}'`);
    try {
      const deadline=performance.now()+5000;
      while(!client.stdout.includes('%session-changed')){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(25);}
      await owned.stop();
      // The server's detach ends the control client normally; an SSH signal would not report %exit.
      expect(await client.finish('owned tmux control client detached by teardown',5000)).toContain('%exit');
    } finally {
      await client.stop();
      await owned.stop();
    }
    await expect(owned.observe()).rejects.toThrow('Owned tmux server identity changed');
  },60_000);
}

for(const kind of ['tmux','rmux'] as const) {
  test.skipIf(process.platform!=='linux' || !process.env[muxVariable[kind]])(`owned ${kind} teardown retires a stalled owned client outside the SSH tree so the server still exits cleanly`,async()=>{
    const owned=await TmuxFixture.start(undefined,undefined,kind);
    // Outside the SSH tree and stopped, this owned tmux client can neither detach nor be retired with SSH.
    const client=new OwnedProcess(owned.ssh.ownedBinary(kind),['-u','-L','default','-C','attach-session','-t',`=${owned.name}`],owned.ssh.directory,owned.ssh.environment);
    try {
      const deadline=performance.now()+5000;
      while(!client.stdout.includes('%session-changed')){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(25);}
      process.kill(client.child.pid!,'SIGSTOP');
      await owned.stop();
      expect(client.child.signalCode).toBe('SIGKILL');
    } finally {
      await client.stop();
      await owned.stop();
    }
  },60_000);
}

// The real companion and tmux run under the fixture's own SSH environment, exactly as the app reaches them.
test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX || !process.env.LAZYSH_TEST_AGENT_BIN)('owned tmux Chat readback requires the confirmed draft in the original pane once',async()=>{
  const owned=await TmuxFixture.start(undefined,process.env.LAZYSH_TEST_AGENT_BIN);
  try {
    const {chat,windows}=owned.metadata();
    expect(chat).toBeDefined();
    const [alpha,beta]=windows;
    const type=async(window:number,text:string)=>{
      const shell=await owned.ssh.client(true,`tmux -L default send-keys -l -t '=owned-tmux:${window}' '${text.replaceAll("'","'\\''")}' && tmux -L default send-keys -t '=owned-tmux:${window}' Enter`);
      await shell.finish('owned tmux Chat keys',5000);
    };
    const settled=async(window:number,text:string)=>{
      const deadline=performance.now()+5000;
      for(;;) {
        const capture=await owned.ssh.client(true,`tmux -L default capture-pane -p -J -t '=owned-tmux:${window}'`);
        if((await capture.finish('owned tmux Chat capture',5000)).includes(text))return;
        expect(performance.now()).toBeLessThan(deadline);
        await Bun.sleep(25);
      }
    };
    const rejected='Owned tmux Chat input did not reach exactly the original pane once';
    // The companion in the fixture's environment reads the synthetic record the app will open.
    const read=await owned.ssh.client(true,`lazysh-agent transcript --agent claude --path '${chat!.transcript}' --offset 0 --limit 50`);
    expect(await read.finish('owned tmux companion read',5000)).toContain(chat!.record);
    await expect(owned.verifyChatInput()).rejects.toThrow(rejected);
    await type(beta.index,chat!.draft);await settled(beta.index,chat!.draft);
    await expect(owned.verifyChatInput()).rejects.toThrow(rejected);
    await type(alpha.index,chat!.draft);await settled(alpha.index,chat!.draft);
    await expect(owned.verifyChatInput()).rejects.toThrow(rejected);
  } finally {
    await owned.stop();
  }
},60_000);

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX || !process.env.LAZYSH_TEST_AGENT_BIN)('owned tmux Chat readback accepts the draft in the original pane alone',async()=>{
  const owned=await TmuxFixture.start(undefined,process.env.LAZYSH_TEST_AGENT_BIN);
  try {
    const {chat,windows}=owned.metadata();
    const shell=await owned.ssh.client(true,`tmux -L default send-keys -l -t '=owned-tmux:${windows[0].index}' '${chat!.draft.replaceAll("'","'\\''")}' && tmux -L default send-keys -t '=owned-tmux:${windows[0].index}' Enter`);
    await shell.finish('owned tmux Chat keys',5000);
    const deadline=performance.now()+5000;
    for(;;) {
      try{await owned.verifyChatInput();break;}
      catch(error){if(performance.now()>=deadline)throw error;await Bun.sleep(25);}
    }
  } finally {
    await owned.stop();
  }
},60_000);

// Separate cut-route owner in the same tmux job: the pinned tmux fixture behind a relay the host can cut.
test.skipIf(process.platform!=='linux' || process.env.LAZYSH_ANDROID_UI_TMUX!=='1')('actual Android app shows the lost-connection banner, retries a cut route, reattaches the same tmux pane and closes without reconnecting',async()=>{
  await androidLostConnectionAcceptance();
},610_000);

test('escape passthrough needs tmux 3.3 or later',()=>{
  for(const version of ['tmux 3.3','tmux 3.3a','tmux 3.4','tmux 3.10','tmux 4.0'])expect(tmuxPassthroughSupported(version)).toBe(true);
  for(const version of ['tmux 3.2a','tmux 3.0','tmux 2.9','tmux next-3.4','tmux'])expect(tmuxPassthroughSupported(version)).toBe(false);
});

// Only a server with allow-passthrough on forwards the wrapped sequence to its client, which an Android clipboard case needs from this fixture.
test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux forwards a DCS-wrapped OSC 52 printed in its beta shell to the attached client unwrapped',async()=>{
  const owned=await TmuxFixture.start();
  const [alpha,beta]=owned.metadata().windows;
  let client:OwnedProcess|undefined;
  try {
    client=await owned.ssh.client();
    await wait(()=>client!.stdout.includes(owned.ssh.prompt));
    client.child.stdin!.write("exec tmux -u -L default attach-session -t '=owned-tmux'\n");
    await wait(()=>client!.stdout.includes(alpha.marker));
    client.child.stdin!.write('\x021');
    await wait(()=>client!.stdout.includes(beta.marker));
    const copied=`OSC52_${owned.ssh.nonce}`;
    // The shell computes the base64, so the copied text never appears in the typed line.
    client.child.stdin!.write(`printf '\\033Ptmux;\\033\\033]52;c;%s\\007\\033\\\\' "$(printf %s ${copied} | base64)"\r`);
    await wait(()=>client!.stdout.includes(`\x1b]52;c;${Buffer.from(copied).toString('base64')}\x07`));
    expect(client.stdout.includes('\x1bPtmux;')).toBe(false);
  } finally {
    await client?.stop();
    await owned.stop();
  }
},60_000);

// The same tmux job: the pinned fixture, one saved-credential host, and two instrumentation processes with a host force-stop between them.
test.skipIf(process.platform!=='linux' || process.env.LAZYSH_ANDROID_UI_TMUX!=='1')('actual Android app restores the same tmux pane only on click after a force-stop and relaunch',async()=>{
  await androidForceStopRestoreAcceptance();
},1_200_000);

const codes=(text:string)=>Array.from(text,character=>String(character.codePointAt(0)));
test('the reporting agent key log admits each prompt once, typed or pasted, and no other key',()=>{
  const prompts=['hold ab12','send ab12','type ab12'];
  const typed=(prompt:string,enter='13')=>[...codes(prompt),enter],pasted=(prompt:string)=>['27',...codes(prompt),'27','13'];
  expect(reportingAgentKeysAre([...pasted(prompts[0]),...typed(prompts[1],'10'),...typed(prompts[2])],prompts)).toBe(true);
  const stray=[...pasted(prompts[0]),...typed(prompts[1]),...typed(prompts[2])];
  for(const keys of [stray.slice(0,-1),[...stray,'13'],[...stray,'27'],['27',...stray],[...typed(prompts[1]),...typed(prompts[0]),...typed(prompts[2])],[...typed(prompts[0]),...typed(prompts[0]),...typed(prompts[1]),...typed(prompts[2])]])
    expect(reportingAgentKeysAre(keys,prompts)).toBe(false);
  expect(reportingAgentKeysAre([],prompts)).toBe(false);
});

test('the reporting agent readback requires one logged, held, ended and shown delivery of each prompt',()=>{
  const {hold,sent,typed}=reportingAgentPrompts('ab12cd34ef56');
  expect([hold,sent,typed]).toEqual(['hold ab12cd34','send ab12cd34','type ab12cd34']);
  const prompts=[hold,sent,typed],log=['READY','SUBMIT '+hold,'HOLD','HOLD_ENDED','SUBMIT '+sent,'SUBMIT '+typed].join('\n'),keys=prompts.flatMap(prompt=>[...codes(prompt),'13']).join('\n');
  const pane=prompts.map(prompt=>`> ${prompt}`).join('\n');
  reportingAgentDeliveredOnce(log,keys,pane,prompts);
  expect(()=>reportingAgentDeliveredOnce(log.replace('HOLD_ENDED\n',''),keys,pane,prompts)).toThrow('did not log the prompts once, in order');
  expect(()=>reportingAgentDeliveredOnce(log+'\nSUBMIT '+sent,keys,pane,prompts)).toThrow('did not log the prompts once, in order');
  expect(()=>reportingAgentDeliveredOnce(log,keys+'\n13',pane,prompts)).toThrow('received a key other than its prompts');
  expect(()=>reportingAgentDeliveredOnce(log,keys,pane.replace(`> ${sent}`,''),prompts)).toThrow('does not show each prompt once');
  expect(()=>reportingAgentDeliveredOnce(log,keys,pane+`\n> ${sent}`,prompts)).toThrow('does not show each prompt once');
});

// The real stand-in agent reports to the real companion from a real tmux pane, as it will for the packaged app.
test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX || !process.env.LAZYSH_TEST_AGENT_BIN)('owned tmux reporting agent readback accepts the three deliveries once and refuses a stray key',async()=>{
  const owned=await TmuxFixture.start(undefined,process.env.LAZYSH_TEST_AGENT_BIN,'tmux',true);
  let client:OwnedProcess|undefined;
  try {
    const {agent,windows}=owned.metadata();
    expect(agent).toBeDefined();
    expect(windows.map(({name})=>name)).toEqual(['alpha','beta']);
    const keys=async(command:string)=>(await owned.ssh.client(true,command)).finish('owned tmux agent keys',5000);
    const target="-t '=owned-tmux:0'",tmux="tmux -L default";
    const log=()=>Bun.file(join(owned.ssh.directory,'agent.log')).text().catch(()=>'');
    // One display client, as the app's attached tab is.
    const shell=client=await owned.ssh.client();
    await wait(()=>shell.stdout.includes(owned.ssh.prompt));
    shell.child.stdin!.write("exec tmux -u -L default attach-session -t '=owned-tmux'\n");
    await wait(async()=>{await owned.observe();return owned.diagnostic().history.at(-1)===1;});
    // The first prompt typed, the second pasted (the app's Compose), the third typed again; the first holds its turn until the next prompt.
    await keys(`${tmux} send-keys -l ${target} '${agent!.hold}' && ${tmux} send-keys ${target} Enter`);
    await wait(async()=>(await log()).includes('\nHOLD\n'));
    await keys(`${tmux} set-buffer '${agent!.sent}' && ${tmux} paste-buffer -p ${target} && ${tmux} send-keys ${target} Enter`);
    await wait(async()=>(await log()).includes('HOLD_ENDED'));
    await keys(`${tmux} send-keys -l ${target} '${agent!.typed}' && ${tmux} send-keys ${target} Enter`);
    await wait(async()=>(await log()).includes('SUBMIT '+agent!.typed));
    // The companion's own state holds the report of this pane, readable by the app's companion over SSH.
    const reported=await keys('lazysh-agent --help >/dev/null && ls "$XDG_STATE_HOME/lazysh"');
    expect(reported).toContain('events.sqlite3');
    shell.child.stdin!.write('\x02d');
    await shell.finish('owned tmux prefix detach',5000);client=undefined;
    await owned.verifyReportingAgent();
    expect(owned.diagnostic().history).toEqual([0,1,0]);
    // A key from any other source, such as a view switch writing to the pane, is refused.
    await keys(`${tmux} send-keys ${target} x`);
    await wait(async()=>(await Bun.file(join(owned.ssh.directory,'agent.log.keys')).text()).endsWith('120\n'));
    await expect(owned.verifyReportingAgent()).rejects.toThrow('received a key other than its prompts');
  } finally {
    await client?.stop().catch(()=>{});
    await owned.stop();
  }
},90_000);
