import {chmod,copyFile,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,lstat,writeFile,readlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir,userInfo} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {createServer,connect} from 'node:net';
import {createReadStream} from 'node:fs';
import {OwnedProcess,identity,descendants} from './ownedProcess';
import {HerdrFixture} from './androidHerdr';
import {androidSshAcceptance} from './androidSsh';
import pins from '../fixtures/swiftkey.json';
export const swiftkeyPins=pins;
type Split=typeof pins.files[number]&{package:string;versionCode:string;signer:string;signature:boolean;abis:string[]};
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function fileDigest(path:string) {const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function swiftkeyInputHashes(paths:Record<string,string>) {
  const hashes:Record<string,string>={};for(const [name,path] of Object.entries(paths))hashes[name]=await fileDigest(path);return hashes;
}
export async function observeSwiftkeyIntegrity(paths:Record<string,string>,expected:Record<string,string>) {
  const changed:string[]=[],unavailable:string[]=[];
  for(const [name,path] of Object.entries(paths)) {
    try {if(!expected[name]||await fileDigest(path)!==expected[name])changed.push(name);}catch {unavailable.push(name);}
  }
  return {state:unavailable.length?'unavailable':changed.length?'changed':'unchanged',changed,unavailable};
}

export function admitSwiftkeySet(rows:Split[]) {
  if(rows.length!==pins.files.length || new Set(rows.map(x=>x.name)).size!==rows.length || rows.some(row=>{
    const expected=pins.files.find(x=>x.name===row.name);
    return !expected || expected.bytes!==row.bytes || expected.sha256!==row.sha256 || row.package!==pins.package ||
      row.versionCode!==pins.versionCode || row.signer!==pins.signer || !row.signature ||
      JSON.stringify(row.abis)!==JSON.stringify(row.name.includes('config.x86_64')?['x86_64']:[]);
  }))throw new Error('Exact SwiftKey split admission failed');
  return true;
}
const quietEnvironment=(home:string)=>({PATH:'/usr/bin:/bin',HOME:home,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:home});
async function privateTool(program:string,args:string[],directory:string,environment:NodeJS.ProcessEnv,milliseconds=120_000) {
  // Output may include anonymous auth material or signed delivery URLs. Drain,
  // never print/retain it; errors from OwnedProcess contain only the fixed stage.
  return new OwnedProcess(program,args,directory,environment,false).finish('private SwiftKey preparation',milliseconds);
}
export async function readSwiftkeyResponse(response:Response,limit:number) {
  const reject=async(message:string)=>{await response.body?.cancel().catch(()=>{});throw new Error(message);};
  if(response.status!==200||response.redirected)return reject('SwiftKey response unavailable');
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^[0-9]+$/.test(declared)||Number(declared)>limit))return reject('SwiftKey response bound');
  if(!response.body)return reject('SwiftKey response unavailable');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>limit){await reader.cancel();throw new Error('SwiftKey response bound');}chunks.push(value);}
    const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}return body;
  } finally {reader.releaseLock();}
}
export async function boundedSwiftkeyFetch(url:string,limit:number) {
  let response:Response;
  try {response=await fetch(url,{signal:AbortSignal.timeout(10_000),redirect:'error'});}
  catch {throw new Error('SwiftKey response unavailable');}
  return readSwiftkeyResponse(response,limit);
}
async function timedJson(url:string) {return JSON.parse(new TextDecoder().decode(await boundedSwiftkeyFetch(url,1_000_000)));}

