import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {connectedAndroidTestArguments,ownedEmulator} from './androidOwnedEmulator';
import {OwnedProcess,reportInstrumentationFailures} from './androidSsh';

export type VoiceCommand=(stage:string,program:string,args:string[],milliseconds:number)=>Promise<unknown>;
const execute:VoiceCommand=(stage,program,args,milliseconds)=>new OwnedProcess(program,args).finish(stage,milliseconds);
export const voiceFixtures=['ggml-tiny.en.bin','jfk.wav'];
// Committed in the repository and checked by the case itself; the app downloads the Parakeet archive on its own, so nothing else is staged.
export const parakeetFixtureDirectory='packages/parakeet-runtime/tests/fixtures/librispeech';
export const parakeetFixtures=['1272-128104-0000.wav','reference.txt'];
export const voiceCases=['ownedWhisperTranscribesAndRemovesModelThroughTheBundledWebView','ownedParakeetInstallsTranscribesAndRemovesThroughTheBundledWebView']
  .map(name=>`app.lazysh.client.NativeWorkspaceTest#${name}`).join(',');

/**
 * Owned emulator only: checks the pinned English Whisper model and JFK sample on the host and stages them, with the committed
 * LibriSpeech sample and its reference, in a private shell-owned directory. Runs the two local-voice cases through the bundled
 * WebView (Whisper imports, transcribes and removes its model; Parakeet downloads its own archive, transcribes and removes it), and
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
    for(const name of parakeetFixtures)await run(`owned voice ${name} push`,adb,['-s',serial,'push',join(root,parakeetFixtureDirectory,name),`${device}/${name}`],60_000);
    await run('actual Android local voice instrumentation',join(android,'gradlew'),
      connectedAndroidTestArguments(android,'lazyshVoiceAcceptance',voiceCases,{lazyshVoiceFixtures:device}),2_100_000)
      .catch(async error=>{await reportInstrumentationFailures(join(android,'app/build/outputs/androidTest-results/voice'));throw error;});
  } catch(error){failed=true;throw error;}
  finally {
    try{await run('owned voice fixture cleanup',adb,['-s',serial,'shell','rm','-rf',device],10_000);}
    catch(error){if(!failed)throw error;console.error('Owned voice fixture cleanup failed after original failure');}
    finally{if(!cache)await rm(host,{recursive:true,force:true});}
  }
}
