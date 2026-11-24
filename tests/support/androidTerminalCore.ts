import {cp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {OwnedProcess,SshFixture,androidSshCleanup,nativeReportCases,ownedDeviceCleanup,ownedEmulator} from './androidSsh';

const nativeClass='app.lazysh.client.NativeTerminalCoreTest';
const compositionClass='app.lazysh.client.NativeTerminalCompositionTest';
/** Where the cases leave what they measured (`Evidence.kt`); it outlives the uninstall Gradle does at the end of a run. */
const evidenceDirectory='/data/local/tmp/lazysh-evidence';

/** Moves the evidence files of the run (measurements and pictures) from the device to `destination` (the results directory the job uploads) and prints each measurement, so the job's log has what the device answered. */
export async function keepDeviceEvidence(device:(args:string[])=>Promise<string>,destination:string) {
  const names=(await device(['shell','ls',evidenceDirectory]).catch(()=>'')).split('\n').map(name=>name.trim()).filter(name=>/^[a-z0-9-]{1,40}[.](json|png)$/.test(name));
  await mkdir(destination,{recursive:true});
  for(const name of names) {
    // A picture is copied as it is; a measurement is JSON, parsed so that a truncated write is refused and printed for the log.
    if(name.endsWith('.png')) {await device(['pull',`${evidenceDirectory}/${name}`,join(destination,name)]);continue;}
    const text=await device(['shell','cat',`${evidenceDirectory}/${name}`]);
    JSON.parse(text);
    await writeFile(join(destination,name),text);
    console.log(`Device evidence ${name}: ${text.replace(/\s+/g,' ')}`);
  }
  return names;
}

type Cases=readonly (readonly [string,string])[];

/** Requires every case to have run exactly once and passed, so a filtered, skipped or failed run cannot count. */
function validateCases(text:string,expected:Cases) {
  const {cases,failed}=nativeReportCases(text);
  if(failed || cases.length!==expected.length || !expected.every(([className,name])=>cases.filter(found=>found.className===className && found.name===name).length===1))
    throw new Error('The terminal core native cases did not pass exactly once');
}

/** What one owned-device run of native-terminal instrumentation classes needs: the classes, the cases that must each pass once, and where the results go. */
export type TerminalCaseRun={title:string;classes:readonly string[];cases:Cases;evidenceName:string;evidence:readonly string[];arguments?:readonly string[];ssh?:{exec?:boolean;shellSeconds?:number}};

/**
 * The real terminal core inside the packaged app (#2145): an owned OpenSSH on this host is the local process whose shell output the app's
 * core parses, reached from the device over `adb reverse`; the instrumentation cases drive the renderer's own IPC (and, for the session
 * cases, the real page) against it. Needs the x86_64 debug APK built with `--features native-terminal` and one explicitly selected device:
 * an owned emulator or the Waydroid guest.
 */
export async function runTerminalCases(run:TerminalCaseRun,root=resolve(import.meta.dir,'../..')) {
  const {device}=ownedEmulator(run.title,true);
  const fixture=await SshFixture.start(undefined,run.ssh);
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
    const results=join(android,'app/build/outputs/androidTest-results');
    // build.gradle.kts keeps this property's results in one directory, whichever classes ran.
    const report=join(results,'terminal-core-ui');
    await rm(report,{recursive:true,force:true});
    await device(['shell','rm','-rf','--',evidenceDirectory]);
    // A failed case leaves the most useful evidence (the pictures and measurements up to the failure), so it is kept before the failure is raised.
    const evidenceTo=join(results,run.evidenceName);
    const gradle=new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug','-PlazyshTerminalCoreAcceptance=true',
      `-Pandroid.testInstrumentationRunnerArguments.class=${run.classes.join(',')}`,
      `-Pandroid.testInstrumentationRunnerArguments.lazyshSshFixture=${remote}/fixture.json`,
      ...(run.arguments??[]).map(argument=>`-Pandroid.testInstrumentationRunnerArguments.${argument}`)],root);
    // Gradle writes the report of every run into the same directory, so a job that runs several keeps each one's beside its evidence.
    const keepReport=()=>cp(report,join(evidenceTo,'report'),{recursive:true}).catch(()=>undefined);
    try { await gradle.finish(`actual Android ${run.title} instrumentation`,900_000); }
    catch(failure) {
      // Gradle's own words (a compile error of the test APK, a refused install) are the only explanation of a run that never reached a case.
      console.error(`Gradle output, last 6000 characters:\n${(gradle.stdout+gradle.stderr).slice(-6000)}`);
      await keepDeviceEvidence(device,evidenceTo).catch(()=>[]);
      await keepReport();
      throw failure;
    }
    await keepReport();
    const reports=(await readdir(report,{recursive:true})).filter(name=>name.endsWith('.xml'));
    if(reports.length!==1)throw new Error(`Expected one ${run.title} report`);
    validateCases(await readFile(join(report,reports[0]),'utf8'),run.cases);
    const kept=await keepDeviceEvidence(device,evidenceTo);
    for(const name of run.evidence)if(!kept.includes(name))throw new Error(`The ${run.title} left no ${name}`);
  } catch(error){primary=true;throw error;}
  finally {await androidSshCleanup(primary,[...ownedDeviceCleanup(device,{reverses,remote}),['SSH',()=>fixture.stop()]]);}
}

