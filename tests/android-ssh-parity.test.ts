import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SshFixture,OwnedProcess} from './support/androidSsh';
import {androidSshParityAcceptance,etBinary,etTerminalCount,moshRanges,parityControl,previewListener,sshdLogFacts,startOwnedEt,startOwnedMosh,validateSshParityReport,sshParityCases} from './support/androidSshParity';
import {sshCommand} from './support/sshFixture';
import {sftpListingNames,writeFilesFixture} from './support/androidFilesFixture';
import {ShareService} from './support/androidShare';
import {request as tlsRequest} from 'node:https';
import {createHash} from 'node:crypto';

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

/** The remote shell's `LC_TERMINAL`, printed through the fixture's interactive shell as the real OpenSSH client sends it. */
async function remoteClientEnvironment(fixture:SshFixture,send:boolean) {
  const client=await fixture.client(true,undefined,fixture.port,send?['-o','SetEnv=LC_TERMINAL=lazysh']:[]);
  client.child.stdin!.end(`printf 'ENV_%s_%s\\n' "$LC_TERMINAL" '${fixture.nonce}'\nexit\n`);
  return client.finish('owned environment login',10_000);
}

test.skipIf(!parity)('owned sshd with AcceptEnv delivers only the client environment the client sends',async()=>{
  const admitting=await SshFixture.start(undefined,{acceptEnv:true}),plain=await SshFixture.start();
  try {
    expect(await remoteClientEnvironment(admitting,true)).toContain(`ENV_lazysh_${admitting.nonce}`);
    expect(await remoteClientEnvironment(admitting,false)).toContain(`ENV__${admitting.nonce}`);
    // An sshd without AcceptEnv ignores the request, which is why the fixture opts in.
    expect(await remoteClientEnvironment(plain,true)).toContain(`ENV__${plain.nonce}`);
  } finally {await admitting.stop();await plain.stop();}
},30_000);

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
    expect(sftpListingNames(await listing.finish('owned files listing',10_000))).toEqual(['blob.bin','huge.txt','notes.txt','review']);
    // The refusals depend on these exact shapes: invalid UTF-8, and one byte over the 1 MiB preview limit.
    expect((await stat(join(fixture.directory,files.directory,'huge.txt'))).size).toBe(1024*1024+1);
    expect(()=>new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from([0xff,0xfe,0x00,0x80]))).toThrow();
    const facts=sshdLogFacts((await readFile(log)).subarray(offset).toString('utf8'));
    expect(facts.sftpSubsystems).toBe(1);
    expect(facts.execRequests).toBe(2);
  } finally {await fixture.stop();}
},40_000);

test('sftp listing names read the bare names of OpenSSH 8.9 and the relative paths of 10.x',()=>{
  const row=(name:string)=>`-rw-r--r--    1 runner   runner         27 Nov 15 20:09 ${name}`;
  expect(sftpListingNames(['sftp> ls -l browse',row('notes.txt'),row('blob.bin'),row('review'),'sftp> quit',''].join('\n'))).toEqual(['blob.bin','notes.txt','review']);
  expect(sftpListingNames(['sftp> ls -l browse',row('browse/notes.txt'),row('browse/blob.bin'),row('browse/review'),'sftp> quit',''].join('\n'))).toEqual(['blob.bin','notes.txt','review']);
  expect(sftpListingNames('Connection closed\n')).toEqual([]);
});

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

test.skipIf(!parity || !process.env.LAZYSH_TEST_AGENT_BIN)('owned agent sshd lists devices from exactly the SDK it is given',async()=>{
  const binary=process.env.LAZYSH_TEST_AGENT_BIN!;
  await expect(SshFixture.start(undefined,{agent:{binary,sdk:'/sdk with space'}})).rejects.toThrow('Unsupported owned Android SDK path');
  const sdk=await mkdtemp(join(tmpdir(),'lazysh-parity-sdk-'));
  const fixture=await (async()=>{
    // A stand-in adb that reports one running emulator, as the real one does for the job's owned AVD.
    await mkdir(join(sdk,'platform-tools'));
    await writeFile(join(sdk,'platform-tools/adb'),"#!/bin/sh\nprintf 'List of devices attached\\nemulator-5580\\tdevice product:sdk model:Owned_Emulator transport_id:1\\n'\n",{mode:0o700});
    return SshFixture.start(undefined,{log:true,shellSeconds:10,agent:{binary,sdk}});
  })();
  try {
    const client=await fixture.client(true,'lazysh-agent devices list --platform android');
    client.child.stdin!.end();
    const inventory=JSON.parse(await client.finish('owned device inventory',10_000));
    expect(inventory.devices).toEqual([{id:'emulator-5580',name:'Owned Emulator',state:'running',kind:'emulator',
      capabilities:{screenshot:true,tap:true,swipe:true,key:true,boot:false,shutdown:true,reboot:true}}]);
  } finally {await fixture.stop();await rm(sdk,{recursive:true,force:true});}
},40_000);

