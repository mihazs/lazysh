import {expect,test} from 'bun:test';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
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

test.skipIf(!parity)('owned parity control answers only its nonce and closed actions, and installs exactly one public key',async()=>{
  const started:SshFixture[]=[];
  try {
    for(let index=0;index<3;index++)started.push(await SshFixture.start(undefined,{log:true}));
    const [primary,bastion,rotated]=started;
    let rotations=0;
    const control=parityControl({primary,bastion,rotated},primary.nonce,async()=>{rotations++;});
    for(const request of [undefined,{nonce:'foreign',action:'mark',server:'primary'},{nonce:primary.nonce,action:'remove'},
      {nonce:primary.nonce,action:'observe',server:'other'},{nonce:primary.nonce,action:'authorize',publicKey:'ssh-rsa AAAA'}])
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
    // A real generated key becomes authorized and its reported fingerprint is OpenSSH's own.
    const directory=await mkdtemp(join(tmpdir(),'lazysh-parity-generated-'));
    try {
      await sshCommand('owned generated key','ssh-keygen',['-q','-t','ed25519','-N','','-C','generated in lazysh','-f',join(directory,'id')]);
      await chmod(join(directory,'id'),0o600);
      const publicKey=(await readFile(join(directory,'id.pub'),'utf8')).trim();
      const before=await readFile(join(primary.directory,'authorized_keys'),'utf8');
      const reply=await control.reply({nonce:primary.nonce,action:'authorize',publicKey});
      expect(reply.fingerprint).toBe((await sshCommand('owned generated fingerprint','ssh-keygen',['-l','-E','sha256','-f',join(directory,'id.pub')])).trim().split(/\s+/)[1]);
      expect(await readFile(join(primary.directory,'authorized_keys'),'utf8')).toBe(before+publicKey+'\n');
      const generated=new OwnedProcess('ssh',['-T','-p',String(primary.port),'-F','/dev/null','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','IdentityAgent=none',
        '-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-i',join(directory,'id'),`${primary.username}@127.0.0.1`]);
      generated.child.stdin!.end(`${primary.challenge}\nexit\n`);
      expect(await generated.finish('owned generated login',5000)).toContain(primary.expected);
    } finally {await rm(directory,{recursive:true,force:true});}
  } finally {for(const fixture of started)await fixture.stop();}
},20_000);

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
