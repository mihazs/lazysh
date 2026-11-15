import {expect,test} from 'bun:test';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {TmuxFixture,tmuxAttachHistoryVerified,tmuxChatDeliveredOnce,tmuxClientCount,tmuxCommandFailure,tmuxDisplayClients,tmuxPaneRows,tmuxServerStatus,tmuxTeardownObservation,tmuxWindowLifecycle,tmuxWindowRows} from './support/androidTmux';
import {listening,OwnedProcess,SshFixture} from './support/androidSsh';
import {androidLostConnectionAcceptance,lostConnectionCase,lostConnectionControl,validateLostConnectionReport} from './support/androidLostConnection';
import {OwnedSshRelay} from '../apps/client/native-e2e/sshRelay';
import {connect,createServer} from 'node:net';import {reportingAgentDeliveredOnce,reportingAgentKeysAre,reportingAgentPrompts} from './support/androidTmuxAgent';

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
  await expect(TmuxFixture.start('/usr/bin/tmux','lazysh-agent')).rejects.toThrow('Explicit current-source companion required');
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

test.skipIf(process.platform!=='linux' || !process.env.LAZYSH_TEST_TMUX)('owned tmux host readback requires the app-style create, rename and close of one added window',async()=>{
  const owned=await TmuxFixture.start();
  try {
    const tmux=async(command:string)=>(await owned.ssh.client(true,`tmux -u -L default ${command}`)).finish('owned tmux window action',5000);
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
  const owned=await TmuxFixture.start(undefined,process.env.LAZYSH_TEST_AGENT_BIN,true);
  let client:OwnedProcess|undefined;
  try {
    const {agent,windows}=owned.metadata();
    expect(agent).toBeDefined();
    expect(windows.map(({name})=>name)).toEqual(['alpha','beta']);
    const wait=async(predicate:()=>boolean|Promise<boolean>)=>{
      const deadline=performance.now()+10_000;
      while(!await predicate()){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(25);}
    };
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
