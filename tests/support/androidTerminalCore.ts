import {readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {OwnedProcess,SshFixture,androidSshCleanup,nativeReportCases,ownedDeviceCleanup,ownedEmulator} from './androidSsh';

const nativeClass='app.lazysh.client.NativeTerminalCoreTest';
const nativeCase='theCoreInsideTheAppParsesTheOutputOfARealShellAndReadsItBack';

/** Requires the one on-device case to have run exactly once and passed, so a filtered, skipped or failed run cannot count. */
export function validateTerminalCoreReport(text:string) {
  const {cases,failed}=nativeReportCases(text);
  if(failed || cases.length!==1 || cases[0].className!==nativeClass || cases[0].name!==nativeCase)
    throw new Error('The terminal core native case did not pass exactly once');
}

/**
 * The real terminal core inside the packaged app (#2145): an owned OpenSSH on this host is the local process whose shell output the app's
 * core parses, reached from the device over `adb reverse`; the instrumentation case drives the renderer's own IPC against it. Needs the
 * x86_64 debug APK built with `--features native-terminal` and one explicitly selected device: an owned emulator or the Waydroid guest.
 */
export async function androidTerminalCoreAcceptance(root=resolve(import.meta.dir,'../..')) {
  const {device}=ownedEmulator('terminal core acceptance',true);
  const fixture=await SshFixture.start();
  const reverses:number[]=[];
  let remote:string|undefined,primary=false;
  try {
    await device(['reverse','--no-rebind',`tcp:${fixture.port}`,`tcp:${fixture.port}`]);reverses.push(fixture.port);
    remote=`/data/local/tmp/lazysh-ui-ssh-${fixture.nonce}`;
    await device(['shell','mkdir','-m','700',remote]);
    const data=join(fixture.directory,'android-terminal-core-fixture.json');
    const {nonce,port,username,privateKey,fingerprint,prompt,challenge,expected}=fixture;
    await writeFile(data,JSON.stringify({nonce,port,username,privateKey,fingerprint,prompt,challenge,expected}),{mode:0o600});
    await device(['push',data,`${remote}/fixture.json`]);
    await device(['shell','chmod','600',`${remote}/fixture.json`]);
    const android=join(root,'apps/client/src-tauri/gen/android');
    const report=join(android,'app/build/outputs/androidTest-results/terminal-core-ui');
    await rm(report,{recursive:true,force:true});
    await new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug','-PlazyshTerminalCoreAcceptance=true',
      `-Pandroid.testInstrumentationRunnerArguments.class=${nativeClass}#${nativeCase}`,
      `-Pandroid.testInstrumentationRunnerArguments.lazyshSshFixture=${remote}/fixture.json`],root).finish('actual Android terminal core instrumentation',900_000);
    const reports=(await readdir(report,{recursive:true})).filter(name=>name.endsWith('.xml'));
    if(reports.length!==1)throw new Error('Expected one native terminal core report');
    validateTerminalCoreReport(await readFile(join(report,reports[0]),'utf8'));
    console.log('Owned Android terminal core: the real core in the app parsed the output of an owned OpenSSH shell and returned it through terminal_core_text');
  } catch(error){primary=true;throw error;}
  finally {await androidSshCleanup(primary,[...ownedDeviceCleanup(device,{reverses,remote}),['SSH',()=>fixture.stop()]]);}
}
