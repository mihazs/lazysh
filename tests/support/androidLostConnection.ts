import {join,resolve} from 'node:path';
import {readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {OwnedProcess,androidSshCleanup,nativeReportCases,ownedDeviceCleanup,ownedEmulator,ownedSoftwareKeyboard} from './androidSsh';
import {TmuxFixture} from './androidTmux';
import {close,listen,type Control} from './androidSshParity';
import {OwnedSshRelay} from '../../apps/client/native-e2e/sshRelay';

/** The owned lost-connection instrumentation case (#1640), run in the tmux job against the pinned tmux. */
export const lostConnectionCase='ownedTmuxLostConnectionThroughRealUi';
const nativeClass='app.lazysh.client.NativeWorkspaceTest';

/** Requires the case to have run exactly once and passed, so a filtered or skipped case cannot count. */
export function validateLostConnectionReport(text:string) {
  const {cases,failed}=nativeReportCases(text);
  if(failed || cases.length!==1 || cases[0].className!==nativeClass || cases[0].name!==lostConnectionCase)
    throw new Error('Owned lost-connection native case did not pass exactly once');
  return cases.length;
}

type Route=Pick<OwnedSshRelay,'block'|'unblock'|'refused'|'active'>;
/**
 * The instrumentation's only host channel. `cut` drops the owned route and refuses new connections,
 * `restore` lets them through again, and `observe` replies the closed facts a case asserts on: the
 * tmux display clients (after checking the original server and panes), refused attempts and live streams.
 */
export function lostConnectionControl(route:Route,tmux:{observe():Promise<number>},nonce:string):Control {
  return {reply:async request=>{
    if(!request || typeof request!=='object')throw new Error('request');
    const {nonce:owner,action}=request as Record<string,unknown>;
    if(owner!==nonce)throw new Error('nonce');
    if(action==='cut'){route.block();return {};}
    if(action==='restore'){route.unblock();return {};}
    if(action==='observe')return {clients:await tmux.observe(),refused:route.refused,active:route.active};
    throw new Error('action');
  }};
}

/**
 * Owned emulator only. Starts the pinned tmux fixture behind a relay the host can cut, reverses only the
 * relay and control ports, and runs the lost-connection case with that control channel.
 */
export async function androidLostConnectionAcceptance(root=resolve(import.meta.dir,'../..')) {
  const {serial,adb,device}=ownedEmulator('lost-connection acceptance');
  const reverses:number[]=[];
  let owned:TmuxFixture|undefined,relay:OwnedSshRelay|undefined,keyboard:Awaited<ReturnType<typeof ownedSoftwareKeyboard>>|undefined;
  let control:Awaited<ReturnType<typeof listen>>['server']|undefined,remote:string|undefined;
  let primary=false;
  try {
    owned=await TmuxFixture.start();
    const ssh=owned.ssh;
    relay=await OwnedSshRelay.start(ssh.port);
    const channel=await listen(lostConnectionControl(relay,owned,ssh.nonce));
    control=channel.server;
    for(const port of [relay.port,channel.port]) {
      await device(['reverse','--no-rebind',`tcp:${port}`,`tcp:${port}`]);
      reverses.push(port);
    }
    keyboard=await ownedSoftwareKeyboard(adb,serial,5000,'aosp-latin');
    remote=`/data/local/tmp/lazysh-ui-ssh-${ssh.nonce}`;
    await device(['shell','mkdir','-m','700',remote]);
    const data=join(ssh.directory,'android-lost-connection-fixture.json');
    await writeFile(data,JSON.stringify({nonce:ssh.nonce,username:ssh.username,controlPort:channel.port,privateKey:ssh.privateKey,
      primary:{port:relay.port,fingerprint:ssh.fingerprint,prompt:ssh.prompt},tmux:owned.metadata()}),{mode:0o600});
    if((await stat(data)).size>16*1024)throw new Error('Owned Android lost-connection fixture exceeds native bound');
    await device(['push',data,`${remote}/fixture.json`]);
    await device(['shell','chmod','600',`${remote}/fixture.json`]);
    const android=join(root,'apps/client/src-tauri/gen/android');
    const report=join(android,'app/build/outputs/androidTest-results/lost-connection-ui');
    await rm(report,{recursive:true,force:true});
    await new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug','-PlazyshLostConnectionAcceptance=true',
      `-Pandroid.testInstrumentationRunnerArguments.class=${nativeClass}#${lostConnectionCase}`,
      `-Pandroid.testInstrumentationRunnerArguments.lazyshSshFixture=${remote}/fixture.json`],root).finish('actual Android lost-connection instrumentation',600_000);
    const reports=(await readdir(report,{recursive:true})).filter(name=>name.endsWith('.xml')).map(name=>join(report,name));
    if(reports.length!==1)throw new Error('Expected one owned lost-connection native report');
    validateLostConnectionReport(await readFile(reports[0],'utf8'));
    console.log('Owned Android lost connection: banner, refused automatic retries, same tmux pane after the route returned and Close without reconnect verified');
  } catch(error){primary=true;throw error;}
  finally {
    await androidSshCleanup(primary,[
      ...ownedDeviceCleanup(device,{keyboard,reverses,remote}),
      ['control',()=>Promise.all([control?close(control):undefined,relay?.stop()])],
      ['tmux',()=>owned?.stop()??Promise.resolve()],
    ]);
  }
}