async function acquireSwiftkey(directory:string,sdk:string,java:string) {
  const home=join(directory,'fetch-home');await mkdir(home,{mode:0o700});const env=quietEnvironment(home);
  const metadata=await timedJson('https://pypi.org/pypi/goopdl/1.3.1/json');
  const wheel=metadata.urls?.find((x:{filename:string;digests:{sha256:string}})=>x.filename==='goopdl-1.3.1-py3-none-any.whl'&&x.digests.sha256===pins.goopdlWheelSha256);
  if(!wheel || new URL(wheel.url).hostname!=='files.pythonhosted.org')throw new Error('Pinned goopdl wheel unavailable');
  if(new URL(wheel.url).protocol!=='https:')throw new Error('Pinned goopdl wheel unavailable');
  const bytes=await boundedSwiftkeyFetch(wheel.url,2_000_000);
  if(digest(bytes)!==pins.goopdlWheelSha256)throw new Error('Pinned goopdl wheel differs');
  const file=join(home,'goopdl-1.3.1-py3-none-any.whl');await writeFile(file,bytes,{mode:0o600});
  await privateTool('/usr/bin/python3',['-m','venv',join(home,'venv')],home,env);
  const python=join(home,'venv/bin/python');
  await privateTool(python,['-I','-m','pip','install','--disable-pip-version-check','--no-cache-dir',file,...Object.entries(pins.dependencies).filter(([name])=>name!=='goopdl').map(([name,version])=>`${name}==${version}`)],home,env);
  const launch=join(home,'fetch.py');
  await writeFile(launch,`import os,sys,importlib.metadata as m,csv,hashlib,base64\nfrom pathlib import Path\nos.umask(0o077)\nexpected=${JSON.stringify(pins.dependencies)}\nfor name,version in expected.items():\n d=m.distribution(name);assert d.version==version\n for f in d.files or []:\n  if f.hash:\n   assert f.hash.mode=='sha256' and base64.urlsafe_b64encode(hashlib.sha256(d.locate_file(f).read_bytes()).digest()).decode().rstrip('=')==f.hash.value\nimport goopdl.auth\ngoopdl.auth._CONFIG_DIR=Path(${JSON.stringify(join(home,'auth'))})\nfrom goopdl.cli import app\napp()\n`,{mode:0o600});
  const downloads=join(directory,'vendor');await mkdir(downloads,{mode:0o700});
  await privateTool(python,['-I',launch,'download',pins.package,'-v',pins.versionCode,'--arch','x86_64','--profile','x8','--splits','--locale','en','--no-extras','-o',downloads],home,env);
  // No retry/latest fallback. The pinned tool's own bounded compatibility/token
  // behavior remains possible; only these six exact results are admitted.
  await verifySwiftkeyFiles(downloads,sdk,java);
  await rm(home,{recursive:true,force:true});return downloads;
}
export async function verifySwiftkeyFiles(directory:string,sdk:string,java:string) {
  const files=await readdir(directory);
  if(files.length!==pins.files.length || files.some(name=>!pins.files.some(file=>file.name===name)))throw new Error('Exact SwiftKey split admission failed');
  const rows:Split[]=[];
  for(const name of files) {
    const path=join(directory,name);const info=await lstat(path);
    if(!info.isFile()||info.size>30_000_000)throw new Error('SwiftKey APK is not a bounded regular file');
    const bytes=await readFile(path);
    if(bytes.length>30_000_000)throw new Error('SwiftKey APK exceeds bound');
    const badging=await new OwnedProcess(join(sdk,'build-tools/36.0.0/aapt'),['dump','badging',path],directory,quietEnvironment(directory)).finish('SwiftKey package admission',5000);
    const signature=await new OwnedProcess(java,['-jar',join(sdk,'build-tools/36.0.0/lib/apksigner.jar'),'verify','--print-certs',path],directory,quietEnvironment(directory)).finish('SwiftKey signature admission',5000);
    rows.push({name,bytes:bytes.length,sha256:digest(bytes),package:badging.match(/^package: name='([^']+)'/m)?.[1]??'',
      versionCode:badging.match(/^package:.* versionCode='([0-9]+)'/m)?.[1]??'',signer:signature.match(/^Signer #1 certificate SHA-256 digest: ([a-f0-9]+)$/m)?.[1]??'',
      signature:!signature.includes('Signer #2 certificate'),abis:badging.match(/^native-code: (.+)$/m)?.[1].match(/'[^']+'/g)?.map(x=>x.slice(1,-1))??[]});
  }
  admitSwiftkeySet(rows);return rows;
}

export async function ownedSwiftkeyCanary(host:string,port=0) {
  const nonce=randomBytes(16).toString('hex');const server=createServer(socket=>socket.end(nonce));
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(port,host,yes);});return {server,nonce};
}
export async function swiftkeyCanaryConnect(host:string,port:number,nonce:string) {
  await new Promise<void>((yes,no)=>{
    const socket=connect({host,port});socket.setTimeout(500);let body='';
    const fail=()=>{socket.destroy();no(new Error('Parent SwiftKey canary not proven'));};
    socket.on('data',data=>{body+=String(data);if(body.length>128)fail();});
    socket.once('error',fail);socket.once('timeout',fail);
    socket.once('end',()=>{socket.destroy();body===nonce?yes():fail();});
  });
}
type NamespaceIds={user:string;net:string;pid:string};
export async function swiftkeyNamespaceIds():Promise<NamespaceIds> {
  return {user:await readlink('/proc/self/ns/user'),net:await readlink('/proc/self/ns/net'),pid:await readlink('/proc/self/ns/pid')};
}
export function admitSwiftkeyNamespaces(parent:NamespaceIds,child:NamespaceIds) {
  if(!parent||!child||(['user','net','pid'] as const).some(name=>
    !new RegExp('^'+name+':\\[[0-9]+\\]$').test(parent[name])||
    !new RegExp('^'+name+':\\[[0-9]+\\]$').test(child[name])||parent[name]===child[name]))throw new Error('SwiftKey namespace isolation not established');
  return {parent,child};
}

