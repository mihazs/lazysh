import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SshFixture,OwnedProcess} from './support/androidSsh';
import {androidSshParityAcceptance,parityControl,previewListener,sshdLogFacts,validateSshParityReport,sshParityCases} from './support/androidSshParity';
import {sshCommand} from './support/sshFixture';
import {writeFilesFixture} from './support/androidFilesFixture';

const parity=process.env.LAZYSH_ANDROID_UI_SSH_PARITY==='1';

/** Real OpenSSH client with a forced askpass helper, so the password reaches sshd only through its prompt. */
async function passwordLogin(fixture:SshFixture,password:string) {
  const directory=await mkdtemp(join(tmpdir(),'lazysh-parity-askpass-'));
  try {
    const askpass=join(directory,'askpass');
    await writeFile(askpass,`#!/bin/sh\nprintf '%s\\n' '${password}'\n`,{mode:0o700});
    const known=join(directory,'known_hosts');
    await writeFile(known,`[127.0.0.1]:${fixture.port} ${await readFile(join(fixture.directory,'host.pub'),'utf8')}`,{mode:0o600});
    const client=new OwnedProcess('setsid',['-w','ssh','-T','-p',String(fixture.port),'-F','/dev/null','-o','IdentityFile=none','-o','IdentityAgent=none',
      '-o','PreferredAuthentications=password','-o','PubkeyAuthentication=no','-o','NumberOfPasswordPrompts=1','-o','StrictHostKeyChecking=yes',
      '-o',`UserKnownHostsFile=${known}`,'-o','GlobalKnownHostsFile=/dev/null',`${fixture.username}@127.0.0.1`],undefined,
      {...process.env,SSH_ASKPASS:askpass,SSH_ASKPASS_REQUIRE:'force',DISPLAY:'owned-askpass'});
    // The fixture's ForceCommand shell reads the challenge from stdin.
    client.child.stdin!.end(`${fixture.challenge}\nexit\n`);
    return await client.finish('owned password login',10_000).then(output=>output,()=>undefined);
  } finally {await rm(directory,{recursive:true,force:true});}
}

test.skipIf(!parity)('owned password sshd accepts only its password and its log facts count each attempt',async()=>{
  const password='a'.repeat(12)+'0123',fixture=await SshFixture.start(undefined,{password,log:true});
  const log=join(fixture.directory,'sshd.log');
  try {
    // The fixture's own readiness probe connected before this offset.
    const offset=(await readFile(log)).length;
    expect(await passwordLogin(fixture,'b'.repeat(16))).toBeUndefined();
    expect(await passwordLogin(fixture,password)).toContain(fixture.expected);
    const key=await fixture.client();key.child.stdin!.end(`${fixture.challenge}\nexit\n`);
    expect(await key.finish('owned key login',5000)).toContain(fixture.expected);
    const facts=sshdLogFacts((await readFile(log)).subarray(offset).toString('utf8'));
    expect(facts.failedPassword).toBe(1);
    expect(facts.acceptedPassword).toBe(1);
    const user=(await sshCommand('owned user fingerprint','ssh-keygen',['-l','-E','sha256','-f',join(fixture.directory,'user.pub')])).trim().split(/\s+/)[1];
    expect(facts.acceptedPublickey).toEqual([user]);
    expect(facts.connections).toBe(3);
    expect(facts.userauthRequests).toBeGreaterThanOrEqual(3);
  } finally {await fixture.stop();}
});

test.skipIf(!parity)('owned parity control answers only its nonce and closed actions',async()=>{
  const started:SshFixture[]=[];
  try {
    for(let index=0;index<3;index++)started.push(await SshFixture.start(undefined,{log:true}));
    const [primary,bastion,rotated]=started;
    let rotations=0;
    const control=parityControl({primary,bastion,rotated},primary.nonce,async()=>{rotations++;});
    for(const request of [undefined,{nonce:'foreign',action:'mark',server:'primary'},{nonce:primary.nonce,action:'remove'},
      {nonce:primary.nonce,action:'observe',server:'other'}])
      await expect(control.reply(request)).rejects.toThrow();
    for(const server of ['primary','bastion'])await control.reply({nonce:primary.nonce,action:'mark',server});
    const probe=await primary.client();probe.child.stdin!.end(`${primary.challenge}\nexit\n`);
    await probe.finish('owned marked login',5000);
    const facts=await control.reply({nonce:primary.nonce,action:'observe',server:'primary'});
    expect(facts.connections).toBe(1);
    expect(facts.acceptedPublickey).toHaveLength(1);
    expect(await control.reply({nonce:primary.nonce,action:'observe',server:'bastion'})).toMatchObject({connections:0,acceptedPublickey:[]});
    await control.reply({nonce:primary.nonce,action:'rotate'});
    expect(rotations).toBe(1);
  } finally {for(const fixture of started)await fixture.stop();}
},20_000);

test('owned preview listener serves its proof and counts only iframe navigations',async()=>{
  const listener=await previewListener('PREVIEW_proof');
  try {
    const url=`http://127.0.0.1:${listener.port}/`;
    const plain=await fetch(url);
    expect(await plain.text()).toContain('PREVIEW_proof');
    expect(listener.seen).toEqual({requests:1,iframeLoads:0});
    await (await fetch(url,{headers:{'sec-fetch-dest':'iframe'}})).text();
    expect(listener.seen).toEqual({requests:2,iframeLoads:1});
  } finally {listener.server.closeAllConnections();await new Promise(done=>listener.server.close(done));}
});

