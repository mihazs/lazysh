import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {connectedAndroidTestArguments,ownedEmulator} from './androidOwnedEmulator';
import {OwnedProcess,reportInstrumentationFailures} from './androidSsh';

export type VoiceCommand=(stage:string,program:string,args:string[],milliseconds:number)=>Promise<unknown>;
const execute:VoiceCommand=(stage,program,args,milliseconds)=>new OwnedProcess(program,args).finish(stage,milliseconds);
export const voiceFixtures=['ggml-tiny.en.bin','jfk.wav'];
export const voiceCase='app.lazysh.client.NativeWorkspaceTest#ownedWhisperTranscribesAndRemovesModelThroughTheBundledWebView';

/**
 * Owned emulator only: checks the pinned English Whisper model and JFK sample on the host, stages them in a private shell-owned
 * directory, runs the one case that imports the model, transcribes with it and removes it through the bundled WebView, and
 * always deletes the directory. A cleanup failure never replaces the first failure.
 */
export async function androidVoiceAcceptance(env=process.env,run:VoiceCommand=execute,root=resolve(import.meta.dir,'../..'),
  platform=process.platform,nonce=randomBytes(16).toString('hex')) {
  const {serial,adb,android}=ownedEmulator(env,platform,root,'voice');
  const device=`/data/local/tmp/lazysh-voice-${nonce}`;
  // A caller-provided directory is a cache the caller owns; a fresh one is ours to delete.
  const cache=env.LAZYSH_RUNTIME_FIXTURES;
  const host=cache??await mkdtemp(join(tmpdir(),'lazysh-voice-fixtures-'));
  let failed=false;
  try {
    // Before any device change, so a replaced fixture fails here with the pin to update.
    await run('owned voice pinned fixtures','sh',[join(root,'.github/scripts/speech-fixtures.sh'),host,...voiceFixtures],930_000);
    await run('owned voice fixture directory',adb,['-s',serial,'shell','mkdir','-p',device],10_000);
    for(const name of voiceFixtures)await run(`owned voice ${name} push`,adb,['-s',serial,'push',join(host,name),`${device}/${name}`],300_000);
    await run('actual Android local Whisper instrumentation',join(android,'gradlew'),
      connectedAndroidTestArguments(android,'lazyshVoiceAcceptance',voiceCase,{lazyshVoiceFixtures:device}),900_000)
      .catch(async error=>{await reportInstrumentationFailures(join(android,'app/build/outputs/androidTest-results/voice'));throw error;});
  } catch(error){failed=true;throw error;}
  finally {
    try{await run('owned voice fixture cleanup',adb,['-s',serial,'shell','rm','-rf',device],10_000);}
    catch(error){if(!failed)throw error;console.error('Owned voice fixture cleanup failed after original failure');}
    finally{if(!cache)await rm(host,{recursive:true,force:true});}
  }
}
