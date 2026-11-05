import {expect,test} from 'bun:test';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {TmuxFixture,tmuxAttachHistoryVerified,tmuxClientCount,tmuxCommandFailure,tmuxDisplayClients,tmuxPaneRows,tmuxServerStatus,tmuxTeardownObservation} from './support/androidTmux';
import {listening,OwnedProcess} from './support/androidSsh';

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

// Real pinned tools are explicit; ordinary host checks never download or guess a binary.
test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned namespaced tmux survives a real SSH detach and reattaches the original panes',async()=>{
  const owned=await TmuxFixture.start();
  const [alpha,beta]=owned.metadata().windows;
  let client:OwnedProcess|undefined;
  try {
    expect(owned.metadata().windows.map(({index,name})=>[index,name])).toEqual([[0,'alpha'],[1,'beta']]);
    await expect(owned.verifyDetachedAndReattached()).rejects.toThrow('Owned tmux attach, detach and reattach were not observed');
    const wait=async(predicate:()=>boolean|Promise<boolean>)=>{
      const deadline=performance.now()+5000;
      while(!await predicate()){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(25);}
    };
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
