import {createHash,randomBytes,randomInt} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,readlink,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {createServer,type Socket} from 'node:net';
import {userInfo} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {OwnedProcess,descendants,identity,type OwnedPid} from '../../../tests/support/ownedProcess';
import {assertDirectDriverEnvironment,guiEnvironment,listenerInode,namespaceArguments} from './policy';
import {acceptedConnectionOwner,socketInventory} from './socketOwner';
import {ClientTargetObserver} from './clientObserver';
import {executable} from './tools';
import {acceptedEndpointRoles,assertDistinctPorts,driverPorts,type OwnedPorts} from './ports';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const BUS_NAME='app.lazysh.client.SingleInstance';
type Browser=Awaited<ReturnType<typeof import('webdriverio').remote>>;
type AppOwner={name:string;pid:number;start:string};

async function until<T>(stage:string,probe:()=>Promise<T|undefined>,milliseconds=30_000):Promise<T> {
  const deadline=performance.now()+milliseconds;
  do {const value=await probe();if(value!==undefined)return value;await delay(25);}while(performance.now()<deadline);
  throw new Error(`Owned native GUI deadline: ${stage}`);
}
export function disposableVaultArguments(directory:string):string[] {
  if(!directory.startsWith('/tmp/lazysh-native-gui-')||resolve(directory)!==directory||/[\x00-\x1f\x7f]/.test(directory))throw new Error('Invalid disposable vault directory');
  return ['--foreground','--unlock','--components=secrets',`--control-directory=${join(directory,'runtime')}`];
}
export function secretServicePid(reply:string):number {
  const lines=reply.trim().split('\n'),match=lines[1]?.trim().match(/^uint32 ([1-9][0-9]*)$/);
  const pid=Number(match?.[1]);
  if(reply.length>2048||lines.length!==2||!lines[0].startsWith('method return ')||!Number.isSafeInteger(pid)||pid>2147483647)throw new Error('Invalid disposable Secret Service owner');
  return pid;
}
export function credentialItemPaths(reply:string):string[] {
  if(reply.length>4096)throw new Error('Disposable credential metadata exceeds its bound');
  const paths=[...reply.matchAll(/object path "([^"\n]+)"/g)].map(match=>match[1]);
  if(paths.length>8||paths.some(path=>!/^\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(path))||new Set(paths).size!==paths.length)throw new Error('Invalid disposable credential metadata');
  // Only the two object-path arrays from SearchItems, never secret retrieval.
  const body=reply.trim().split('\n').slice(1).join('\n');
  if(!reply.startsWith('method return ')||!/^\s*array \[\s*(?:object path "[^"\n]+"\s*)*\]\s*array \[\s*(?:object path "[^"\n]+"\s*)*\]\s*$/.test(body))throw new Error('Invalid disposable credential metadata');
  return paths;
}
export class NativeGui {
  browser?:Browser;
  private bus?:OwnedProcess;
  private display?:OwnedProcess;
  private secretService?:OwnedProcess;
  private secretImage='';
  private secretMembers:OwnedPid[]=[];
  private credentialItem?:string;
  private driver?:OwnedProcess;
  private clientObserver?:ClientTargetObserver;
  private env:NodeJS.ProcessEnv;
  private busAddress:string;
  private xSocket='';
  private driverFile='';
  private nativeDriverFile='';
  private resolverFile:string|undefined;
  private readonly home=userInfo().homedir;
  private members:OwnedPid[]=[];
  private readonly ports:OwnedPorts={target:0,driver:0,native:0};
  private readonly probes:Promise<void>[]=[];
  private readonly listener=createServer(socket=>{
    this.connections++;
    if(this.connections===1) {
      try {
        const role=acceptedEndpointRoles(socket,this.listener,this.ports);
        console.info(`Owned target accept: listener=${role.listener}; local=${role.local}; peer=${role.peer}; loopback=${role.loopback}; selfTuple=${role.selfTuple}`);
      } catch {console.info('Owned target accept endpoint unavailable');}
      this.probes.push(this.connectionOrigin(socket).catch(()=>{console.info('Owned native target origin unavailable');}).finally(()=>{socket.destroy();}));
    }
    else socket.destroy();
  });
  stage='fixture startup';
  connections=0;
  private constructor(readonly directory:string,readonly binary:string,private readonly testWorker:OwnedPid,private readonly disposableVault=false) {this.busAddress=`unix:path=${directory}/runtime/bus`;this.env=guiEnvironment(directory,this.busAddress);}

