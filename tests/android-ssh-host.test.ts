import {expect,test} from 'bun:test';
import {chmod,link,lstat,mkdir,mkdtemp,readFile,realpath,rm,stat,symlink,truncate,unlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {SshFixture,listening,androidSshAcceptance,androidSshCleanup,OwnedProcess,checkRawReceiverIdentity,recordedCompanionBytes,prepareRecordedConversation,IME_TRANSACTION_WIRE} from './support/androidSsh';
import {HerdrFixture,herdrTools} from './support/androidHerdr';
import {TmuxFixture} from './support/androidTmux';
import {installedCompanion,type PublishedCompanion} from '../apps/client/published-native-e2e/release';
import {observeAndroidMoshBackground} from './support/androidMoshBackground';
import {sshCommand,receiverProbeErrors} from './support/sshFixture';
import {identity,reportOwnedTeardownFailure} from './support/ownedProcess';

test.skipIf(process.platform!=='linux')('actual owned OpenSSH authenticates only its ephemeral key and emits non-echoable shell proof',async()=>{
  const fixture=await SshFixture.start();
  const port=fixture.port;
  try {
    expect((await stat(fixture.directory)).mode&0o777).toBe(0o700);
    expect(await readFile(join(fixture.directory,'sshd_config'),'utf8')).toContain('timeout --kill-after=1s 90s');
    expect((await stat(join(fixture.directory,'user'))).mode&0o777).toBe(0o600);
    const client=await fixture.client();
    expect(fixture.challenge).not.toContain(fixture.expected);
    client.child.stdin!.end(`${fixture.challenge}\nexit\n`);
    const output=await client.finish('actual SSH shell',5000);
    expect(output).toContain(fixture.prompt);
    expect(output).toContain(fixture.expected);
    const trustOption=client.child.spawnargs.find(value=>value.startsWith('UserKnownHostsFile='));
    expect(trustOption).toBeDefined();
    const trust=trustOption!.slice('UserKnownHostsFile='.length);
    expect(trust.startsWith(`${fixture.directory}/`)).toBe(true);
    expect((await stat(trust)).mode&0o777).toBe(0o600);
    const pin=await readFile(trust);
    await chmod(trust,0o400);
    const rejected=await fixture.client(false);
    expect(await readFile(trust)).toEqual(pin);
    expect((await stat(trust)).mode&0o777).toBe(0o400);
    await expect(rejected.finish('no ephemeral credential',5000)).rejects.toThrow('Owned fixture failed: no ephemeral credential');
  } finally {await fixture.stop();}
  expect(await listening(port)).toBe(false);
},15_000);

async function verifyCompanionFixture(privateTtyGroup:boolean) {
  const fixture=await SshFixture.start(undefined,{companion:true,privateTtyGroup});
  try {
    expect(await readFile(join(fixture.directory,'sshd_config'),'utf8')).toContain('timeout --kill-after=1s 600s');
    const command=await fixture.client(true,'printf "%s\\n" "$HOME" "$XDG_DATA_HOME" "$LAZYSH_STATE_DIR"; if command -v lazysh-agent >/dev/null 2>&1; then exit 1; fi');
    expect((await command.finish('owned companion exec environment',5000)).trim().split('\n')).toEqual([fixture.directory,join(fixture.directory,'data'),join(fixture.directory,'state')]);
    const bytes=Buffer.from(`OWNED-SFTP:${fixture.nonce}`),source=join(fixture.directory,'source'),returned=join(fixture.directory,'returned');
    await writeFile(source,bytes,{mode:0o600,flag:'wx'});
    const transfer=await fixture.sftp();
    transfer.child.stdin!.end(`put ${source} upload\nget upload ${returned}\nrm upload\nbye\n`);
    await transfer.finish('owned companion SFTP roundtrip',5000);
    expect(await readFile(returned)).toEqual(bytes);
    const client=await fixture.client();
    client.child.stdin!.end(`${fixture.challenge}\nexit\n`);
    const output=await client.finish('owned long-lived companion shell',5000);
    expect(output.includes(fixture.prompt) && output.includes(fixture.expected)).toBe(true);
  } finally {await fixture.stop();}
  expect(await listening(fixture.port)).toBe(false);
  await expect(stat(fixture.directory)).rejects.toMatchObject({code:'ENOENT'});
}

test.skipIf(process.platform!=='linux')('companion fixture isolates exec, SFTP and interactive shell without preinstalled tools',()=>verifyCompanionFixture(false),15_000);

test.skipIf(process.platform!=='linux')('installed companion evidence rejects wrong bytes, public mode, links and staging residue',async()=>{
  const fixture=await SshFixture.start(undefined,{companion:true});
  const parent=join(fixture.directory,'data/lazysh/companion'),path=join(parent,'lazysh-agent');
  const bytes=Buffer.from("#!/bin/sh\nprintf 'lazysh-agent 1.2.3\\n'\n");
  const evidence:PublishedCompanion={releaseId:1,assetId:2,version:'1.2.3',source:'a'.repeat(40),name:'owned-test',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  try {
    await mkdir(parent,{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o700,flag:'wx'});
    const first=await installedCompanion(fixture,evidence);
    expect((await installedCompanion(fixture,evidence)).identity).toEqual(first.identity);
    await expect(installedCompanion(fixture,{...evidence,sha256:'0'.repeat(64)})).rejects.toThrow();
    await chmod(path,0o744);await expect(installedCompanion(fixture,evidence)).rejects.toThrow();await chmod(path,0o700);
    const alternate=join(parent,'owned-version');await writeFile(alternate,bytes,{mode:0o700,flag:'wx'});
    await unlink(path);await symlink(alternate,path);await expect(installedCompanion(fixture,evidence)).rejects.toThrow();
    expect(await readFile(alternate)).toEqual(bytes);
    await unlink(path);await writeFile(path,bytes,{mode:0o700,flag:'wx'});
    await mkdir(join(fixture.directory,'.lazysh-install-owned'),{mode:0o700});
    await expect(installedCompanion(fixture,evidence)).rejects.toThrow();
  } finally {await fixture.stop();}
},15_000);

test.skipIf(process.platform!=='linux')('owned server teardown retires an admitted interactive shell and client',async()=>{
  const fixture=await SshFixture.start();
  const client=await fixture.client();
  let shellPid=0;
  try {
    client.child.stdin!.write(`printf 'OWNED:%s\\n' "$$"; sleep 120\n`);
    const deadline=performance.now()+3000;
    while(!shellPid) {
      const match=client.stdout.match(/OWNED:([0-9]+)/);
      if(match)shellPid=Number(match[1]);
      else {expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(10);}
    }
    await fixture.stop();
    await expect(client.finish('server disconnect',3000)).rejects.toThrow('Owned fixture failed: server disconnect');
    const stopped=()=>{try{process.kill(shellPid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}};
    const retired=performance.now()+3000;
    while(!stopped()&&performance.now()<retired)await Bun.sleep(10);
    expect(stopped()).toBe(true);
  } finally {await client.stop();await fixture.stop();}
},10_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_SSH!=='1')('Android denied notification permission preserves SSH and opens system settings',async()=>{
  await androidSshAcceptance(undefined,undefined,false,false,false,false,false,false,false,false,undefined,true);
},610_000);

test.skipIf(process.env.LAZYSH_TEST_SSH_USER_NAMESPACE!=='1')('owned namespaced SSH preserves host groups and rejects lost supervisor ownership',async()=>{
  const groups=await readFile('/etc/group');
  await verifyCompanionFixture(true);
  const fixture=await SshFixture.start(undefined,{privateTtyGroup:true});
  try {
    const client=await fixture.client();
    client.child.stdin!.end(`${fixture.challenge}\nexit\n`);
    const output=await client.finish('namespaced SSH challenge',5000);
    expect(output.includes(fixture.prompt)).toBe(true);
    expect(output.includes(fixture.expected)).toBe(true);
  } finally {await fixture.stop();}
  expect(await listening(fixture.port)).toBe(false);
  expect(await readFile('/etc/group')).toEqual(groups);
  const lost=await SshFixture.start(undefined,{privateTtyGroup:true});
  await lost.daemon.stop();
  await expect(lost.stop()).rejects.toThrow('Owned SSH root identity unavailable');
  expect(await listening(lost.port)).toBe(false);
  await expect(stat(lost.directory)).rejects.toMatchObject({code:'ENOENT'});
},15_000);

test.skipIf(process.env.LAZYSH_TEST_SSH_USER_NAMESPACE!=='1')('owned namespaced SSH Mosh witness attributes both receipts to the same live shell and UDP socket',async()=>{
  const binary=await realpath(process.env.LAZYSH_NATIVE_MOSH_SERVER??(await sshCommand('locate owned Mosh witness binary','sh',['-c','command -v mosh-server'])).trim());
  const fixture=await SshFixture.start(undefined,{privateTtyGroup:true,moshBinary:binary,observeMoshBootstraps:true});
  const observer=observeAndroidMoshBackground(fixture);
  let client:OwnedProcess|undefined;
  try {
    const output=`i=0; while test $i -lt 263; do printf '%01000d' 0; i=$((i+1)); done; printf '%s\\n' "$i" >${fixture.directory}/background-samples; `;
    const script=['before','after'].map(part=>(part==='after'?output:'')+`printf '%s %s\\n' "$$" "$(awk '{print $22}' /proc/$$/stat)" >${fixture.directory}/background-${part}.tmp; mv ${fixture.directory}/background-${part}.tmp ${fixture.directory}/background-${part}; while ! test -f ${fixture.directory}/background-${part}-ack; do sleep .1; done;`).join(' ')+' sleep 90';
    const command="'mosh-server' new -s -c 256 -p 60000:61000 -l 'LC_ALL=C.UTF-8' -- /bin/sh -c '"+script.replaceAll("'","'\\''")+"'";
    const bootstrap=await fixture.client(true,command);
    const connect=(await bootstrap.finish('owned Mosh witness bootstrap',5000)).match(/MOSH CONNECT ([0-9]+) ([A-Za-z0-9+/=]+)/);
    expect(connect!==null).toBe(true);
    client=new OwnedProcess('/usr/bin/script',['-q','-e','-c',`stty rows 24 cols 80; exec mosh-client 127.0.0.1 ${connect![1]}`,'/dev/null'],undefined,{...process.env,TERM:'xterm-256color',MOSH_KEY:connect![2]},false);
    const deadline=performance.now()+5000;
    while(!await stat(join(fixture.directory,'background-after-ack')).catch(()=>false)) {
      observer.check();
      expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(10);
    }
    await observer.assertVerified();
    await writeFile(join(fixture.directory,'mosh-bootstraps'),'bootstrap\nbootstrap\n');
    await expect(observer.assertVerified()).rejects.toThrow('Owned Mosh bootstrapped again');
  } finally {await observer.stop();try{await fixture.stop();}finally{await client?.stop();}}
},15_000);

test.skipIf(process.platform!=='linux')('lost foreground sshd ownership fails explicitly while still removing its private directory',async()=>{
  const fixture=await SshFixture.start();
  await fixture.daemon.stop();
  await expect(fixture.stop()).rejects.toThrow('Owned SSH root identity unavailable');
  await expect(stat(fixture.directory)).rejects.toMatchObject({code:'ENOENT'});
},5000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_SSH!=='1')('actual Android app performs explicit trust and authenticated interactive SSH',async()=>{
  await androidSshAcceptance();
},610_000);

test.skipIf(process.env.LAZYSH_TEST_SSH_USER_NAMESPACE!=='1' || !process.env.LAZYSH_TEST_AGENT_BIN)('owned namespaced SSH preflights synthetic recorded Codex and OpenCode conversations',async()=>{
  const root=join(import.meta.dir,'..'),source=process.env.LAZYSH_TEST_AGENT_BIN;
  const bytes=await recordedCompanionBytes(source),fixture=await SshFixture.start(undefined,{companion:true});
  let recorded:Awaited<ReturnType<typeof prepareRecordedConversation>>|undefined,primary=false;
  try {
    recorded=await prepareRecordedConversation(fixture,root,bytes);
    const specification=JSON.parse(await readFile(join(root,'apps/agent/tests/fixtures/recorded-conversations.json'),'utf8'));
    expect(recorded.metadata.provenance).toBe('synthetic');
    expect(recorded.metadata.sources.map(item=>item.agent).join(',')).toBe('codex,opencode,opencode');
    expect(JSON.stringify(recorded.metadata.sources.map(item=>item.sessionId))===JSON.stringify([specification.codexThreadId,specification.opencodeSessions.v1,specification.opencodeSessions.v2])).toBe(true);
    expect((await recordedCompanionBytes(source)).equals(bytes)).toBe(true);
  } catch(error){primary=true;throw error;}
  finally {
    await androidSshCleanup(primary,[['fixture-file',async()=>{await recorded?.verify();}],['SSH',()=>fixture.stop()]]);
  }
  expect(await listening(fixture.port)).toBe(false);
  await expect(stat(fixture.directory)).rejects.toMatchObject({code:'ENOENT'});
},65_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_RECORDED!=='1')('actual Android recorded Codex and OpenCode conversations preserve their original SSH terminal',async()=>{
  await androidSshAcceptance(undefined,undefined,false,false,false,false,false,false,false,true);
},610_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_DPAD!=='1')('actual Android packaged D-pad pans one held native pointer and stops its original SSH receiver',async()=>{
  await androidSshAcceptance(undefined,undefined,false,false,false,false,false,false,true);
},610_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_IME!=='1')('actual Android packaged terminal sends native IME transactions once through its original SSH receiver',async()=>{
  await androidSshAcceptance(undefined,undefined,false,false,false,false,false,true);
},610_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_ATTACHMENTS!=='1')('actual Android manual Mosh attachment uploads a large valid PNG and preserves a pre-existing destination',async()=>{
  await androidSshAcceptance(undefined,undefined,false,false,false,false,true);
},610_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_SSH!=='1')('actual Android Mosh survives busy background with the same owned shell and releases its last worker',async()=>{
  await androidSshAcceptance(undefined,undefined,false,true);
},610_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_COMPANION!=='1')('actual Android app installs and reuses the verified public companion through its UI',async()=>{
  await androidSshAcceptance(undefined,undefined,true);
},610_000);

// The owned fixture stops after the acceptance; a cleanup failure never replaces its original error.
async function ownedAndroidAcceptance(stage:'Herdr'|'tmux',owned:{stop():Promise<void>},run:()=>Promise<void>) {
  let primary=false;
  try {await run();}
  catch(error){primary=true;throw error;}
  finally {await androidSshCleanup(primary,[[stage,()=>owned.stop()]]);}
}

// Real tools are explicit; ordinary host checks never download or guess a binary.
for(const mosh of [false,true]) {
test.skipIf(!process.env.LAZYSH_TEST_HERDR || !process.env.LAZYSH_TEST_AGENT_BIN || !process.env.LAZYSH_TEST_RECEIVER_BIN || (mosh && !process.env.LAZYSH_NATIVE_MOSH_SERVER))(`owned Herdr ${mosh?'Mosh':'SSH'} exec reads its real companion transcript in the private namespace`,async()=>{
  const owned=await HerdrFixture.start(herdrTools(),mosh?process.env.LAZYSH_NATIVE_MOSH_SERVER:undefined);
  let primary=false;
  try {
    if(mosh) {
      const server=await owned.ssh.client(true,'mosh-server --version');
      expect(await server.finish('owned copied Mosh executable',5000)).toContain('mosh-server (mosh 1.4.0)');
    }
    const companion=await owned.ssh.client(true,'lazysh-agent transcript --agent claude --path='+owned.transcript+' --offset 0');
    const value=JSON.parse(await companion.finish('owned real companion transcript',5000));
    expect(value.schemaVersion).toBe(1);expect(value.agent).toBe('claude');expect(value.messages).toHaveLength(1);
    expect(JSON.stringify(value.messages)).toContain(owned.record);
    const listing=await owned.ssh.client(true,'herdr session list --json');
    expect(await listing.finish('owned real Herdr discovery',5000)).toContain(owned.name);
    expect(await readFile(join(owned.ssh.directory,'sshd_config'),'utf8')).toContain('timeout --kill-after=1s 90s');
    const snapshot=JSON.parse(await owned.run(['api','snapshot'])).result.snapshot;
    const {agent,history}=owned.metadata();
    const remote=await owned.ssh.client(true,`herdr --session '${owned.name}' api snapshot`);
    const remoteSnapshot=JSON.parse(await remote.finish('owned SSH-visible Herdr snapshot',5000)).result?.snapshot;
    expect(remoteSnapshot?.focused_pane_id===agent.paneId
      && remoteSnapshot?.agents?.length===1 && remoteSnapshot?.panes?.some((pane:Record<string,unknown>)=>
        pane.pane_id===agent.paneId && pane.terminal_id===agent.terminalId
        && pane.workspace_id===agent.workspaceId && pane.tab_id===agent.tabId)
      && remoteSnapshot.agents[0].terminal_id===agent.terminalId).toBe(true);
    const probe=await owned.ssh.client(true,`herdr --session '${owned.name}' api guarded`);
    probe.child.stdin!.end(JSON.stringify({id:'guard',method:'lazysh.guard.cancel_preparation',
      params:{boot:'0'.repeat(64),ownership:'0'.repeat(64),preparation:0}}));
    await expect(probe.finish('owned SSH-visible guard preflight',3000))
      .rejects.toThrow('Owned fixture failed: owned SSH-visible guard preflight; exit=1');
    let invalid=false;
    try {const response=JSON.parse(probe.stderr);invalid=response.id==='guard' && response.error?.code==='guard_invalid';}catch{/* Closed unavailable, never retain peer output. */}
    expect(probe.stdout==='').toBe(true);
    expect(invalid).toBe(true);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({agent:'codex',agent_status:'unknown',terminal_id:agent.terminalId,
      workspace_id:agent.workspaceId,tab_id:agent.tabId,pane_id:agent.paneId});
    expect(snapshot.panes.find((pane:{pane_id:string})=>pane.pane_id===agent.paneId)).toMatchObject({
      terminal_id:agent.terminalId,workspace_id:agent.workspaceId,tab_id:agent.tabId});
    const reports=await owned.ssh.client(true,'lazysh-agent snapshot --limit 50');
    expect(JSON.parse(await reports.finish('owned empty companion reports',5000))).toEqual({schemaVersion:1,sessions:[]});
    expect(history?.paneId).not.toBe(agent.paneId);
    expect(snapshot.focused_pane_id).toBe(agent.paneId);
    expect(await owned.history()).toMatchObject({offset:0,newTail:true});
    await expect(owned.expectHistoryScrolled()).rejects.toThrow('Owned remote history did not scroll and restore');
    // This controls only the real host readback contract, never the native swipe oracle.
    await owned.run(['tab','focus',history!.tabId]);
    const client=new OwnedProcess('/usr/bin/script',['-q','-e','-f','-c',
      `stty rows 24 cols 80; exec '${owned.ssh.directory}/bin/herdr' --session '${owned.name}'`,'/dev/null'],
      owned.ssh.directory,owned.ssh.environment,false);
    let attachPrimary=false;
    try {
      const deadline=performance.now()+3000;
      while((await owned.history()).rows!==23) {
        expect(performance.now()).toBeLessThan(deadline);
        if(!await client.liveIdentity())throw new Error('Owned Herdr attach client closed');
        await Bun.sleep(10);
      }
      expect(await owned.history(8)).toMatchObject({offset:8,newTail:false});
      await owned.run(['tab','focus',agent.tabId]);await owned.expectHistoryScrolled();
      await owned.run(['tab','focus',history!.tabId]);
      await expect(owned.expectHistoryScrolled()).rejects.toThrow('Owned remote history did not scroll and restore');
      expect(await owned.history()).toMatchObject({offset:8,newTail:false});
    } catch(error){attachPrimary=true;throw error;}
    finally {
      try{await client.stop();}
      catch(error){
        await reportOwnedTeardownFailure(client,'attach-stop');
        if(!attachPrimary)throw error;
        try{console.error('Owned attach cleanup failed after primary failure');}catch{/* Preserve primary. */}
      }
    }
    expect(await owned.history()).toMatchObject({offset:8,newTail:false});
    await owned.run(['tab','focus',agent.tabId]);await owned.expectHistoryScrolled();
    await expect(owned.history(513)).rejects.toThrow('Owned history request invalid');
    await owned.expectBytes(Buffer.alloc(0));
  } catch(error){primary=true;throw error;}
  finally {
    try{await owned.stop();}
    catch(error){
      if(!primary)throw error;
      try{console.error('Owned Herdr fixture cleanup failed after primary failure');}catch{/* Preserve primary. */}
    }
  }
  expect(await listening(owned.ssh.port)).toBe(false);
  await expect(stat(owned.ssh.directory)).rejects.toMatchObject({code:'ENOENT'});
},15_000);
}

// A real outer mouse packet must reach the independently observed raw history pane.
// These coordinates compare the phone's candidate row with a central pane-body row;
// neither the synthetic agent report nor a local wheel counter proves this route.
test.skipIf(!process.env.LAZYSH_TEST_HERDR || !process.env.LAZYSH_TEST_AGENT_BIN || !process.env.LAZYSH_TEST_RECEIVER_BIN)
  .each([{cols:50,row:6},{cols:50,row:12},{cols:80,row:6},{cols:80,row:12}])('owned guarded Herdr mouse route at %j',async({cols,row})=>{
  const owned=await HerdrFixture.start(herdrTools());
  let client:OwnedProcess|undefined,primary:unknown;
  // Begin closed capture recognizer: never retain PTY text or guard-frame bytes.
  const capture=(()=>{
    const sequences=['\x1b[?1000h','\x1b[?1000l','\x1b[?1002h','\x1b[?1002l','\x1b[?1003h','\x1b[?1003l'];
    const modes:(boolean|null)[]=[null,null,null];
    let prefix='',available=true;
    const write=(chunk:Buffer)=>{
      try {
        if(!Buffer.isBuffer(chunk)){available=false;prefix='';return;}
        for(const byte of chunk){
          const next=prefix+String.fromCharCode(byte),matched=sequences.indexOf(next);
          if(matched>=0){modes[Math.floor(matched/2)]=matched%2===0;prefix='';}
          else prefix=sequences.some(sequence=>sequence.startsWith(next))?next:byte===27?'\x1b':'';
        }
      } catch {available=false;prefix='';}
    };
    return {write,enabled:()=>available && modes.some(mode=>mode===true),
      sample:()=>({state:!available?'unavailable':modes.some(mode=>mode!==null)?'observed':'unknown',
        normal:modes[0],drag:modes[1],motion:modes[2]})};
  })();
  // End closed capture recognizer.
  try {
    const {history}=owned.metadata();
    await owned.run(['tab','focus',history!.tabId]);
    client=new OwnedProcess('/usr/bin/script',['-q','-e','-f','-c',
      `stty rows 24 cols ${cols}; exec '${owned.ssh.directory}/bin/herdr' --session '${owned.name}' --guarded-attach`,'/dev/null'],
      owned.ssh.directory,owned.ssh.environment,false);
    client.child.stdout!.on('data',capture.write);
    const deadline=performance.now()+3000;
    while(true){
      if(!await client.liveIdentity())throw new Error('Owned mouse client retired before admission');
      const sample=await owned.history();
      // No raw PTY output is retained. Measured history capacity admits row 12
      // inside any contiguous body interval within the actual 24-row terminal.
      if(capture.enabled() && sample.rows>0 && sample.rows<24 && 12>24-sample.rows && 12<=sample.rows)break;
      if(performance.now()>=deadline)throw new Error('Owned mouse capture or history geometry unavailable');
      await Bun.sleep(10);
    }
    expect(await owned.history()).toMatchObject({offset:0,newTail:true});
    client.child.stdin!.write(`\x1b[<64;${Math.ceil(cols/2)};${row}M`);
    while(true){
      const sample=await owned.history();
      if(sample.offset>0 && !sample.newTail && sample.oldRows>0)break;
      if(performance.now()>=deadline){
        if(row===6)break; // Candidate chrome/header hit is an observation, never a required pane scroll.
        throw new Error('Owned body mouse packet did not advance remote history');
      }
      if(!await client.liveIdentity())throw new Error('Owned mouse client retired during observation');
      await Bun.sleep(10);
    }
    // history() additionally verifies the unchanged receiver birth and zero bytes.
    console.error('Owned mouse observation '+JSON.stringify({cols,row,capture:capture.sample(),history:await owned.historyDiagnostic()}));
    await owned.expectBytes(Buffer.alloc(0));
  } catch(error){primary=error;
    try{console.error('Owned mouse failure '+JSON.stringify({cols,row,capture:capture.sample(),history:await owned.historyDiagnostic()}));}catch{/* Keep original verdict. */}
  } finally {
    try{client?.child.stdout?.off('data',capture.write);}catch{primary??=new Error('Owned capture observer cleanup unavailable');}
    const failures=await Promise.allSettled([client?.stop()]);
    try{await owned.stop();}catch(error){primary??=error;}
    for(const result of failures)if(result.status==='rejected')primary??=result.reason;
  }
  if(primary)throw primary;
  expect(await listening(owned.ssh.port)).toBe(false);
  await expect(stat(owned.ssh.directory)).rejects.toMatchObject({code:'ENOENT'});
},15_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_HERDR!=='1').each(['ssh','mosh'] as const)('actual Android WebView explicitly confirms and sends to its original guarded Herdr receiver over %s',async transport=>{
  const moshBinary=transport==='mosh'?process.env.LAZYSH_NATIVE_MOSH_SERVER:undefined;
  if(transport==='mosh' && !moshBinary)throw new Error('Explicit pinned Mosh server required for Android Herdr entry');
  const owned=await HerdrFixture.start(herdrTools(),moshBinary);
  await ownedAndroidAcceptance('Herdr',owned,()=>androidSshAcceptance(undefined,owned,false,false,transport==='mosh'));
},610_000);


test.skipIf(process.env.LAZYSH_ANDROID_UI_HERDR_NAVIGATION!=='1')('actual Android two-display stock Herdr navigation keeps the selected display and sends zero receiver bytes',async()=>{
  const owned=await HerdrFixture.start(herdrTools(),undefined,true);
  await ownedAndroidAcceptance('Herdr',owned,()=>androidSshAcceptance(undefined,owned,false,false,false,true));
},610_000);

// Separate CI owner: only the pinned tmux fixture and packaged UI decide this verdict.
test.skipIf(process.env.LAZYSH_ANDROID_UI_TMUX!=='1')('actual Android tmux discovery, window controls, Jump To and detach keep the original remote panes',async()=>{
  const owned=await TmuxFixture.start();
  await ownedAndroidAcceptance('tmux',owned,()=>androidSshAcceptance(undefined,undefined,false,false,false,false,false,false,false,false,owned));
},610_000);

test.skipIf(!process.env.LAZYSH_TEST_HERDR || !process.env.LAZYSH_TEST_AGENT_BIN || !process.env.LAZYSH_TEST_RECEIVER_BIN)('owned shared-navigation fixture binds three distinct zero-byte receiver identities',async()=>{
  const owned=await HerdrFixture.start(herdrTools(),undefined,true);
  try {
    expect(await readFile(join(owned.ssh.directory,'sshd_config'),'utf8')).toContain('timeout --kill-after=1s 600s');
    const {navigation}=owned.metadata();expect(navigation).toBeDefined();
    const targets=[navigation!.source,navigation!.shell,navigation!.agent];
    expect(new Set(targets.map(target=>target.terminalId)).size).toBe(3);
    expect(new Set(targets.map(target=>target.paneId)).size).toBe(3);
    expect(new Set(targets.map(target=>target.marker)).size).toBe(3);
    const snapshot=JSON.parse(await owned.run(['api','snapshot'])).result.snapshot;
    const metadata=owned.metadata(),sourcePane=snapshot.panes.find((pane:Record<string,unknown>)=>pane.pane_id===metadata.agent.paneId && pane.terminal_id===metadata.agent.terminalId);
    expect(metadata.agentContext).toBe([snapshot.workspaces.find((workspace:Record<string,unknown>)=>workspace.workspace_id===metadata.agent.workspaceId).label,snapshot.tabs.find((tab:Record<string,unknown>)=>tab.tab_id===metadata.agent.tabId && tab.workspace_id===metadata.agent.workspaceId).label,sourcePane.cwd].join(' / '));
    expect(snapshot.panes).toHaveLength(3);expect(snapshot.agents).toHaveLength(2);
    for(const target of targets)expect(snapshot.panes.some((pane:Record<string,unknown>)=>pane.pane_id===target.paneId&&pane.terminal_id===target.terminalId&&pane.workspace_id===target.workspaceId&&pane.tab_id===target.tabId)).toBe(true);
    await owned.expectNavigationBytes();
  } finally {await owned.stop();}
  await expect(stat(owned.ssh.directory)).rejects.toMatchObject({code:'ENOENT'});
},20_000);



test.skipIf(process.platform!=='linux' || process.env.LAZYSH_TEST_SSH_USER_NAMESPACE!=='1' || !process.env.LAZYSH_TEST_RECEIVER_BIN)('owned namespaced SSH raw receiver root rejects the old namespace and admits exact delivery',async()=>{
  const source=process.env.LAZYSH_TEST_RECEIVER_BIN!;
  const image=await lstat(source),bytes=await readFile(source);
  expect(await realpath(source)===source).toBe(true);
  const sourceAdmitted=image.isFile() && image.uid===process.getuid?.() && (image.mode&0o100)!==0 && (image.mode&0o022)===0 && bytes.length<1024*1024;
  expect(sourceAdmitted).toBe(true);
  const hash=createHash('sha256').update(bytes).digest('hex');
  const groups=await readFile('/etc/group');
  for(const ownedReceiverRoot of [false,true]) {
    const fixture=await SshFixture.start(undefined,{privateTtyGroup:true,ownedReceiverRoot});
    let client:OwnedProcess|undefined,primary:unknown;
    try {
      const config=await readFile(join(fixture.directory,'sshd_config'),'utf8');
      expect(config).toContain(`timeout --kill-after=1s ${ownedReceiverRoot?600:90}s`);
      expect(config).not.toContain(`timeout --kill-after=1s ${ownedReceiverRoot?90:600}s`);
      const binary=join(fixture.directory,'receiver'),output=join(fixture.directory,'raw');
      await writeFile(binary,bytes,{mode:0o500,flag:'wx'});await mkdir(output,{mode:0o700});
      const copy=await lstat(binary);
      const copyAdmitted=copy.isFile() && copy.nlink===1 && copy.uid===process.getuid?.() && (copy.mode&0o777)===0o500;
      expect(copyAdmitted && createHash('sha256').update(await readFile(binary)).digest('hex')===hash).toBe(true);
      client=await fixture.client();
      const wait=async(stage:'prompt'|'metadata'|'rejection'|'ready'|'delivery',predicate:()=>boolean)=>{
        const deadline=performance.now()+5000;
        while(!predicate()) {
          if(client!.child.exitCode!==null || performance.now()>=deadline) {
            const primary=new Error('Owned receiver probe stage unavailable');
            const diagnostic=async(process:OwnedProcess)=>{try{return await process.startupDiagnostic();}catch{return {state:'observation-unavailable',exitCode:null};}};
            console.error(JSON.stringify({stage,lane:ownedReceiverRoot?'owned':'legacy',client:await diagnostic(client!),daemon:await diagnostic(fixture.daemon),
              clientErrors:receiverProbeErrors(client!.stderr),daemonErrors:receiverProbeErrors(fixture.daemon.stderr)}));
            throw primary;
          }
          await Bun.sleep(10);
        }
      };
      await wait('prompt',()=>client!.stdout.includes(fixture.prompt));
      const marker=`ROOT_${fixture.nonce}:`;
      client.child.stdin!.write(`printf 'ROOT_%s:%s:%s:%s:%s\n' '${fixture.nonce}' "$(id -u)" "$(stat -c %u /)" "$(stat -c %u /tmp)" "$(stat -c %u '${output}')"\n`);
      const metadata=()=>client!.stdout.match(new RegExp(marker+'([0-9]{1,10}):([0-9]{1,10}):([0-9]{1,10}):([0-9]{1,10})\\r?\n'));
      await wait('metadata',()=>metadata()!==null);
      const ids=metadata()!.slice(1).map(Number),admitted=(owner:number)=>owner===0 || owner===ids[0];
      expect(ids.every(Number.isSafeInteger)).toBe(true);
      expect(admitted(ids[1])).toBe(ownedReceiverRoot);
      expect(ids[3]===ids[0]).toBe(true);
      if(ownedReceiverRoot)expect(admitted(ids[2])).toBe(true);
      const ready=`IME_${fixture.nonce}_READY`,delivered=`IME_${fixture.nonce}_DELIVERED`;
      const exited=`EXIT_${fixture.nonce}:1`;
      client.child.stdin!.write(`'${binary}' '${output}' --ime-transactions '${fixture.nonce}'; printf 'EXIT_%s:%s\n' '${fixture.nonce}' "$?"\n`);
      if(!ownedReceiverRoot) {
        await wait('rejection',()=>client!.stdout.includes(exited));
        expect(client.stdout.includes('Owned terminal receiver failed') && !client.stdout.includes(ready)).toBe(true);
        for(const name of ['receiver-pid','received-bytes'])expect(await lstat(join(output,name)).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;})).toBe(true);
      } else {
        await wait('ready',()=>client!.stdout.includes(ready));
        const text=await readFile(join(output,'receiver-pid'),'utf8');
        expect(/^[1-9][0-9]{0,9}\n$/.test(text)).toBe(true);
        const saved=await identity(Number(text.trim()));
        expect(saved!==undefined).toBe(true);
        let parent=saved,owned=false;
        for(let depth=0;parent && depth<16;depth++) {
          if(parent.pid===fixture.daemon.child.pid){owned=true;break;}
          parent=await identity(parent.parent);
        }
        expect(owned).toBe(true);
        expect(createHash('sha256').update(await readFile(`/proc/${saved!.pid}/exe`)).digest('hex')===hash).toBe(true);
        const wire=Buffer.from(`${IME_TRANSACTION_WIRE}\x1b[13;2u\r\x1b[13;2uowned-current-${fixture.nonce}`);
        client.child.stdin!.write(wire);
        await wait('delivery',()=>client!.stdout.includes(delivered));
        expect((await readFile(join(output,'received-bytes'))).equals(wire)).toBe(true);
        expect((await identity(saved!.pid))?.start===saved!.start).toBe(true);
        const admitted=await checkRawReceiverIdentity(saved,undefined,fixture.daemon.child.pid!,hash);
        expect(admitted).toEqual(saved);
        await expect(checkRawReceiverIdentity(saved,undefined,fixture.daemon.child.pid!, '0'.repeat(64))).rejects.toThrow('image differs');
        await expect(checkRawReceiverIdentity(saved,{...saved!,start:'0'},fixture.daemon.child.pid!,hash)).rejects.toThrow('replaced');
        await expect(checkRawReceiverIdentity(saved,admitted,2147483647,hash)).rejects.toThrow('identity unavailable');
        await client.stop();
        const exitDeadline=performance.now()+5000;
        while(true) {
          const current=await identity(saved!.pid);
          if(!current || ['Z','X'].includes(current.state))break;
          if(performance.now()>=exitDeadline)throw new Error('Owned receiver did not exit after normal disconnect');
          await Bun.sleep(10);
        }
        // The monitor already read a live snapshot; ordinary disconnect can occur
        // before its next ancestry/executable/final identity observation.
        await expect(checkRawReceiverIdentity(saved,undefined,fixture.daemon.child.pid!,hash)).rejects.toThrow('not observed');
        expect(await checkRawReceiverIdentity(saved,admitted,fixture.daemon.child.pid!,hash)).toEqual(saved);
        expect(await checkRawReceiverIdentity(undefined,admitted,fixture.daemon.child.pid!,hash)).toEqual(saved);
        expect((await readFile(join(output,'received-bytes'))).equals(wire)).toBe(true);
      }
    } catch(error){primary=error;}
    finally {
      for(const cleanup of [()=>client?.stop(),()=>fixture.stop()])try{await cleanup();}catch(error){if(primary)console.error('Owned receiver probe cleanup failed after original failure');else primary=error;}
    }
    if(primary)throw primary;
    expect(await listening(fixture.port)).toBe(false);
    expect(await lstat(fixture.directory).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;})).toBe(true);
  }
  expect((await readFile('/etc/group')).equals(groups)).toBe(true);
  const after=await lstat(source);
  expect(after.dev===image.dev && after.ino===image.ino && after.nlink===image.nlink && after.mode===image.mode && after.size===image.size && after.uid===image.uid).toBe(true);
  expect(createHash('sha256').update(await readFile(source)).digest('hex')===hash).toBe(true);
},15_000);

