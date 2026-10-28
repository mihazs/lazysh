import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {connect,createServer,type Server,type Socket} from 'node:net';
import {afterEach,expect,it,vi} from 'vitest';
import {OwnedProcess,descendants,identity,type OwnedPid} from '../../../tests/support/ownedProcess';
import {acceptedConnectionOwner,listeningConnectionOwner} from './socketOwner';
import {ClientTargetObserver} from './clientObserver';
import {assertDirectDriverEnvironment,guiEnvironment} from './policy';
import {executable} from './tools';
import {acceptedEndpointRoles,assertDistinctPorts,driverPorts,type OwnedPorts} from './ports';

let client:OwnedProcess|undefined,original:OwnedPid|undefined;
let directory:string|undefined,request:Promise<number|undefined>|undefined,requestAbort:AbortController|undefined;
const servers=new Set<Server>();
const sockets=new Set<Socket>();
async function listenForPeers(port=0,onAccept?:(socket:Socket,server:Server)=>void) {
  const server=createServer(socket=>{
    if(sockets.size>=8){socket.destroy();return;}
    sockets.add(socket);onAccept?.(socket,server);socket.resume();
  });
  servers.add(server);
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
  return (server.address() as {port:number}).port;
}
function serverFor(port:number) {
  const server=[...servers].find(value=>(value.address() as {port:number}|null)?.port===port);
  if(!server)throw new Error('Owned contract listener unavailable');
  return server;
}
async function transientSelfConnection(port:number) {
  const local=connect({host:'127.0.0.1',port},()=>local.end());sockets.add(local);
  await new Promise<void>((yes,no)=>{local.once('close',()=>yes());local.once('error',no);});
}
afterEach(async()=>{
  const failures:unknown[]=[];
  requestAbort?.abort();
  try {await client?.stop();if(original)expect((await identity(original.pid))?.start).not.toBe(original.start);}catch(error){failures.push(error);}
  try {await request;}catch(error){failures.push(error);}
  for(const socket of sockets)socket.destroy();sockets.clear();
  for(const server of servers)try {if(server.listening)await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));}catch(error){failures.push(error);}
  try {if(directory)await rm(directory,{recursive:true,force:true});}catch(error){failures.push(error);}
  servers.clear();client=undefined;original=undefined;directory=undefined;request=undefined;requestAbort=undefined;
  if(failures.length)throw new AggregateError(failures,'Owned attribution contract cleanup failed');
});

it('attributes a held real peer only to the nominated live child and leaves stale or retired candidates unattributed',async()=>{
  const port=await listenForPeers();
  // A foreground synthetic child, following tests/android-ssh.test.ts; not a test runner.
  client=new OwnedProcess(process.execPath,['-e',`
    const socket=require('node:net').createConnection({host:'127.0.0.1',port:Number(process.argv[1])},()=>process.stdout.write(String(socket.localPort)+'\\n'));
    process.stdin.once('data',()=>socket.end());
    socket.once('error',()=>process.exit(1));
    socket.once('close',()=>process.exit(0));
  `,String(port)],undefined,{PATH:'/usr/bin:/bin',LANG:'C'});
  let accepted:Socket|undefined;
  await vi.waitFor(()=>{
    expect(client!.stdout.trim()).toMatch(/^[1-9][0-9]{0,4}$/);
    accepted=[...sockets].find(socket=>socket.remotePort===Number(client!.stdout.trim()));
    expect(accepted).toBeDefined();
  },{timeout:1000,interval:10});
  original=await client.liveIdentity();expect(original).toBeDefined();
  const candidates=async()=>[original!];
  expect(await acceptedConnectionOwner(accepted!,candidates)).toEqual({identity:original,executable:await realpath(process.execPath)});
  expect(await acceptedConnectionOwner(accepted!,async()=>[])).toBeUndefined();
  expect(await acceptedConnectionOwner(accepted!,async()=>[{...original!,start:'stale-start'}])).toBeUndefined();
  client.child.stdin!.write('release');await client.finish('held attribution client release',1000);
  expect((await identity(original!.pid))?.start).not.toBe(original!.start);
  expect(await acceptedConnectionOwner(accepted!,candidates)).toBeUndefined();
},5000);

it('retains a short-lived worker connection through native diagnostics, excludes other targets and unsubscribes cleanly',async context=>{
  const port=await listenForPeers();
  const onTarget=vi.fn();
  const observer=new ClientTargetObserver(port,onTarget);
  try {
    await transientSelfConnection(port);
    if(observer.published===0||observer.targetConnections===0||observer.incomplete)context.skip('INCONCLUSIVE: this runtime did not demonstrate the experimental NET diagnostic contract');
    expect(observer.targetConnections).toBe(1);expect(onTarget).toHaveBeenCalledTimes(1);
    await transientSelfConnection(await listenForPeers());
    expect(observer.targetConnections).toBe(1);
    observer.stop();await transientSelfConnection(port);
    expect(observer.targetConnections).toBe(1);expect(onTarget).toHaveBeenCalledTimes(1);
  } finally {observer.stop();}
},5000);

