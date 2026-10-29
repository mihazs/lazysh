import {expect,test} from 'bun:test';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {SshFixture,listening,androidSshAcceptance,androidSshCleanup} from './support/androidSsh';
import {HerdrFixture,herdrTools} from './support/androidHerdr';

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

test.skipIf(process.platform!=='linux')('lost foreground sshd ownership fails explicitly while still removing its private directory',async()=>{
  const fixture=await SshFixture.start();
  await fixture.daemon.stop();
  await expect(fixture.stop()).rejects.toThrow('Owned SSH root identity unavailable');
  await expect(stat(fixture.directory)).rejects.toMatchObject({code:'ENOENT'});
},5000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_SSH!=='1')('actual Android app performs explicit trust and authenticated interactive SSH',async()=>{
  await androidSshAcceptance();
},610_000);

// Real tools are explicit; ordinary host checks never download or guess a binary.
test.skipIf(!process.env.LAZYSH_TEST_HERDR || !process.env.LAZYSH_TEST_AGENT_BIN || !process.env.LAZYSH_TEST_RECEIVER_BIN)('owned Herdr SSH exec reads its real companion transcript in the private namespace',async()=>{
  const owned=await HerdrFixture.start(herdrTools());
  try {
    const companion=await owned.ssh.client(true,'lazysh-agent transcript --agent claude --path='+owned.transcript+' --offset 0');
    const value=JSON.parse(await companion.finish('owned real companion transcript',5000));
    expect(value.schemaVersion).toBe(1);expect(value.agent).toBe('claude');expect(value.messages).toHaveLength(1);
    expect(JSON.stringify(value.messages)).toContain(owned.record);
    const listing=await owned.ssh.client(true,'herdr session list --json');
    expect(await listing.finish('owned real Herdr discovery',5000)).toContain(owned.name);
    await owned.expectBytes(Buffer.alloc(0));
  } finally {await owned.stop();}
},15_000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_HERDR!=='1')('actual Android WebView explicitly confirms and sends to its original guarded Herdr receiver',async()=>{
  const owned=await HerdrFixture.start(herdrTools());
  let primary=false;
  try {await androidSshAcceptance(undefined,owned);}
  catch(error){primary=true;throw error;}
  finally {await androidSshCleanup(primary,[['Herdr',()=>owned.stop()]]);}
},610_000);