test('recorded companion source admission fails before constructing any SSH fixture',async()=>{
  for(const path of [undefined,'','relative','/owned/\nprivate'])await expect(recordedCompanionBytes(path)).rejects.toThrow('Explicit current-source');
});

test('recorded source byte admission allows Cargo hardlinks but rejects links, writable and oversized inputs without execution',async()=>{
  const directory=await mkdtemp('/tmp/lazysh-recorded-source-'),path=join(directory,'source'),alias=join(directory,'cargo-alias');
  try {
    const bytes=Buffer.from('owned byte-admission fixture only; never executed');
    await writeFile(path,bytes,{mode:0o500});await link(path,alias);
    expect((await stat(path)).nlink).toBe(2);expect(await recordedCompanionBytes(alias)).toEqual(bytes);
    const symbolic=join(directory,'symbolic');await symlink(path,symbolic);await expect(recordedCompanionBytes(symbolic)).rejects.toThrow('Untrusted');
    await chmod(path,0o777);await expect(recordedCompanionBytes(path)).rejects.toThrow('Untrusted');
    await chmod(path,0o700);await truncate(path,256*1024*1024+1);await expect(recordedCompanionBytes(path)).rejects.toThrow('Untrusted');
  }finally{await rm(directory,{recursive:true,force:true});}
});