test('owned parity control reports the preview listener only to its nonce and only when one exists',async()=>{
  const listener=await previewListener('PREVIEW_proof');
  try {
    const fixtures={} as Parameters<typeof parityControl>[0];
    const request={nonce:'n',action:'preview'};
    await expect(parityControl(fixtures,'n',async()=>{}).reply(request)).rejects.toThrow('action');
    await expect(parityControl(fixtures,'n',async()=>{},listener).reply({...request,nonce:'foreign'})).rejects.toThrow('nonce');
    listener.seen.iframeLoads=2;listener.seen.requests=3;
    expect(await parityControl(fixtures,'n',async()=>{},listener).reply(request)).toEqual({requests:3,iframeLoads:2});
  } finally {await new Promise(done=>listener.server.close(done));}
});

test.skipIf(!parity)('owned exec sshd runs the requested command while the plain one keeps its shell',async()=>{
  const started:SshFixture[]=[];
  try {
    for(const exec of [true,false])started.push(await SshFixture.start(undefined,{log:true,exec,shellSeconds:5}));
    const [running,plain]=started;
    const run=async(fixture:SshFixture)=>{const client=await fixture.client(true,'printf %s EXEC_PROOF');client.child.stdin!.end('exit\n');return client.finish('owned exec probe',8000).then(output=>output,()=>'');};
    expect(await run(running)).toContain('EXEC_PROOF');
    expect(await run(plain)).not.toContain('EXEC_PROOF');
  } finally {for(const fixture of started)await fixture.stop();}
},40_000);

test.skipIf(!parity)('owned files sshd serves the fixture over SFTP and its repository over exec',async()=>{
  const fixture=await SshFixture.start(undefined,{log:true,sftp:true});
  try {
    const log=join(fixture.directory,'sshd.log'),offset=(await readFile(log)).length;
    const files=await writeFilesFixture(fixture.directory,fixture.nonce);
    const status=await fixture.client(true,`git -C ${files.repository} status --porcelain=v1 --untracked-files=all`);
    status.child.stdin!.end();
    expect((await status.finish('owned repository status',10_000)).split('\n').filter(Boolean)).toEqual([' M data.bin',' M file.txt','A  staged-new.txt','?? notes/untracked.txt']);
    const history=await fixture.client(true,`git -C ${files.repository} log --format=%H%x20%s`);
    history.child.stdin!.end();
    const commits=(await history.finish('owned repository history',10_000)).split('\n').filter(Boolean);
    expect(commits).toEqual([expect.stringMatching(/^[0-9a-f]{40} second commit$/),`${files.firstCommit} first commit`]);
    const listing=await fixture.sftp();
    listing.child.stdin!.end(`ls -l ${files.directory}\nquit\n`);
    expect((await listing.finish('owned files listing',10_000)).split('\n').flatMap(line=>/^[-d]\S+ .*\/([^/\s]+)$/.exec(line)?.[1]??[]).sort())
      .toEqual(['blob.bin','huge.txt','notes.txt','review']);
    // The refusals depend on these exact shapes: invalid UTF-8, and one byte over the 1 MiB preview limit.
    expect((await stat(join(fixture.directory,files.directory,'huge.txt'))).size).toBe(1024*1024+1);
    expect(()=>new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from([0xff,0xfe,0x00,0x80]))).toThrow();
    const facts=sshdLogFacts((await readFile(log)).subarray(offset).toString('utf8'));
    expect(facts.sftpSubsystems).toBe(1);
    expect(facts.execRequests).toBe(2);
  } finally {await fixture.stop();}
},40_000);

test('parity report counts only every expected native case passing exactly once',()=>{
  const row=(name:string,body='')=>`<testcase name="${name}" classname="app.lazysh.client.NativeWorkspaceTest" time="1">${body}</testcase>`;
  const report=(rows:string[])=>`<?xml version="1.0"?><testsuites><testsuite tests="${rows.length}">${rows.join('')}</testsuite></testsuites>`;
  expect(validateSshParityReport(report(sshParityCases.map(name=>row(name))))).toBe(sshParityCases.length);
  for(const rows of [sshParityCases.slice(1).map(name=>row(name)),[...sshParityCases,sshParityCases[0]].map(name=>row(name)),
    sshParityCases.map((name,index)=>row(name,index?'':'<skipped/>')),sshParityCases.map((name,index)=>row(name,index?'':'<failure message="x"/>'))])
    expect(()=>validateSshParityReport(report(rows))).toThrow();
});

test('the shared Android runtime job leaves every owned parity case to the parity job',async()=>{
  // Those cases need the host-written sshd fixture and fail with no fixture path in the shared job.
  const moon=Bun.YAML.parse(await readFile(join(import.meta.dir,'../apps/client/moon.yml'),'utf8')) as {tasks:Record<string,{script:string}>};
  const excluded=moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',');
  for(const name of sshParityCases) expect(excluded).toContain(`app.lazysh.client.NativeWorkspaceTest#${name}`);
});

test.skipIf(!parity)('actual Android app logs in by password, encrypted key, bastion and forwarded agent and refuses a rotated host key',async()=>{
  await androidSshParityAcceptance();
},1_000_000);
