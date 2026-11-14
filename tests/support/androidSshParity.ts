import {createServer,type Server} from 'node:net';
import {appendFile,chmod,copyFile,mkdtemp,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {SshFixture,OwnedProcess,androidSshCleanup,nativeReportCases,ownedSoftwareKeyboard} from './androidSsh';
import {availablePort,sshCommand} from './sshFixture';

/** The owned SSH parity instrumentation cases (#985, #986), run together in one Gradle invocation. */
export const sshParityCases=[
  'ownedSshPasswordLoginThroughRealUi',
  'ownedSshEncryptedKeyLoginThroughRealUi',
  'ownedSshRotatedHostKeyRefusedThroughRealUi',
  'ownedSshBastionRouteThroughRealUi',
  'ownedSshAgentForwardingThroughRealUi',
  'ownedSshImportsKeyFileThroughDocumentPickerAndLogsIn',
  'ownedSshRefusesPublicKeysBeforeAnyAuthentication',
  'ownedSshGeneratesKeyCopiesPublicKeyAndLogsIn',
] as const;
const nativeClass='app.lazysh.client.NativeWorkspaceTest';
type ParityServer='primary'|'bastion'|'rotated';
const servers:readonly ParityServer[]=['primary','bastion','rotated'];

/** Closed facts from an owned sshd DEBUG1 log; no raw log text leaves this function. */
export function sshdLogFacts(text:string) {
  const lines=text.split('\n');
  const count=(pattern:RegExp)=>lines.filter(line=>pattern.test(line)).length;
  const captured=(pattern:RegExp)=>lines.flatMap(line=>{const value=pattern.exec(line)?.[1];return value===undefined?[]:[value];});
  return {
    connections:count(/Connection from 127\.0\.0\.1 port [0-9]+ on 127\.0\.0\.1 port [0-9]+/),
    userauthRequests:count(/userauth-request for user /),
    acceptedPassword:count(/Accepted password for /),
    failedPassword:count(/Failed password for /),
    acceptedPublickey:captured(/Accepted publickey for \S+ from 127\.0\.0\.1 port [0-9]+ ssh2: \S+ (SHA256:[A-Za-z0-9+/]{43})/),
    directTcpipTargets:captured(/direct_tcpip: originator \S+ port [0-9]+, target 127\.0\.0\.1 port ([0-9]+)/).map(Number),
  };
}

const ed25519PublicKey=/^ssh-ed25519 [A-Za-z0-9+/]{68}( [!-~]{1,64})?$/;
/** Appends one generated Ed25519 public key to the primary sshd's authorized keys; the fingerprint is `ssh-keygen -l`'s, not the app's. */
async function authorizeKey(directory:string,publicKey:unknown) {
  if(typeof publicKey!=='string' || !ed25519PublicKey.test(publicKey))throw new Error('key');
  const probe=await mkdtemp(join(tmpdir(),'lazysh-parity-pub-'));
  try {
    const file=join(probe,'key.pub');
    await writeFile(file,publicKey+'\n',{mode:0o600});
    const fingerprint=(await sshCommand('owned authorized key fingerprint','ssh-keygen',['-l','-E','sha256','-f',file])).trim().split(/\s+/)[1];
    if(!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))throw new Error('key');
    await appendFile(join(directory,'authorized_keys'),publicKey+'\n');
    return {fingerprint};
  } finally {await rm(probe,{recursive:true,force:true});}
}

/** Requires every parity case to have run exactly once and passed, so a filtered or skipped case cannot count. */
export function validateSshParityReport(text:string) {
  const {cases,failed}=nativeReportCases(text);
  const names=cases.map(item=>item.className===nativeClass?item.name:undefined).sort();
  if(failed || JSON.stringify(names)!==JSON.stringify([...sshParityCases].sort()))
    throw new Error('Owned SSH parity native cases did not each pass exactly once');
  return names.length;
}

type Fixtures={primary:SshFixture;bastion:SshFixture;rotated:SshFixture};
type Control={reply:(request:unknown)=>Promise<Record<string,unknown>>};
/**
 * The instrumentation's only host channel. Requests carry the case nonce and one closed
 * action; replies are closed facts. `rotate` points the pinned device port at a second sshd;
 * `authorize` installs one app-generated Ed25519 public key on the primary sshd.
 */