async function blocked(host:string,port:number) {
  return new Promise<boolean>((yes,no)=>{
    const socket=connect({host,port});socket.setTimeout(500);
    socket.once('connect',()=>{socket.destroy();yes(false);});
    socket.once('error',(error:NodeJS.ErrnoException)=>{socket.destroy();['ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(error.code??'')?yes(true):no(new Error('Isolation probe inconclusive'));});
    socket.once('timeout',()=>{socket.destroy();no(new Error('Isolation probe timed out'));});
  });
}
export async function swiftkeyNamespaceChild() {
  const work='/work',sdk='/sdk',serial='emulator-5582';
  const env={...quietEnvironment(userInfo().homedir),TMPDIR:'/work/tmp',ANDROID_HOME:sdk,ANDROID_USER_HOME:work+'/android',ANDROID_EMULATOR_HOME:work+'/emulator',ANDROID_AVD_HOME:work+'/avd',ANDROID_ADB_SERVER_PORT:'5053',ADB_VENDOR_KEYS:work+'/keys',QT_QPA_PLATFORM:'offscreen'};
  // Adopt only our new namespace environment, never a parent auth/profile env.
  Object.assign(process.env,env,{ANDROID_SERIAL:serial,LAZYSH_ANDROID_KEYBOARD_PROFILE:'google-api36-latin'});
  const receipt:{stage:string;qualified:false;network?:unknown;kvm?:boolean;boot?:boolean;receiverZero?:boolean;bootCounts?:Record<string,number>;namespaces?:ReturnType<typeof admitSwiftkeyNamespaces>;namespaceAdmission?:'rejected'|'separate'}={stage:'namespace',qualified:false};
  try {receipt.namespaces=admitSwiftkeyNamespaces(JSON.parse(process.env.LAZYSH_SWIFTKEY_PARENT_NS??'null'),await swiftkeyNamespaceIds());receipt.namespaceAdmission='separate';}
  catch {receipt.namespaceAdmission='rejected';await writeFile(work+'/receipt.json',JSON.stringify(receipt)+'\n',{mode:0o600});throw new Error('SwiftKey namespace isolation not established');}
  const adb=new OwnedProcess(sdk+'/platform-tools/adb',['-L','tcp:5053','--one-device',serial,'server','nodaemon'],work,env,false);
  let emulator:OwnedProcess|undefined,herdr:HerdrFixture|undefined,server:ReturnType<typeof Bun.serve>|undefined,server6:ReturnType<typeof Bun.serve>|undefined;
  const command=(args:string[])=>new OwnedProcess(sdk+'/platform-tools/adb',['-s',serial,...args],work,env).finish('isolated Android command',5000);
  try {
    const links=await new OwnedProcess('/usr/bin/ip',['-j','link','show'],work,env).finish('isolated links',2000);
    const names=JSON.parse(links).map((x:{ifname:string})=>x.ifname);
    if(JSON.stringify(names)!=='["lo"]')throw new Error('Only namespace loopback is allowed');
    const negative=await Promise.all([blocked('192.0.2.1',443),blocked('2001:db8::1',443),blocked('127.0.0.1',14406),blocked('::1',14406)]);
    if(!negative.every(Boolean))throw new Error('Namespace egress or parent canary escaped');
    const nonce=randomBytes(16).toString('hex');
    server=Bun.serve({hostname:'127.0.0.1',port:14405,fetch:request=>new Response(new URL(request.url).pathname==='/'+nonce?nonce:'no',{status:new URL(request.url).pathname==='/'+nonce?200:404})});
    server6=Bun.serve({hostname:'::1',port:14405,fetch:()=>new Response(nonce)});
    for(const host of ['127.0.0.1','[::1]'])if(await (await fetch('http://'+host+':14405/'+nonce)).text()!==nonce)throw new Error('Child loopback nonce differs');
    receipt.network={loopbackOnly:true,negativeIpv4Ipv6AndParent:true,childNonce:true};
    receipt.stage='kvm';await stat('/dev/kvm').then(x=>{if(!x.isCharacterDevice())throw new Error('KVM character device required');});
    await new OwnedProcess(sdk+'/emulator/emulator',['-accel-check'],work,env).finish('actual child KVM admission',5000);
    receipt.stage='boot';
    emulator=new OwnedProcess(sdk+'/emulator/emulator',['-avd','lazysh-swiftkey','-port','5582','-accel','on','-no-window','-no-audio','-no-boot-anim','-no-snapshot','-gpu','swiftshader','-cores','2','-memory','2048','-camera-back','none','-camera-front','none','-qemu','-pidfile',work+'/qemu.pid'],work,env,false);
    const boot=performance.now()+300_000;
    receipt.bootCounts={};
    while(true) {
      if(performance.now()>=boot)throw new Error('Original 300s cold boot deadline');
      if(!await emulator.liveIdentity()||!await adb.liveIdentity())throw new Error('Owned Android process retired');
      const poll=new OwnedProcess(sdk+'/platform-tools/adb',['-s',serial,'shell','getprop','sys.boot_completed'],work,env);
      let value='';let category='other_exit';
      try {value=(await poll.finish('bounded boot sample',Math.min(5000,Math.max(1,boot-performance.now())))).trim();category=value==='1'?'boot1':value==='0'?'boot0':value===''?'empty':'unrecognized';}
      catch {const error=poll.stderr;category=error.includes('device offline')?'offline':error.includes('not found')?'device_missing':error.includes('unauthorized')?'unauthorized':'other_exit';}
      receipt.bootCounts[category]=(receipt.bootCounts[category]??0)+1;
      if(performance.now()>=boot)throw new Error('Original 300s cold boot deadline');
      if(value==='1')break;
      await Bun.sleep(Math.min(500,Math.max(1,boot-performance.now())));
    }
    const parent=await emulator.liveIdentity();if(!parent)throw new Error('Owned emulator identity lost');
    const members=[parent,...await descendants(parent)];let kvm=false;
    for(const member of members)for(const fd of await readdir(`/proc/${member.pid}/fd`).catch(()=>[])) {
      const target=await readlink(`/proc/${member.pid}/fd/${fd}`).catch(()=>'');if(target==='/dev/kvm'||target.includes('kvm-vm'))kvm=true;
    }
    if(!kvm)throw new Error('Actual owned QEMU KVM descriptor unavailable');receipt.kvm=true;receipt.boot=true;
    await command(['reverse','--no-rebind','tcp:14405','tcp:14405']);
    // Guest reverse nonce uses toybox nc; unavailable is an admission failure,
    // never a substitute host-only nonce check.
    const guest=await command(['shell',`printf 'GET /${nonce} HTTP/1.0\r\nHost: localhost\r\n\r\n' | toybox nc -w 2 127.0.0.1 14405`]);
    if(!guest.trim().endsWith('\r\n\r\n'+nonce) && !guest.trim().endsWith('\n\n'+nonce))throw new Error('Guest reverse nonce differs');
    receipt.stage='public-product';
    herdr=await HerdrFixture.start({herdrBinary:work+'/bundle/herdr',agentBinary:work+'/bundle/lazysh-agent',receiverBinary:work+'/bundle/owned-terminal-receiver'});
    await herdr.expectBytes(Buffer.alloc(0));receipt.receiverZero=true;
    await androidSshAcceptance(work+'/closure',herdr,false,false,false,{product:work+'/bundle/product.apk',test:work+'/bundle/test.apk',vendor:work+'/vendor'});
    // This intermediate owner deliberately cannot report typing acceptance.
    throw new Error('UNQUALIFIED: vendor replacement owner is not yet admitted');
  } finally {
    await writeFile(work+'/receipt.json',JSON.stringify(receipt)+'\n',{mode:0o600});
    try {await herdr?.expectBytes(Buffer.alloc(0));}
    finally {try {await herdr?.stop();}finally {try {await emulator?.stop();}finally {try {await adb.stop();}finally {server?.stop(true);server6?.stop(true);}}}}
  }
}

export async function copySwiftkeyClosure(root:string,destination:string) {
  const support=['androidSsh','androidSwiftkey','androidHerdr','ownedProcess','sshFixture','androidCaseCrash','androidMoshBackground'];
  const files=[...support.map(name=>'tests/support/'+name+'.ts'),'tests/fixtures/swiftkey.json','tests/android-ssh.test.ts',
    'apps/client/published-native-e2e/release.ts','apps/client/native-e2e/policy.ts'];
  for(const file of files) {const output=join(destination,file);await mkdir(dirname(output),{recursive:true,mode:0o700});await copyFile(join(root,file),output);}
  return files;
}

export async function hostedSwiftkeyAdmission(root=resolve(import.meta.dir,'../..')) {
  if(process.platform!=='linux'||process.arch!=='x64'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('Explicit disposable hosted SwiftKey owner required');
  const sdk=await realpath(process.env.ANDROID_HOME??'');const java=await realpath(join(process.env.JAVA_HOME??'','bin/java'));
  const directory=await mkdtemp(join(tmpdir(),'lazysh-swiftkey-'));await chmod(directory,0o700);
  const home=userInfo().homedir;
  if(!/^\/home\/[A-Za-z0-9_-]+$/.test(home))throw new Error('Private canonical home mount unavailable');
  let child:OwnedProcess|undefined;let membership:ReturnType<typeof setInterval>|undefined;let inventoryOverflow=false;
  const immutablePaths:Record<string,string>={};let inputHashes:Record<string,string>={};
  const seen=new Map<string,{pid:number;start:string}>();const canaries:Awaited<ReturnType<typeof ownedSwiftkeyCanary>>[]=[];let parentCanariesProven=false;
  try {
    for(const name of ['home','android','emulator','avd','keys','config','cache','data','runtime','tmp','bundle','closure/tests','closure/apps/client/published-native-e2e','closure/apps/client/native-e2e'])await mkdir(join(directory,name),{recursive:true,mode:0o700});
    await acquireSwiftkey(directory,sdk,java);
    const provenance:Record<string,string>={};
    for(const [name,source] of [['product.apk',process.env.LAZYSH_SWIFTKEY_PRODUCT_APK],['test.apk',process.env.LAZYSH_SWIFTKEY_TEST_APK],['herdr',process.env.LAZYSH_TEST_HERDR],['lazysh-agent',process.env.LAZYSH_TEST_AGENT_BIN],['owned-terminal-receiver',process.env.LAZYSH_TEST_RECEIVER_BIN],['bun',process.execPath]]) {
      if(!source)throw new Error('Immutable SwiftKey source input missing');await copyFile(await realpath(source),join(directory,'bundle',name));await chmod(join(directory,'bundle',name),0o700);provenance[name]=await fileDigest(join(directory,'bundle',name));
    }
    const copied=await copySwiftkeyClosure(root,join(directory,'closure'));
    for(const file of copied)immutablePaths['source/'+file]=join(directory,'closure',file);
    for(const name of await readdir(join(directory,'bundle')))immutablePaths['bundle/'+name]=join(directory,'bundle',name);
    for(const file of pins.files)immutablePaths['vendor/'+file.name]=join(directory,'vendor',file.name);
    const image=join(sdk,'system-images/android-36/google_apis/x86_64');
    if(digest(await readFile(join(image,'source.properties')))!=='edfc961bd9128fbfea84b4c61aac3a72ea270ca286425e22b3ed01ac759b1fc3')throw new Error('Pinned Google API36 rev7 image metadata differs');
    if(await fileDigest(join(image,'system.img'))!=='eb4bd8cc387915563a0a051c51ac58012e183e1bd21bb0fe2e82f1b255de45a1')throw new Error('Pinned image bytes differ');
    for(const [name,path] of [['emulator',join(sdk,'emulator/emulator')],['adb',join(sdk,'platform-tools/adb')],['bwrap','/usr/bin/bwrap'],['system.img',join(image,'system.img')],['source.properties',join(image,'source.properties')]]){provenance[name]=await fileDigest(path);immutablePaths['tool/'+name]=path;}
    inputHashes=await swiftkeyInputHashes(immutablePaths);
    const source=(await new OwnedProcess('/usr/bin/git',['rev-parse','HEAD'],root,quietEnvironment(join(directory,'home'))).finish('SwiftKey source identity',5000)).trim();
    if(!/^[a-f0-9]{40}$/.test(source)||source!==process.env.GITHUB_SHA)throw new Error('SwiftKey source nomination differs from checkout');
    provenance.source=source;
    for(const [name,expected] of [['product.apk','app.lazysh.client'],['test.apk','app.lazysh.client.test']]) {
      const apk=join(directory,'bundle',name);
      const metadata=await new OwnedProcess(join(sdk,'build-tools/36.0.0/aapt'),['dump','badging',apk],directory,quietEnvironment(join(directory,'home'))).finish('current product package identity',5000);
      if(metadata.match(/^package: name='([^']+)'/m)?.[1]!==expected)throw new Error('Product APK package differs');
      const signature=await new OwnedProcess(java,['-jar',join(sdk,'build-tools/36.0.0/lib/apksigner.jar'),'verify','--print-certs',apk],directory,quietEnvironment(join(directory,'home'))).finish('current signed product identity',5000);
      const cert=signature.match(/^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})$/m)?.[1];
      if(!cert||signature.includes('Signer #2 certificate'))throw new Error('Single verified product signer required');provenance[name+'Signer']=cert;
    }
    if(provenance['product.apkSigner']!==provenance['test.apkSigner'])throw new Error('Product and instrumentation signers differ');
    await writeFile(join(directory,'input-hashes.json'),JSON.stringify(inputHashes)+'\n',{mode:0o600});
    await writeFile(join(directory,'provenance.json'),JSON.stringify(provenance)+'\n',{mode:0o600});
    const env={...quietEnvironment(join(directory,'home')),JAVA_HOME:dirname(dirname(java)),ANDROID_HOME:sdk,ANDROID_USER_HOME:join(directory,'android'),ANDROID_AVD_HOME:join(directory,'avd')};
    const avd=new OwnedProcess(join(sdk,'cmdline-tools/latest/bin/avdmanager'),['create','avd','-n','lazysh-swiftkey','-k','system-images;android-36;google_apis;x86_64'],directory,env,false);
    avd.child.stdin!.end('no\n');await avd.finish('private SwiftKey AVD creation',30_000);
    const config=join(directory,'avd/lazysh-swiftkey.avd/config.ini');
    const before=await readFile(config,'utf8');await writeFile(config,before.replaceAll(sdk,'/sdk')+'\nhw.keyboard=no\n',{mode:0o600});
    const ini=join(directory,'avd/lazysh-swiftkey.ini');await writeFile(ini,(await readFile(ini,'utf8')).replaceAll(directory,'/work'),{mode:0o600});
    for(const host of ['127.0.0.1','::1']) {const canary=await ownedSwiftkeyCanary(host,14406);canaries.push(canary);await swiftkeyCanaryConnect(host,14406,canary.nonce);}
    parentCanariesProven=true;
    const parentNamespaces=await swiftkeyNamespaceIds();
    const args=['--die-with-parent','--unshare-all','--new-session'];
    for(const path of ['/usr','/bin','/lib','/lib64'])args.push('--ro-bind',path,path);
    args.push('--dir','/etc');for(const path of ['/etc/passwd','/etc/group','/etc/hosts','/etc/nsswitch.conf','/etc/ld.so.cache'])args.push('--ro-bind',path,path);
    args.push('--proc','/proc','--dev','/dev','--dev-bind','/dev/kvm','/dev/kvm','--tmpfs','/dev/shm','--tmpfs','/tmp','--ro-bind',sdk,'/sdk','--bind',directory,'/work','--ro-bind',join(directory,'bundle'),'/work/bundle','--ro-bind',join(directory,'closure'),'/work/closure','--ro-bind',join(directory,'vendor'),'/work/vendor','--bind',join(directory,'home'),home,'--chdir','/work/closure','--clearenv');
    for(const [name,value] of Object.entries({...quietEnvironment(home),LAZYSH_ANDROID_SWIFTKEY_CHILD:'1',LAZYSH_SWIFTKEY_PARENT_NS:JSON.stringify(parentNamespaces)}))args.push('--setenv',name,value);
    args.push('--','/work/bundle/bun','test','tests/android-ssh.test.ts','--test-name-pattern','isolated SwiftKey native discovery');
    child=new OwnedProcess('/usr/bin/bwrap',args,directory,quietEnvironment(join(directory,'home')),false);
    const owner=await child.liveIdentity();if(!owner)throw new Error('Namespace owner identity absent');
    membership=setInterval(()=>{void descendants(owner).then(rows=>{for(const row of rows){const key=row.pid+':'+row.start;if(seen.has(key)||seen.size<256)seen.set(key,{pid:row.pid,start:row.start});else inventoryOverflow=true;}}).catch(()=>{});},200);
    await child.finish('original 340s isolated SwiftKey gate',340_000);
  } finally {
    if(membership)clearInterval(membership);
    const cleanup=await Promise.allSettled([child?.stop(),...canaries.map(canary=>new Promise<void>(yes=>canary.server.close(()=>yes())))]);
    try {
      // Partial writes after an outer kill are inconclusive, not a success.
      const load=async(name:string)=>{try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch{return {state:'unavailable'};}};
      const receipt=await load('receipt.json');
      receipt.nativeFailure=await load('native-failure.json');
      receipt.parentCanariesProven=parentCanariesProven;
      receipt.qualified=false;receipt.scope='intermediate vendor discovery, not typing acceptance';
      receipt.provenance=await load('provenance.json');receipt.inputHashes=inputHashes;
      receipt.inputIntegrity=Object.keys(inputHashes).length?await observeSwiftkeyIntegrity(immutablePaths,inputHashes):{state:'not-nominated'};
      receipt.processes=[...seen.values()];receipt.inventoryOverflow=inventoryOverflow;receipt.surviving=[];
      for(const original of seen.values())if((await identity(original.pid))?.start===original.start)receipt.surviving.push(original);
      if(process.env.LAZYSH_SWIFTKEY_RECEIPT)await writeFile(process.env.LAZYSH_SWIFTKEY_RECEIPT,JSON.stringify(receipt)+'\n',{mode:0o600});
      const ax=await readFile(join(directory,'vendor-discovery.json'),'utf8').catch(()=>'');
      if(process.env.LAZYSH_SWIFTKEY_AX && ax)await writeFile(process.env.LAZYSH_SWIFTKEY_AX,ax,{mode:0o600});
      if((child&&receipt.inputIntegrity.state!=='unchanged')||inventoryOverflow||receipt.surviving.length||cleanup.some(x=>x.status==='rejected'))throw new Error('Owned namespace process cleanup unqualified');
    } finally {await rm(directory,{recursive:true,force:true});}
  }
}
