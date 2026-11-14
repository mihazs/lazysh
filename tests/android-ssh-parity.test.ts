import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SshFixture,OwnedProcess} from './support/androidSsh';
import {androidSshParityAcceptance,parityControl,sshdLogFacts,validateSshParityReport,sshParityCases} from './support/androidSshParity';
import {sshCommand} from './support/sshFixture';

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

test('owned parity control authorizes only a well-formed Ed25519 public key and reports the fingerprint ssh-keygen computes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-parity-authorize-'));
  try {
    const key=join(directory,'generated');
    await sshCommand('owned generated key','ssh-keygen',['-q','-t','ed25519','-N','','-C','generated@app','-f',key]);
    const publicKey=(await readFile(`${key}.pub`,'utf8')).trim();
    const authorized=join(directory,'authorized_keys');
    await writeFile(authorized,'existing\n',{mode:0o600});
    const nonce='a'.repeat(32);
    const control=parityControl({primary:{directory},bastion:{directory},rotated:{directory}} as unknown as Parameters<typeof parityControl>[0],nonce,async()=>{});
    for(const request of [{nonce:'foreign',action:'authorize',publicKey},{nonce,action:'authorize'},
      {nonce,action:'authorize',publicKey:`${publicKey}\n${publicKey}`},{nonce,action:'authorize',publicKey:`command="id" ${publicKey}`},
      {nonce,action:'authorize',publicKey:publicKey.replace('ssh-ed25519','ssh-rsa')},{nonce,action:'authorize',publicKey:publicKey.slice(0,40)}])
      await expect(control.reply(request)).rejects.toThrow();
    expect(await readFile(authorized,'utf8')).toBe('existing\n');
    const fingerprint=(await sshCommand('owned generated fingerprint','ssh-keygen',['-l','-E','sha256','-f',`${key}.pub`])).trim().split(/\s+/)[1];
    expect(await control.reply({nonce,action:'authorize',publicKey})).toEqual({fingerprint});
    expect(await readFile(authorized,'utf8')).toBe(`existing\n${publicKey}\n`);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('parity report counts only every expected native case passing exactly once',()=>{
  const row=(name:string,body='')=>`<testcase name="${name}" classname="app.lazysh.client.NativeWorkspaceTest" time="1">${body}</testcase>`;
  const report=(rows:string[])=>`<?xml version="1.0"?><testsuites><testsuite tests="${rows.length}">${rows.join('')}</testsuite></testsuites>`;
  expect(validateSshParityReport(report(sshParityCases.map(name=>row(name))))).toBe(sshParityCases.length);
  for(const rows of [sshParityCases.slice(1).map(name=>row(name)),[...sshParityCases,sshParityCases[0]].map(name=>row(name)),
    sshParityCases.map((name,index)=>row(name,index?'':'<skipped/>')),sshParityCases.map((name,index)=>row(name,index?'':'<failure message="x"/>'))])
    expect(()=>validateSshParityReport(report(rows))).toThrow();
});

test.skipIf(!parity)('actual Android app logs in by password, encrypted key, bastion and forwarded agent and refuses a rotated host key',async()=>{
  await androidSshParityAcceptance();
},1_000_000);
