import {expect,test} from 'bun:test';
import {chmod,mkdir,readFile,realpath,stat,symlink,unlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {SshFixture,listening,androidSshAcceptance,androidSshCleanup,OwnedProcess} from './support/androidSsh';
import {HerdrFixture,herdrTools} from './support/androidHerdr';
import {installedCompanion,type PublishedCompanion} from '../apps/client/published-native-e2e/release';
import {observeAndroidMoshBackground} from './support/androidMoshBackground';
import {sshCommand} from './support/sshFixture';

test.skipIf(process.platform!=='linux')('actual owned OpenSSH authenticates only its ephemeral key and emits non-echoable shell proof',async()=>{
  const fixture=await SshFixture.start();
  const port=fixture.port;
  try {
    expect((await stat(fixture.directory)).mode&0o777).toBe(0o700);
    expect((await stat(join(fixture.directory,'user'))).mode&0o777).toBe(0o600);
    const client=await fixture.client();
    expect(fixture.challenge).not.toContain(fixture.expected);
    client.child.stdin!.end(`${fixture.challenge}\nexit\n`);
    const output=await client.finish('actual SSH shell',5000);
    expect(output).toContain(fixture.prompt);
    expect(output).toContain(fixture.expected);
    const rejected=await fixture.client(false);
    await expect(rejected.finish('no ephemeral credential',5000)).rejects.toThrow('Owned fixture failed: no ephemeral credential');
  } finally {await fixture.stop();}
  expect(await listening(port)).toBe(false);
},15_000);

async function verifyCompanionFixture(privateTtyGroup:boolean) {
  const fixture=await SshFixture.start(undefined,{companion:true,privateTtyGroup});
  try {
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

test.skipIf(process.env.LAZYSH_ANDROID_UI_SSH!=='1')('actual Android Mosh survives busy background with the same owned shell and releases its last worker',async()=>{
  await androidSshAcceptance(undefined,undefined,false,true);
},610_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_COMPANION!=='1')('actual Android app installs and reuses the verified public companion through its UI',async()=>{
  await androidSshAcceptance(undefined,undefined,true);
},610_000);

// Real tools are explicit; ordinary host checks never download or guess a binary.
for(const mosh of [false,true]) {
test.skipIf(!process.env.LAZYSH_TEST_HERDR || !process.env.LAZYSH_TEST_AGENT_BIN || !process.env.LAZYSH_TEST_RECEIVER_BIN || (mosh && !process.env.LAZYSH_NATIVE_MOSH_SERVER))(`owned Herdr ${mosh?'Mosh':'SSH'} exec reads its real companion transcript in the private namespace`,async()=>{
  const owned=await HerdrFixture.start(herdrTools(),mosh?process.env.LAZYSH_NATIVE_MOSH_SERVER:undefined);
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
    } finally {await client.stop();}
    expect(await owned.history()).toMatchObject({offset:8,newTail:false});
    await owned.run(['tab','focus',agent.tabId]);await owned.expectHistoryScrolled();
    await expect(owned.history(513)).rejects.toThrow('Owned history request invalid');
    await owned.expectBytes(Buffer.alloc(0));
  } finally {await owned.stop();}
  expect(await listening(owned.ssh.port)).toBe(false);
  await expect(stat(owned.ssh.directory)).rejects.toMatchObject({code:'ENOENT'});
},15_000);
}

test.skipIf(process.env.LAZYSH_ANDROID_UI_HERDR!=='1').each(['ssh','mosh'] as const)('actual Android WebView explicitly confirms and sends to its original guarded Herdr receiver over %s',async transport=>{
  const moshBinary=transport==='mosh'?process.env.LAZYSH_NATIVE_MOSH_SERVER:undefined;
  if(transport==='mosh' && !moshBinary)throw new Error('Explicit pinned Mosh server required for Android Herdr entry');
  const owned=await HerdrFixture.start(herdrTools(),moshBinary);
  let primary=false;
  try {await androidSshAcceptance(undefined,owned,false,false,transport==='mosh');}
  catch(error){primary=true;throw error;}
  finally {await androidSshCleanup(primary,[['Herdr',()=>owned.stop()]]);}
},610_000);