export function parityControl(fixtures:Fixtures,nonce:string,rotate:()=>Promise<void>):Control {
  const marks=new Map<ParityServer,number>(servers.map(name=>[name,0]));
  const log=(name:ParityServer)=>readFile(join(fixtures[name].directory,'sshd.log'));
  const mark=async(name:ParityServer)=>{marks.set(name,(await log(name)).length);};
  return {reply:async request=>{
    if(!request || typeof request!=='object')throw new Error('request');
    const {nonce:owner,action,server,publicKey}=request as Record<string,unknown>;
    if(owner!==nonce)throw new Error('nonce');
    const name=servers.find(value=>value===server);
    if(action==='mark' && name){await mark(name);return {};}
    if(action==='observe' && name)return sshdLogFacts((await log(name)).subarray(marks.get(name)).toString('utf8'));
    if(action==='rotate'){await rotate();await mark('rotated');return {};}
    if(action==='authorize')return authorizeKey(fixtures.primary.directory,publicKey);
    throw new Error('action');
  }};
}

async function listen(control:Control) {
  const server=createServer(socket=>{
    let buffer='';
    socket.setEncoding('utf8');
    socket.setTimeout(30_000,()=>socket.destroy());
    socket.on('error',()=>{});
    socket.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.length>8192){socket.destroy();return;}
      const end=buffer.indexOf('\n');
      if(end<0)return;
      socket.pause();
      let request:unknown;
      try{request=JSON.parse(buffer.slice(0,end));}catch{request=undefined;}
      control.reply(request).then(value=>({ok:true,...value}),(error:unknown)=>({ok:false,error:error instanceof Error && /^[a-z]{1,16}$/.test(error.message)?error.message:'failed'}))
        .then(reply=>socket.end(JSON.stringify(reply)+'\n'));
    });
  });
  await new Promise<void>((resolve_,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve_);});
  return {server,port:(server.address() as {port:number}).port};
}
const close=(server:Server)=>new Promise<void>((resolve_,reject)=>server.close(error=>error?reject(error):resolve_()));

/** A passphrase-encrypted copy of the primary user key, as `ssh-keygen -p` writes it. */
async function encryptedIdentity(primary:SshFixture,passphrase:string) {
  const directory=await mkdtemp(join(tmpdir(),'lazysh-parity-key-'));
  try {
    const key=join(directory,'id_ed25519');
    await copyFile(join(primary.directory,'user'),key);await chmod(key,0o600);
    await sshCommand('owned identity encryption','ssh-keygen',['-q','-p','-P','','-N',passphrase,'-f',key]);
    const encrypted=await readFile(key,'utf8');
    if(encrypted===primary.privateKey || !encrypted.includes('OPENSSH PRIVATE KEY'))throw new Error('Owned identity was not re-encrypted');
    return encrypted;
  } finally {await rm(directory,{recursive:true,force:true});}
}

/**
 * Owned emulator only. Starts a password-enabled primary sshd, a password bastion and a
 * second-key sshd for rotation, then runs the parity cases with the host control channel.
 */