/** One TLS request to the share service's front, trusting only its throwaway certificate, the way the app's debug client does. */
function viaFront(service:ShareService,method:string,path:string,options:{body?:Uint8Array;type?:string}={}) {
  return new Promise<{status:number;body:string}>((done,fail)=>{
    const headers:Record<string,string>={authorization:`Bearer ${service.token}`};
    if(options.type)headers['content-type']=options.type;
    const call=tlsRequest(`${service.origin}${path}`,{method,ca:service.certificate,headers},reply=>{
      const chunks:Buffer[]=[];
      reply.on('data',chunk=>chunks.push(chunk));
      reply.on('end',()=>done({status:reply.statusCode??0,body:Buffer.concat(chunks).toString('utf8')}));
    });
    call.on('error',fail);call.end(options.body);
  });
}

test.skipIf(!parity)('owned share service keeps an upload over TLS and reports its state, its link and its deletion',async()=>{
  const service=await ShareService.start();
  try {
    expect(await service.facts()).toEqual({shares:[],gone:[],requests:{upload:0,history:0,download:0,delete:0}});
    // A 1x1 PNG: the real service checks the declared type against the file's own signature.
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==','base64');
    const sha=createHash('sha256').update(png).digest('hex');
    const created=await viaFront(service,'POST','/v1/shares?filename=swatch.png&ttlSeconds=3600',{body:png,type:'image/png'});
    expect(created.status).toBe(201);
    const url=(JSON.parse(created.body) as {share:{url:string}}).share.url;
    expect(url.startsWith(`${service.origin}/s/`)).toBe(true);
    expect(await service.facts()).toEqual({shares:[{name:'swatch.png',mime:'image/png',size:png.length,sha256:sha,ttl:3600,url}],gone:[],requests:{upload:1,history:0,download:0,delete:0}});
    expect(await service.open(url)).toMatchObject({status:200,size:png.length,sha256:sha});
    // Only the link of this service opens, and the host's own probes are not the app's traffic.
    await expect(service.open('https://example.com/s/'+'a'.repeat(64))).rejects.toThrow('url');
    expect((await service.facts()).requests.download).toBe(0);
    const id=url.slice(-64);
    expect((await viaFront(service,'DELETE',`/v1/shares/${id}`)).status).toBe(204);
    expect(await service.facts()).toEqual({shares:[],gone:[404],requests:{upload:1,history:0,download:0,delete:1}});
    expect(await service.open(url)).toMatchObject({status:404});
  } finally {await service.stop();}
},900_000);

test('owned parity control relays the share service only to its nonce and only when one exists',async()=>{
  const calls:unknown[]=[];
  const share={facts:async()=>({shares:[],gone:[],requests:{upload:0,history:0,download:0,delete:0}}),open:async(url:unknown)=>{calls.push(url);return {status:200,size:1,sha256:'x',type:'image/png'};}};
  const fixtures={} as Parameters<typeof parityControl>[0];
  const control=parityControl(fixtures,'n',async()=>{},undefined,undefined,undefined,share);
  expect(await control.reply({nonce:'n',action:'share'})).toMatchObject({gone:[]});
  expect(await control.reply({nonce:'n',action:'open',url:'https://127.0.0.1:1/s/x'})).toMatchObject({status:200});
  expect(calls).toEqual(['https://127.0.0.1:1/s/x']);
  await expect(control.reply({nonce:'foreign',action:'share'})).rejects.toThrow('nonce');
  await expect(parityControl(fixtures,'n',async()=>{}).reply({nonce:'n',action:'share'})).rejects.toThrow('action');
});

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

test.skipIf(!parity)('actual Android app logs in by password, encrypted key, bastion and forwarded agent, refuses a rotated host key and sends LC_TERMINAL only for an opted-in host',async()=>{
  await androidSshParityAcceptance();
},1_000_000);
