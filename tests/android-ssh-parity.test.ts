import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SshFixture,OwnedProcess} from './support/androidSsh';
import {androidSshParityAcceptance,etBinary,etTerminalCount,moshRanges,parityControl,sshdLogFacts,startOwnedEt,startOwnedMosh,validateSshParityReport,sshParityCases} from './support/androidSshParity';
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
    expect(await control.reply({nonce:primary.nonce,action:'et'})).toEqual({sessions:0});
  } finally {for(const fixture of started)await fixture.stop();}
},20_000);

test.skipIf(!parity)('owned etserver authorizes the etterminal its exec-capable sshd runs and counts only started terminals',async()=>{
  const ssh=await SshFixture.start(undefined,{companion:true});
  let et:Awaited<ReturnType<typeof startOwnedEt>>|undefined;
  try {
    et=await startOwnedEt(ssh,etBinary('ET_SERVER_BIN'));
    // The command the app sends over SSH: it registers a fresh id and passkey with the server FIFO and prints them.
    const bootstrap=await ssh.client(true,`'${etBinary('ET_TERMINAL_BIN')}' --logtostdout`);
    bootstrap.child.stdin!.end('XXXabcdefghijklm/'+'k'.repeat(32)+'_xterm-256color\n');
    expect(await bootstrap.finish('owned etterminal bootstrap',10_000)).toMatch(/IDPASSKEY:[A-Za-z0-9]{16}\/[A-Za-z0-9]{32}\n/);
    expect(await et.sessions()).toBe(0);
  } finally {await et?.stop();await ssh.stop();}
},30_000);

test.skipIf(!parity)('owned Mosh wrapper records the custom range it is run with and the UDP port its server then holds',async()=>{
  const mosh=await startOwnedMosh();
  try {
    expect(await mosh.facts()).toEqual({ranges:[],udpPorts:[]});
    // The bootstrap command the app sends over SSH for a custom server path and a single-port range.
    const range=`${mosh.udpPort}:${mosh.udpPort}`;
    const bootstrap=await mosh.ssh.client(true,`'${mosh.wrapper}' new -s -c 256 -p ${range} -l 'LC_ALL=C.UTF-8'`);
    expect(await bootstrap.finish('owned Mosh bootstrap',15_000)).toContain(`MOSH CONNECT ${mosh.udpPort} `);
    expect(await mosh.facts()).toEqual({ranges:[range],udpPorts:[mosh.udpPort]});
  } finally {await mosh.ssh.stop();}
},30_000);

test('Mosh ranges come only from the -p operand of the wrapper log',()=>{
  expect(moshRanges("new -s -c 256 -p 60001:60001 -l LC_ALL=C.UTF-8\n")).toEqual(['60001:60001']);
  expect(moshRanges("new -s -c 256 -l LC_ALL=C.UTF-8 -p 61000:61001\nnew -s -p 5:6\n")).toEqual(['61000:61001','5:6']);
  expect(moshRanges("new -s -c 256 -l LC_ALL=C.UTF-8\n")).toEqual([]);
});

test('etserver terminals are counted only from its own start lines',()=>{
  expect(etTerminalCount('Creating server\nWaiting for initial packet...\n')).toBe(0);
  expect(etTerminalCount('Waiting for initial packet...\nRUNNING TERMINAL\nGot keep alive\nRUNNING TERMINAL\n')).toBe(2);
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
