import {expect,test} from 'bun:test';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {SshFixture,listening,androidSshAcceptance} from './support/androidSsh';

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

test.skipIf(process.platform!=='linux')('lost foreground sshd ownership fails explicitly while still removing its private directory',async()=>{
  const fixture=await SshFixture.start();
  await fixture.daemon.stop();
  await expect(fixture.stop()).rejects.toThrow('Owned SSH root identity unavailable');
  await expect(stat(fixture.directory)).rejects.toMatchObject({code:'ENOENT'});
},5000);

test.skipIf(process.env.LAZYSH_ANDROID_UI_SSH!=='1')('actual Android app performs explicit trust and authenticated interactive SSH',async()=>{
  await androidSshAcceptance();
},610_000);