export async function androidSshParityAcceptance(root=resolve(import.meta.dir,'../..')) {
  if(process.platform!=='linux')throw new Error('Owned Android SSH parity acceptance requires Linux');
  const serial=process.env.ANDROID_SERIAL;
  if(!serial || !/^emulator-[0-9]{4,5}$/.test(serial))throw new Error('Use an explicitly selected owned emulator');
  const adb=process.env.ANDROID_HOME?join(process.env.ANDROID_HOME,'platform-tools/adb'):'adb';
  const device=(args:string[])=>sshCommand('owned emulator command',adb,['-s',serial,...args]);
  const password=randomBytes(16).toString('hex'),passphrase=randomBytes(12).toString('hex');
  const started:SshFixture[]=[];
  const reverses:number[]=[];
  let remote:string|undefined,keyboard:Awaited<ReturnType<typeof ownedSoftwareKeyboard>>|undefined,control:Server|undefined;
  let primary=false;
  try {
    const fixtures={} as Fixtures;
    for(const name of servers)started.push(fixtures[name]=await SshFixture.start(undefined,{password,log:true}));
    const nonce=fixtures.primary.nonce;
    // The rotation case pins this device port to the primary key, then the host repoints it.
    const pinned={port:await availablePort()};
    const reverse=async(device_:number,host:number,rebind=false)=>{
      await device(['reverse',...(rebind?[]:['--no-rebind']),`tcp:${device_}`,`tcp:${host}`]);
      if(!reverses.includes(device_))reverses.push(device_);
    };
    const channel=await listen(parityControl(fixtures,nonce,()=>reverse(pinned.port,fixtures.rotated.port,true)));
    control=channel.server;
    for(const port of [fixtures.primary.port,fixtures.bastion.port,channel.port])await reverse(port,port);
    await reverse(pinned.port,fixtures.primary.port);
    keyboard=await ownedSoftwareKeyboard(adb,serial,5000,'aosp-latin');
    remote=`/data/local/tmp/lazysh-ui-ssh-${nonce}`;
    await device(['shell','mkdir','-m','700',remote]);
    const server=(fixture:SshFixture)=>({port:fixture.port,fingerprint:fixture.fingerprint,prompt:fixture.prompt});
    const userFingerprint=(await sshCommand('owned user fingerprint','ssh-keygen',['-l','-E','sha256','-f',join(fixtures.primary.directory,'user.pub')])).trim().split(/\s+/)[1];
    const data=join(fixtures.primary.directory,'android-parity-fixture.json');
    await writeFile(data,JSON.stringify({nonce,username:fixtures.primary.username,controlPort:channel.port,password,passphrase,
      privateKey:fixtures.primary.privateKey,publicKey:(await readFile(join(fixtures.primary.directory,'user.pub'),'utf8')).trim(),encryptedKey:await encryptedIdentity(fixtures.primary,passphrase),userFingerprint,
      challenge:fixtures.primary.challenge,expected:fixtures.primary.expected,
      primary:server(fixtures.primary),bastion:server(fixtures.bastion),rotation:{port:pinned.port,fingerprint:fixtures.rotated.fingerprint}}),{mode:0o600});
    if((await stat(data)).size>16*1024)throw new Error('Owned Android parity fixture exceeds native bound');
    await device(['push',data,`${remote}/fixture.json`]);
    await device(['shell','chmod','600',`${remote}/fixture.json`]);
    const android=join(root,'apps/client/src-tauri/gen/android');
    const report=join(android,'app/build/outputs/androidTest-results/ssh-parity-ui');
    await rm(report,{recursive:true,force:true});
    await new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug','-PlazyshSshParityAcceptance=true',
      '-Pandroid.testInstrumentationRunnerArguments.class='+sshParityCases.map(name=>`${nativeClass}#${name}`).join(','),
      `-Pandroid.testInstrumentationRunnerArguments.lazyshSshFixture=${remote}/fixture.json`],root).finish('actual Android SSH parity instrumentation',900_000);
    const reports=(await readdir(report,{recursive:true})).filter(name=>name.endsWith('.xml')).map(name=>join(report,name));
    if(reports.length!==1)throw new Error('Expected one owned SSH parity native report');
    console.log(`Owned Android SSH parity: ${validateSshParityReport(await readFile(reports[0],'utf8'))} native cases passed against owned OpenSSH`);
  } catch(error){primary=true;throw error;}
  finally {
    await androidSshCleanup(primary,[
      ['software-keyboard',()=>keyboard?.restore()??Promise.resolve()],
      ...reverses.map(port=>['reverse',()=>device(['reverse','--remove',`tcp:${port}`])] as const),
      ['control',()=>control?close(control):Promise.resolve()],
      ['fixture-file',()=>remote?device(['shell','rm','-rf','--',remote]):Promise.resolve()],
      ...started.map(fixture=>['SSH',()=>fixture.stop()] as const),
    ]);
  }
}
