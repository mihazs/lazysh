import {expect,test} from 'bun:test';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {TmuxFixture,tmuxAttachHistoryVerified,tmuxClientCount,tmuxCopyModeVerified,tmuxCommandFailure,tmuxDisplayClients,tmuxPaneRows,tmuxPassthroughSupported,tmuxServerStatus,tmuxSplitRows,tmuxTeardownObservation,tmuxWindowLifecycle,tmuxWindowRows} from './support/androidTmux';
import {listening,OwnedProcess} from './support/androidSsh';
import {androidLostConnectionAcceptance,lostConnectionCase,lostConnectionControl,validateLostConnectionReport} from './support/androidLostConnection';
import {OwnedSshRelay} from '../apps/client/native-e2e/sshRelay';
import {connect,createServer} from 'node:net';

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
  const originals=[{windowId:'@1',name:'alpha'},{windowId:'@2',name:'beta'}],base='@1|alpha\n@2|beta';
  const fold=(text:string,seen?:Parameters<typeof tmuxWindowLifecycle>[2])=>tmuxWindowLifecycle(tmuxWindowRows(text),originals,seen);
  let seen=fold(base);
  expect(seen).toBeUndefined();
  seen=fold(`${base}\n@3|scratch`,seen);
  expect(seen).toEqual({windowId:'@3',names:['scratch'],closed:false});
  expect(fold(`${base}\n@3|scratch`,seen)).toBe(seen);
  seen=fold(`${base}\n@3|renamed`,seen);
  expect(seen?.names).toEqual(['scratch','renamed']);
  expect(fold(base,seen)).toEqual({windowId:'@3',names:['scratch','renamed'],closed:true});
  // A closed or renamed original, a second added window, a replaced or reappearing one: never the app's window.
  for(const text of ['@1|alpha','@1|alpha\n@2|renamed',`${base}\n@3|a\n@4|b`])expect(()=>fold(text)).toThrow(/Owned tmux (original window|window topology) changed/);
  expect(()=>fold(`${base}\n@4|b`,{windowId:'@3',names:['a'],closed:false})).toThrow('Owned tmux window topology changed');
  expect(()=>fold(`${base}\n@3|a`,{windowId:'@3',names:['a'],closed:true})).toThrow('Owned tmux window topology changed');
  for(const invalid of ['','private text','@3|bad name','@3|'+'x'.repeat(33),`${base}\n@3|a|private`])expect(()=>tmuxWindowRows(invalid)).toThrow('Owned tmux window topology changed');
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

// Real pinned tools are explicit; ordinary host checks never download or guess a binary.
test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned namespaced tmux survives a real SSH detach and reattaches the original panes',async()=>{
  const owned=await TmuxFixture.start();
  const [alpha,beta]=owned.metadata().windows;
  let client:OwnedProcess|undefined;
  try {
    expect(owned.metadata().windows.map(({index,name})=>[index,name])).toEqual([[0,'alpha'],[1,'beta']]);
    await expect(owned.verifyDetachedAndReattached()).rejects.toThrow('Owned tmux attach, detach and reattach were not observed');
    const clients=async(count:number)=>wait(async()=>{await owned.observe();return owned.diagnostic().history.at(-1)===count;});
    const attach=async(marker:string)=>{
      const shell=await owned.ssh.client();
      await wait(()=>shell.stdout.includes(owned.ssh.prompt));
      shell.child.stdin!.write("exec tmux -u -L default attach-session -t '=owned-tmux'\n");
      await wait(()=>shell.stdout.includes(marker));
      return shell;
    };
    client=await attach(alpha.marker);await clients(1);
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
    expect(owned.diagnostic()).toEqual({schemaVersion:1,history:[0,1,0,1,0],windows:2,server:{state:'running',exit:null,signal:'none'}});
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
  } finally {
    await client?.stop();
    await owned.stop();
  }
  await expect(owned.observe()).rejects.toThrow('Owned tmux server identity changed');
  expect(await listening(owned.ssh.port)).toBe(false);
  await expect(stat(owned.ssh.directory)).rejects.toMatchObject({code:'ENOENT'});
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

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux teardown detaches a running control-mode client through the server before retiring SSH',async()=>{
  const owned=await TmuxFixture.start();
  // Like the app's Jump binding, this control client is still attached and draining when teardown starts.
  const client=await owned.ssh.client(true,"tmux -u -L default -C attach-session -f no-output,ignore-size -t '=owned-tmux'");
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

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux teardown retires a stalled owned client outside the SSH tree so the server still exits cleanly',async()=>{
  const owned=await TmuxFixture.start();
  // Outside the SSH tree and stopped, this owned tmux client can neither detach nor be retired with SSH.
  const client=new OwnedProcess(join(owned.ssh.directory,'bin/tmux'),['-u','-L','default','-C','attach-session','-t','=owned-tmux'],owned.ssh.directory,owned.ssh.environment);
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
