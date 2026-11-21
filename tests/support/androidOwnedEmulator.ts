import {join} from 'node:path';

/** The owned emulator an acceptance run may change, the adb to reach it and the Android project to build tests from; anything else is refused. */
export function ownedEmulator(env:NodeJS.ProcessEnv,platform:string,root:string,name:string) {
  if(platform!=='linux')throw new Error(`Owned Android ${name} acceptance requires Linux`);
  const serial=env.ANDROID_SERIAL;
  if(!serial||!/^emulator-[0-9]{4,5}$/.test(serial))throw new Error('Use an explicitly selected owned emulator');
  return {serial,adb:env.ANDROID_HOME?join(env.ANDROID_HOME,'platform-tools/adb'):'adb',android:join(root,'apps/client/src-tauri/gen/android')};
}

/** Gradle arguments that run one owned instrumentation class on the prebuilt x86_64 debug APK, in the order the owners always used. */
export const connectedAndroidTestArguments=(android:string,acceptance:string,testClass:string,runnerArguments:Record<string,string>={})=>[
  '-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon','-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
  `-P${acceptance}=true`,`-Pandroid.testInstrumentationRunnerArguments.class=${testClass}`,
  ...Object.entries(runnerArguments).map(([name,value])=>`-Pandroid.testInstrumentationRunnerArguments.${name}=${value}`),
];