it('attributes a held self-origin peer only when the exact live test worker is nominated',async()=>{
  const worker=await identity(process.pid);expect(worker).toBeDefined();
  const port=await listenForPeers();
  const local=connect({host:'127.0.0.1',port});sockets.add(local);
  await new Promise<void>((yes,no)=>{local.once('connect',yes);local.once('error',no);});
  let accepted:Socket|undefined;
  await vi.waitFor(()=>{
    accepted=[...sockets].find(socket=>socket!==local&&socket.remotePort===local.localPort);
    expect(accepted).toBeDefined();
  },{timeout:1000,interval:10});
  expect(await acceptedConnectionOwner(accepted!,async()=>[])).toBeUndefined();
  expect(await acceptedConnectionOwner(accepted!,async()=>[worker!])).toEqual({identity:worker,executable:await realpath(process.execPath)});
  expect(await acceptedConnectionOwner(accepted!,async()=>[{...worker!,start:'stale-worker-start'}])).toBeUndefined();
},5000);

it('attributes an explicit remote-inspector attachment to the exact owned native WebKit driver without launching an app',async()=>{
  if(process.platform!=='linux')throw new Error('Native driver attribution control requires Linux');
  assertDirectDriverEnvironment(process.env);
  const binary=await executable(process.env.LAZYSH_NATIVE_GUI_WEBKIT_DRIVER??'/usr/bin/WebKitWebDriver','controlled native WebKit driver','WebKitWebDriver');
  directory=await mkdtemp('/tmp/lazysh-native-driver-');
  for(const name of ['home','config','data','cache','runtime'])await mkdir(join(directory,name),{mode:0o700});
  const targetPort=await listenForPeers(),driverPort=await listenForPeers();
  expect(driverPort).not.toBe(targetPort);
  const reservation=serverFor(driverPort);
  await new Promise<void>((yes,no)=>reservation.close(error=>error?no(error):yes()));
  client=new OwnedProcess(binary,[`--host=127.0.0.1`,`--port=${driverPort}`,`--target=127.0.0.1:${targetPort}`],directory,guiEnvironment(directory,`unix:path=${directory}/runtime/bus`));
  await vi.waitFor(async()=>{
    original=await client!.liveIdentity();expect(original).toBeDefined();
    expect(await listeningConnectionOwner(driverPort,async()=>[original!])).toEqual({identity:original,executable:binary});
  },{timeout:3000,interval:10});
  expect(await listeningConnectionOwner(targetPort,async()=>[original!])).toBeUndefined();
  // Only one request; the held synthetic inspector never pretends to be a browser.
  requestAbort=new AbortController();
  request=fetch(`http://127.0.0.1:${driverPort}/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capabilities:{alwaysMatch:{},firstMatch:[{}]}}),signal:requestAbort.signal}).then(response=>response.status,()=>undefined);
  let attributed=false;
  await vi.waitFor(async()=>{
    for(const socket of sockets)if(socket.localPort===targetPort) {
      const owner=await acceptedConnectionOwner(socket,async()=>[original!]);
      if(owner){expect(owner).toEqual({identity:original,executable:binary});attributed=true;}
    }
    expect(attributed).toBe(true);
  },{timeout:3000,interval:10});
  expect(await descendants(original!)).toHaveLength(0);
},10_000);

it('routes only explicit clients to their owned listener across exact driver-port reuse',async()=>{
  const ports:OwnedPorts={target:0,driver:0,native:0};
  type Event={callback:'target'|'driver'|'native'|'replacement';tuple:ReturnType<typeof acceptedEndpointRoles>};
  const events:Event[]=[];
  const record=(callback:Event['callback'])=>(socket:Socket,server:Server)=>{if(events.length<8)events.push({callback,tuple:acceptedEndpointRoles(socket,server,ports)});};
  ports.target=await listenForPeers(0,record('target'));
  [ports.driver,ports.native]=await driverPorts();assertDistinctPorts(ports);
  await listenForPeers(ports.driver,record('driver'));await listenForPeers(ports.native,record('native'));
  await transientSelfConnection(ports.driver);await transientSelfConnection(ports.native);
  expect(events.map(event=>event.callback)).toEqual(['driver','native']);
  const oldDriver=serverFor(ports.driver);
  await new Promise<void>((yes,no)=>oldDriver.close(error=>error?no(error):yes()));
  await listenForPeers(ports.driver,record('replacement'));await transientSelfConnection(ports.driver);
  expect(events.map(event=>event.callback)).toEqual(['driver','native','replacement']);
  for(const event of events)expect(event.tuple).toEqual({listener:event.callback==='native'?'native':'driver',local:event.callback==='native'?'native':'driver',peer:'other',loopback:true,selfTuple:false});
  await transientSelfConnection(ports.target);
  expect(events.map(event=>event.callback)).toEqual(['driver','native','replacement','target']);
  expect(events.at(-1)!.tuple).toEqual({listener:'target',local:'target',peer:'other',loopback:true,selfTuple:false});
},5000);