  static async start() {return this.startOwned(false);}
  static async startWithDisposableVault() {return this.startOwned(true);}
  private static async startOwned(disposableVault:boolean) {
    if(process.platform!=='linux'||!process.getuid||process.getuid()===0)throw new Error('Native GUI acceptance requires an unprivileged Linux account');
    assertDirectDriverEnvironment(process.env);
    const binary=await executable(join(ROOT,'target/release/lazysh'),'fresh bundled application','lazysh');
    const testWorker=await identity(process.pid);if(!testWorker)throw new Error('Native GUI test worker identity unavailable');
    const directory=await mkdtemp('/tmp/lazysh-native-gui-');
    const fixture=new NativeGui(directory,binary,testWorker,disposableVault);
    try {await fixture.setup();return fixture;}
    catch(error) {try{await fixture.stop();}catch(cleanup){throw new AggregateError([error,cleanup],'Native GUI startup and cleanup failed');}throw error;}
  }
  private async command(stage:string,program:string,args:string[]) {
    return new OwnedProcess(program,args,this.directory,this.env).finish(stage,5000);
  }
  private async setup() {
    await chmod(this.directory,0o700);
    for(const name of ['home','config','data','cache','runtime','services'])await mkdir(join(this.directory,name),{mode:0o700});
    const tools=await Promise.all([
      executable(process.env.LAZYSH_NATIVE_GUI_DRIVER??'','tauri-driver2.1.0','tauri-driver'),
      executable(process.env.LAZYSH_NATIVE_GUI_WEBKIT_DRIVER??'/usr/bin/WebKitWebDriver','matching WebKitWebDriver','WebKitWebDriver'),
      executable(process.env.LAZYSH_NATIVE_GUI_XVFB??'/usr/bin/Xvfb','Xvfb','Xvfb'),
    ]);
    [this.driverFile,this.nativeDriverFile]=tools;
    // tauri-driver2.1.0 has no --version option; verify its pinned Cargo install receipt.
    const receipt=join(dirname(dirname(this.driverFile)),'.crates2.json');
    if((await stat(receipt)).size>64*1024)throw new Error('Native GUI driver install receipt exceeds its bound');
    const installed=JSON.parse(await readFile(receipt,'utf8')).installs?.['tauri-driver 2.1.0 (registry+https://github.com/rust-lang/crates.io-index)'];
    if(installed?.version_req!=='=2.1.0'||!Array.isArray(installed.bins)||!installed.bins.includes('tauri-driver'))throw new Error('Native GUI requires the pinned Cargo tauri-driver2.1.0 installation');
    const busConfig=join(this.directory,'bus.conf');
    await writeFile(busConfig,`<busconfig><type>session</type><listen>unix:path=${this.directory}/runtime/bus</listen><auth>EXTERNAL</auth><servicedir>${this.directory}/services</servicedir><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`,{mode:0o600});
    this.bus=new OwnedProcess('/usr/bin/dbus-daemon',['--nofork','--print-address=1',`--config-file=${busConfig}`],this.directory,this.env);
    this.busAddress=await until('private bus',async()=>{
      if(!await this.bus!.liveIdentity())throw new Error('Owned GUI bus stopped during startup');
      const value=this.bus!.stdout.trim();return /^unix:path=\/[A-Za-z0-9_./-]+(?:,guid=[0-9a-f]+)?$/.test(value)?value:undefined;
    });
    // Keep only the owned path, not DBus's optional connection GUID, in child configuration.
    this.busAddress=this.busAddress.split(',')[0];
    const number=randomInt(1000,10000);
    this.xSocket=`/tmp/.X11-unix/X${number}`;
    for(const path of [this.xSocket,`/tmp/.X${number}-lock`]) {
      if(await lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new Error('Owned GUI display slot was already occupied');
    }
    await writeFile(join(this.directory,'authority'),'',{mode:0o600});
    this.env=guiEnvironment(this.directory,this.busAddress,number);
    await this.command('private X authorization','/usr/bin/xauth',['-f',this.env.XAUTHORITY!,'add',`:${number}`,'.',randomBytes(16).toString('hex')]);
    this.display=new OwnedProcess(tools[2],[`:${number}`,'-screen','0','1280x900x24','-nolisten','tcp','-auth',this.env.XAUTHORITY!],this.directory,this.env);
    await until('owned X display',async()=>{
      const owner=await this.display!.liveIdentity();if(!owner)throw new Error('Owned X display stopped during startup');
      const pid=await readFile(`/tmp/.X${number}-lock`,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
      if(Number(pid.trim())!==owner.pid)return;
      const socket=await lstat(this.xSocket).catch(error=>{if(error.code==='ENOENT')return;throw error;});
      return socket?.isSocket()&&socket.uid===process.getuid!()?true:undefined;
    });
    await new Promise<void>((yes,no)=>{this.listener.once('error',no);this.listener.listen(0,'127.0.0.1',yes);});
    const port=(this.listener.address() as {port:number}).port;
    this.ports.target=port;
    this.clientObserver=new ClientTargetObserver(port,()=>{console.info(`Owned test runner target connection during ${this.stage}`);});
    const config=join(this.directory,'config','app.lazysh.client');await mkdir(config,{mode:0o700});
    await writeFile(join(config,'hosts.json'),JSON.stringify([
      {id:'gui-first',name:'Primary GUI host',hostname:'127.0.0.1',port,username:'owned'},
      {id:'gui-selected',name:'Selected GUI host',hostname:'127.0.0.1',port,username:'owned'},
    ]),{mode:0o600});
    if(process.env.LAZYSH_PUBLISHED_NATIVE_GUI==='1') {
      let kind:'REGULAR'|'RUN_SYMLINK'|'OTHER'|'UNAVAILABLE'='UNAVAILABLE';
      try {
        const link=await lstat('/etc/resolv.conf'),file=await realpath('/etc/resolv.conf'),metadata=await lstat(file);
        if(metadata.isFile() && metadata.size>0 && metadata.size<=65_536) {
          kind=link.isFile()?'REGULAR':link.isSymbolicLink() && file.startsWith('/run/')?'RUN_SYMLINK':'OTHER';
          this.resolverFile=file;
        }
      }catch { /* Emit only the finite classification, never resolver contents or filesystem errors. */ }
      console.info(`Published native resolver kind=${kind}`);
      if(!this.resolverFile)throw new Error('Published native GUI resolver file is unavailable');
    }
    const [driverPort,nativePort]=await driverPorts();
    this.ports.driver=driverPort;this.ports.native=nativePort;assertDistinctPorts(this.ports);
    if(this.disposableVault)await this.startDisposableVault();
    this.driver=this.namespaced(this.driverFile,['--port',String(driverPort),'--native-port',String(nativePort),'--native-host','127.0.0.1','--native-driver',this.nativeDriverFile]);
    await until('owned driver listeners',async()=>await this.ownsListener(driverPort,this.driverFile)&&await this.ownsListener(nativePort,this.nativeDriverFile)?true:undefined);
    await this.assertDisplay();
    const {remote}=await import('webdriverio');
    const capabilities:WebdriverIO.Capabilities&{'tauri:options':{application:string}}={
      'tauri:options':{application:this.binary},'wdio:enforceWebDriverClassic':true,
    };
    this.browser=await remote({hostname:'127.0.0.1',port:driverPort,path:'/',logLevel:'silent',connectionRetryCount:0,connectionRetryTimeout:20_000,
      capabilities});
    const url=new URL(await this.browser.getUrl());
    if(!((url.protocol==='tauri:'&&url.hostname==='localhost')||(url.protocol==='http:'&&url.hostname==='tauri.localhost')))throw new Error('Native GUI did not load its bundled frontend');
    await this.appOwner();
    const digest=createHash('sha256');for await(const chunk of createReadStream(this.binary))digest.update(chunk);
    console.info(`Owned native GUI binary sha256=${digest.digest('hex')}`);
  }
  private namespaced(program:string,args:string[],captureOutput=true) {
    return new OwnedProcess('/usr/bin/bwrap',namespaceArguments(program,args,this.directory,this.home,this.xSocket,[this.binary,this.driverFile,this.nativeDriverFile,...(this.resolverFile?[this.resolverFile]:[]),...(this.secretImage?[this.secretImage]:[])]),this.directory,this.env,captureOutput);
  }
  private async connectionOrigin(socket:Socket) {
    const stage=this.stage;
    const owner=await acceptedConnectionOwner(socket,async()=>[this.testWorker,...(this.driver?await this.processes():[])]);
    const image=owner?.executable;
    const origin=!owner?'unattributed':owner.identity.pid===this.testWorker.pid?'owned test runner':image===this.binary?'owned application':image===this.driverFile?'owned tauri-driver':image===this.nativeDriverFile?'owned WebKit driver':'owned browser child';
    console.info(`Owned native target connection during ${stage}; origin=${origin}`);
  }
  private async assertDisplay() {
    const owner=await this.display?.liveIdentity();
    const number=this.env.DISPLAY?.slice(1);
    if(!owner||!number||Number((await readFile(`/tmp/.X${number}-lock`,'utf8')).trim())!==owner.pid)throw new Error('Owned GUI display identity changed');
  }
  private async processes() {
    const root=await this.driver?.liveIdentity();if(!root)throw new Error('Owned GUI namespace supervisor stopped');
    const items=await descendants(root);
    const retained=new Map(this.members.map(item=>[`${item.pid}:${item.start}`,item]));
    for(const item of items)retained.set(`${item.pid}:${item.start}`,item);
    if(retained.size>128)throw new Error('Owned GUI process history bound exceeded');
    this.members=[...retained.values()];
    return items;
  }
  private async ownsListener(port:number,program:string) {
    const members=await this.processes();
    const inode=listenerInode(await socketInventory(),port);if(!inode)return false;
    const hostNamespace=await readlink('/proc/self/ns/pid');
    for(const item of members) {
      try {
        if(await readlink(`/proc/${item.pid}/exe`)!==program||await readlink(`/proc/${item.pid}/ns/pid`)===hostNamespace||(await stat(`/proc/${item.pid}`)).uid!==process.getuid!())continue;
        for(const fd of (await readdir(`/proc/${item.pid}/fd`)).slice(0,256))if(await readlink(`/proc/${item.pid}/fd/${fd}`).catch(()=>undefined)===`socket:[${inode}]`) {
          return (await identity(item.pid))?.start===item.start;
        }
      } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    return false;
  }
  private busCall(method:'GetNameOwner'|'GetConnectionUnixProcessID'|'NameHasOwner',value:string) {
    return this.command('owned private bus observation','/usr/bin/dbus-send',[
      `--bus=${this.busAddress}`,'--print-reply','--reply-timeout=1000','--dest=org.freedesktop.DBus','/org/freedesktop/DBus',`org.freedesktop.DBus.${method}`,`string:${value}`]);
  }
  private async busName(service:string) {
    const name=(await this.busCall('GetNameOwner',service)).match(/\bstring "(:[0-9]+\.[0-9]+)"/)?.[1];
    if(!name)throw new Error('Owned private bus name unavailable');return name;
  }
  private async startDisposableVault() {
    this.secretImage=await executable(process.env.LAZYSH_NATIVE_GUI_SECRET_SERVICE??'','disposable Secret Service','gnome-keyring-daemon');
    if((await readdir(this.env.XDG_DATA_HOME!)).length)throw new Error('Disposable vault data directory was not empty');
    this.secretService=this.namespaced(this.secretImage,disposableVaultArguments(this.directory),false);
    this.secretService.child.stdin!.end('lazysh-owned-disposable-keyring-only');
    await until('disposable Secret Service',async()=>{
      if(!await this.secretService!.liveIdentity())throw new Error('Disposable Secret Service stopped during startup');
      return /\bboolean true\s*$/.test(await this.busCall('NameHasOwner','org.freedesktop.secrets'))?true:undefined;
    },5000);
    await this.assertSecretServiceOwner();
  }
  private async assertSecretServiceOwner() {
    const root=await this.secretService?.liveIdentity();if(!root)throw new Error('Disposable Secret Service scope unavailable');
    const before=await descendants(root),name=await this.busName('org.freedesktop.secrets');
    // The broker uses its own/test worker's PID namespace, not an assumed global host PID.
    const pid=secretServicePid(await this.busCall('GetConnectionUnixProcessID',name));
    const selected=before.find(item=>item.pid===pid);
    const same=(a:OwnedPid|undefined,b:OwnedPid|undefined)=>!!a&&!!b&&a.pid===b.pid&&a.start===b.start&&a.parent===b.parent&&!['Z','X'].includes(b.state);
    if(!selected||(await stat(`/proc/${pid}`)).uid!==process.getuid!()||await readlink(`/proc/${pid}/exe`)!==this.secretImage||!same(selected,await identity(pid))
      ||await readlink(`/proc/${pid}/ns/pid`)===await readlink('/proc/self/ns/pid'))throw new Error('Disposable Secret Service owner is not the owned daemon');
    if(await this.busName('org.freedesktop.secrets')!==name||!same(root,await this.secretService?.liveIdentity()))throw new Error('Disposable Secret Service ownership changed');
    const after=await descendants(root);
    if(!same(selected,after.find(item=>item.pid===pid))||!same(selected,await identity(pid))||await readlink(`/proc/${pid}/exe`)!==this.secretImage)throw new Error('Disposable Secret Service ancestry changed');
    const retained=new Map(this.secretMembers.map(item=>[`${item.pid}:${item.start}`,item]));
    for(const item of after)retained.set(`${item.pid}:${item.start}`,item);
    this.secretMembers=[...retained.values()];
  }
  async assertDisposableCredential(expected:'empty'|'saved'|'unchanged') {
    await this.assertSecretServiceOwner();
    const reply=await this.command('owned credential item metadata','/usr/bin/dbus-send',[
      `--bus=${this.busAddress}`,'--print-reply','--reply-timeout=1000','--dest=org.freedesktop.secrets','/org/freedesktop/secrets',
      'org.freedesktop.Secret.Service.SearchItems','dict:string:string:service,app.lazysh.client.credentials']);
    const items=credentialItemPaths(reply);
    if(expected==='empty') {if(items.length)throw new Error('Disposable credential was not absent');}
    else {
      if(items.length!==1)throw new Error('Disposable credential item was not unique');
      if(expected==='saved') {if(this.credentialItem!==undefined)throw new Error('Disposable credential baseline was already captured');this.credentialItem=items[0];}
      else if(items[0]!==this.credentialItem)throw new Error('Disposable credential item identity changed');
    }
    await this.assertSecretServiceOwner();
  }
  private async stopDisposableVault() {
    if(!this.secretService)return;
    await this.secretService.stop();
    await until('disposable Secret Service retirement',async()=>{
      const live=await Promise.all(this.secretMembers.map(async item=>(await identity(item.pid))?.start===item.start));
      return live.some(Boolean)?undefined:true;
    },2000);
    if(!/\bboolean false\s*$/.test(await this.busCall('NameHasOwner','org.freedesktop.secrets')))throw new Error('Disposable Secret Service name survived cleanup');
  }
  async appOwner():Promise<AppOwner> {
    await this.assertDisplay();
    const name=await this.busName(BUS_NAME);
    const pid=Number((await this.busCall('GetConnectionUnixProcessID',name)).match(/\buint32 ([0-9]+)/)?.[1]);
    const owned=(await this.processes()).find(item=>item.pid===pid);
    if(!owned||await readlink(`/proc/${pid}/exe`)!==this.binary||(await identity(pid))?.start!==owned.start)throw new Error('Singleton owner is not the owned GUI binary');
    return {name,pid,start:owned.start};
  }
  async secondary(args:string[],cwd=this.directory) {
    const canonical=await realpath(cwd);
    if(canonical!==this.directory && !canonical.startsWith(this.directory+'/'))throw new Error('Secondary cwd must stay within the owned fixture');
    const original=await this.appOwner();
    await this.namespaced('/usr/bin/env',['--chdir',canonical,this.binary,...args]).finish('actual secondary CLI handoff',10_000);
    const current=await this.appOwner();
    if(JSON.stringify(current)!==JSON.stringify(original))throw new Error('Secondary CLI replaced the original GUI owner');
    if((await this.browser!.getWindowHandles()).length!==1)throw new Error('Secondary CLI created another native window');
  }
  async screenshot() {
    await this.appOwner();
    const directory=resolve(ROOT,'apps/client/test-results/native-gui');await mkdir(directory,{recursive:true});
    await this.browser?.saveScreenshot(join(directory,'owned-synthetic-window.png'));
  }
  async stop() {
    const failures:unknown[]=[];
    for(const cleanup of [
      async()=>{await Promise.all(this.probes);},
      async()=>{if(this.browser)await this.browser.deleteSession();},
      async()=>{if(this.driver){if(await this.driver.liveIdentity())await this.processes();await this.driver.stop();}},
      async()=>{await until('owned namespace retirement',async()=>{
        const live=await Promise.all(this.members.map(async item=>(await identity(item.pid))?.start===item.start));
        return live.some(Boolean)?undefined:true;
      },2000);},
      async()=>{await this.stopDisposableVault();},
      async()=>{if(this.display)await this.display.stop();},
      async()=>{if(this.bus)await this.bus.stop();},
      async()=>{if(this.clientObserver){this.clientObserver.stop();console.info(`Owned test-worker observer: ${this.clientObserver.status()}; target connections=${this.clientObserver.targetConnections}`);}},
      async()=>{if(this.listener.listening)await new Promise<void>((yes,no)=>this.listener.close(error=>error?no(error):yes()));},
      async()=>{await rm(this.directory,{recursive:true,force:true});},
    ])try{await cleanup();}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Owned native GUI cleanup failed');
  }
}
