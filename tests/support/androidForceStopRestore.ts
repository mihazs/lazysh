import {join,resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {OwnedProcess,androidSshCleanup,ownedDeviceCleanup,ownedEmulator,prepareOwnedDevice,type OwnedDeviceState} from './androidSsh';
import {TmuxFixture} from './androidTmux';
import {HerdrFixture,herdrTools} from './androidHerdr';
import {ZellijFixture} from './androidZellij';
import {close,listen,nonceControl,type Control} from './androidSshParity';

/** The two halves of the owned restore-after-force-stop cases (#1639, #1827); each runs in its own instrumentation process. */
export const restoreCases={
  tmux:{before:'ownedTmuxRestoreBeforeForceStop',after:'ownedTmuxRestoreAfterForceStop'},
  herdr:{before:'ownedHerdrRestoreBeforeForceStop',after:'ownedHerdrRestoreAfterForceStop'},
  zellij:{before:'ownedZellijRestoreBeforeForceStop',after:'ownedZellijRestoreAfterForceStop'},
} as const;
export type RestoreKind=keyof typeof restoreCases;
const nativeClass='app.lazysh.client.NativeWorkspaceTest';
const appPackage='app.lazysh.client',testPackage='app.lazysh.client.test';
const runner='androidx.test.runner.AndroidJUnitRunner';

/**
 * The verdict of one raw `am instrument -r` run: exactly `name` started and passed, the instrumentation itself finished
 * cleanly, and nothing else ran. `am` exits 0 whatever the tests did, so the output is the only evidence. A failure keeps a
 * bounded excerpt of the case's own assertion text (synthetic fixture data only) so the job log says which stage failed.
 */
export function validateInstrumentationRun(output:string,name:string) {
  const blocks=[...output.matchAll(/((?:INSTRUMENTATION_STATUS: [^\n]*\n(?:(?!INSTRUMENTATION_)[^\n]*\n)*)+)INSTRUMENTATION_STATUS_CODE: (-?[0-9]+)/g)]
    .map(([,text,code])=>({code:Number(code),test:/INSTRUMENTATION_STATUS: test=(\S+)/.exec(text)?.[1],cls:/INSTRUMENTATION_STATUS: class=(\S+)/.exec(text)?.[1],text}));
  const codes=blocks.map(block=>block.code);
  const finished=/^INSTRUMENTATION_CODE: -1$/m.test(output) && !/^INSTRUMENTATION_(?:RESULT: (?:shortMsg|longMsg)=|FAILED)/m.test(output);
  if(finished && codes.length===2 && codes[0]===1 && codes[1]===0 && blocks.every(block=>block.test===name && block.cls===nativeClass))return;
  const stack=blocks.find(block=>block.code<0)?.text.match(/INSTRUMENTATION_STATUS: stack=([\s\S]*)/)?.[1]??'';
  throw new Error(`Owned Android ${name} did not pass exactly once; status codes [${codes.join(',')}], finished=${finished}${stack?`\n${stack.slice(0,2000)}`:''}`);
}

/** The instrumentation's only host channel: `observe` replies the closed facts (display clients, and for Herdr whether the receiver holds the typed bytes) after checking the original processes. */
export const restoreControl=(host:{observe():Promise<{clients:number}&Record<string,unknown>>},nonce:string):Control=>nonceControl(nonce,{
  // The control only replies `failed`; the job log keeps which closed check refused (fixed messages, no pane text).
  observe:()=>host.observe().catch(error=>{console.error(`Owned restore observation refused: ${error instanceof Error?error.message:'unknown'}`);throw error;}),
});

/** What the case needs from the fixture of one multiplexer: its SSH host, the closed fixture metadata, one host sample, and whether the typed bytes survived. */
type RestoreHost={ssh:SshFixture;token:string;fixture:Record<string,unknown>;observe():Promise<{clients:number}&Record<string,unknown>>;survives():Promise<boolean>;stop():Promise<void>};
const restoreToken=(ssh:SshFixture)=>`RESTORE_${ssh.nonce}`;
const restoreHosts:Record<RestoreKind,()=>Promise<RestoreHost>>={
  // The pane runs a plain `sleep`, so its tty echoes what the app types and tmux keeps it on screen.
  async tmux() {
    const owned=await TmuxFixture.start(),token=restoreToken(owned.ssh);
    return {ssh:owned.ssh,token,fixture:{tmux:owned.metadata()},observe:async()=>({clients:await owned.observe()}),survives:()=>owned.paneHolds(0,token),stop:()=>owned.stop()};
  },
  // The receiver records every byte it is sent and echoes none, so the host's byte file is the only evidence of what arrived.
  async herdr() {
    const owned=await HerdrFixture.start(herdrTools(),undefined,true),token=restoreToken(owned.ssh);
    return {ssh:owned.ssh,token,fixture:{herdr:owned.metadata()},observe:()=>owned.observeRestore(token),survives:()=>owned.restoreBytesHold(token),stop:()=>owned.stop()};
  },
  // The saved host names its default session before the fixture exists, so the session has a fixed name. The case jumps to the second tab and types there.
  async zellij() {
    const owned=await ZellijFixture.start(undefined,'owned-zellij'),token=restoreToken(owned.ssh);
    return {ssh:owned.ssh,token,fixture:{zellij:owned.metadata()},observe:()=>owned.observeRestore(),survives:()=>owned.paneHolds(token),stop:()=>owned.stop()};
  },
};

/**
 * Owned emulator only. Installs both APKs once, runs `before` in one instrumentation process, force-stops the app from the
 * host, checks that the pinned tmux, Zellij or stock Herdr server, its panes or receivers and the typed bytes survived with no client
 * attached, then runs `after` in a fresh process. The app's own data (hosts, saved credential, WebView storage) is what carries between them.
 */
export async function androidForceStopRestoreAcceptance(kind:RestoreKind='tmux',root=resolve(import.meta.dir,'../..')) {
  const emulator=ownedEmulator('force-stop restore acceptance'),{adb,serial,device}=emulator,cases=restoreCases[kind];
  const state:OwnedDeviceState={reverses:[]};
  let owned:RestoreHost|undefined,control:Awaited<ReturnType<typeof listen>>['server']|undefined,installed=false;
  let primary=false;
  const android=join(root,'apps/client/src-tauri/gen/android');
  const results=join(android,'app/build/outputs/androidTest-results/force-stop-restore-ui');
  try {
    owned=await restoreHosts[kind]();
    const ssh=owned.ssh,token=owned.token;
    const channel=await listen(restoreControl(owned,ssh.nonce));
    control=channel.server;
    const fixture=await prepareOwnedDevice(emulator,state,[ssh.port,channel.port],ssh,{nonce:ssh.nonce,username:ssh.username,controlPort:channel.port,
      privateKey:ssh.privateKey,restoreToken:token,primary:{port:ssh.port,fingerprint:ssh.fingerprint,prompt:ssh.prompt},...owned.fixture});
    await mkdir(results,{recursive:true});
    installed=true;
    await new OwnedProcess(join(android,'gradlew'),['-p',android,':app:installUniversalDebug',':app:installUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug'],root).finish('Android restore APK install',600_000);
    // The standard runner arguments the Gradle task would add: the shared native activity must outlive each test method.
    const instrument=async(name:string,phase:string)=>{
      const output=await new OwnedProcess(adb,['-s',serial,'shell','am','instrument','-w','-r','-e','class',`${nativeClass}#${name}`,
        '-e','waitForActivitiesToComplete','false','-e','lazyshSshFixture',fixture,`${testPackage}/${runner}`]).finish(`Android restore ${phase}`,300_000);
      await writeFile(join(results,`${phase}.txt`),output,{mode:0o600});
      validateInstrumentationRun(output,name);
    };
    await instrument(cases.before,'before-force-stop');

    await device(['shell','am','force-stop',appPackage]);
    if((await device(['shell',`pidof ${appPackage} || true`])).trim())throw new Error('Owned Android app survived the force-stop');
    // The pane must outlive the app unattended: its server and panes are the originals, no client is left, and the typed bytes are still there.
    const deadline=performance.now()+20_000;
    while((await owned.observe()).clients!==0) {
      if(performance.now()>=deadline)throw new Error(`Force-stopped application left its ${kind} client attached`);
      await delay(100);
    }
    if(!await owned.survives())throw new Error(`Owned ${kind} pane lost the bytes typed before the force-stop`);

    await instrument(cases.after,'after-force-stop');
    await owned.observe();
    console.log(`Owned Android restore after a force-stop: offer only on click, the same ${kind} display and typed bytes, exactly one client and the saved credential verified`);
  } catch(error){primary=true;throw error;}
  finally {
    await androidSshCleanup(primary,[
      ...ownedDeviceCleanup(device,state),
      ...(installed?[
        ['test-package',()=>device(['uninstall',testPackage])] as const,
        ['app-package',()=>device(['uninstall',appPackage])] as const,
      ]:[]),
      ['control',()=>control?close(control):Promise.resolve()],
      [kind==='tmux'?'tmux':kind==='zellij'?'Zellij':'Herdr',()=>owned?.stop()??Promise.resolve()],
    ]);
  }
}