const coreCases=[[nativeClass,'theCoreInsideTheAppParsesTheOutputOfARealShellAndReadsItBack'],[nativeClass,'theProbeRefusesASoftwareRasterizerUnlessTheDebugSwitchAllowsOne'],
  [compositionClass,'thePageShowsTheSurfaceThroughItsNativePaneWithItsOverlayAboveAndTheWebViewIsOpaqueAgainWhenItEnds'],
  [compositionClass,'aPlacedSurfaceChangesNothingOnAPageThatIsNotANativePane'],
  [compositionClass,'aRecreatedActivityStartsOpaqueAndShowsTheSurfaceAgainOnceItsPagePlacesIt']] as const;

/** The report of `native-android-terminal-core`: the core and probe cases and the composition cases, each passing once. */
export const validateTerminalCoreReport=(text:string)=>validateCases(text,coreCases);

/** The job `native-android-terminal-core` (and the Waydroid lane's core run). */
export const androidTerminalCoreAcceptance=(root?:string)=>runTerminalCases({title:'terminal core',classes:[nativeClass,compositionClass],cases:coreCases,
  evidenceName:'terminal-core-evidence',evidence:['native-probe.json']},root);

/**
 * The native session through the real UI (`native-android-terminal-session`): one Gradle run for each class, so each starts on a freshly installed app
 * on its start page (a class cannot rely on the page its predecessor's cleanup reached) and has a verdict of its own.
 */
const sessionClass='app.lazysh.client.NativeTerminalSessionTest';
const gesturesClass='app.lazysh.client.NativeTerminalGesturesTest';
const tmuxPagesClass='app.lazysh.client.NativeTerminalTmuxPagesTest';
const zellijPagesClass='app.lazysh.client.NativeTerminalZellijPagesTest';
const rmuxPagesClass='app.lazysh.client.NativeTerminalRmuxPagesTest';
// The page's own host commands (discovery, window lists) run over exec channels, which the plain fixture answers with a shell; and a case that drives pages lasts longer than its 90 s.
const pagesSsh={exec:true,shellSeconds:900} as const;
export const sessionRuns=[
  {title:'native session',classes:[sessionClass],cases:[[sessionClass,'aNativeSessionDrawsTheShellTakesTypingAndIsDrawnAgainAfterStopAndStart']],evidenceName:'native-session-evidence',evidence:['native-session.json']},
  {title:'native gestures',ssh:pagesSsh,classes:[gesturesClass],cases:[[gesturesClass,'aRealFingerSelectsCopiesAndTapsLinksOnTheNativeSurfaceAndAnOsc52WriteAsksConsent']],evidenceName:'native-gestures-evidence',evidence:['native-gestures.json']},
  {title:'native tmux pages',ssh:pagesSsh,classes:[tmuxPagesClass],cases:[[tmuxPagesClass,'tmuxPagesDiscoverAttachSwitchWindowsAndCopyWithConsentOnANativeSession']],evidenceName:'native-tmux-pages-evidence',evidence:['native-tmux-pages.json']},
  {title:'native Zellij pages',ssh:pagesSsh,classes:[zellijPagesClass],cases:[[zellijPagesClass,'zellijPagesDiscoverAttachAndSwitchTabsOnANativeSession']],evidenceName:'native-zellij-pages-evidence',evidence:['native-zellij-pages.json']},
  {title:'native rmux pages',ssh:pagesSsh,classes:[rmuxPagesClass],cases:[[rmuxPagesClass,'rmuxPagesBrowseAttachAndSwitchWindowsOnANativeSession']],evidenceName:'native-rmux-pages-evidence',evidence:['native-rmux-pages.json']},
] as const satisfies readonly TerminalCaseRun[];
export const validateNativeSessionReport=(text:string,run:TerminalCaseRun=sessionRuns[0])=>validateCases(text,run.cases);
/** The CI emulator has no GPU the shipping policy accepts, so its run asks for the debug software switch; Waydroid's does not need it. Every run goes on after one failed, so one cycle shows them all. */
export async function androidNativeSessionAcceptance(root?:string,softwareGpu=true) {
  const failures:string[]=[];
  for(const run of sessionRuns) {
    try { await runTerminalCases({...run,arguments:softwareGpu?['lazyshSoftwareGpu=true']:[]},root); }
    catch(error) { failures.push(`${run.title}: ${error instanceof Error?error.message:String(error)}`);console.error(`The ${run.title} run failed: ${failures.at(-1)}`); }
  }
  if(failures.length)throw new Error(`Native session runs failed:\n${failures.join('\n')}`);
}
