import {join} from 'node:path';

/** The shared stand-in agent: the Rust scripted session, the native GUI case and the Android case run this one script. */
export const reportingAgentScript=join(import.meta.dir,'../../apps/client/src-tauri/src/tmux_agent_session_agent.sh');

/** One prompt per delivery path, distinct per run; none starts with a word the stand-in treats as a command except `hold`. */
export function reportingAgentPrompts(nonce:string) {
  const tag=nonce.slice(0,8);
  return {hold:`hold ${tag}`,sent:`send ${tag}`,typed:`type ${tag}`};
}

const codes=(text:string)=>Array.from(text,character=>String(character.codePointAt(0)));
/**
 * The agent's key log (one decimal code per line; a bracketed-paste marker logs only its ESC) holds exactly these prompts, in
 * order: each typed or pasted, then one Enter as CR or LF. Any other key, a repeated delivery or a missing one is a mismatch.
 */
export function reportingAgentKeysAre(keys:readonly string[],prompts:readonly string[]) {
  let at=0;
  for(const prompt of prompts) {
    const text=codes(prompt);
    const form=[text,['27',...text,'27']].find(candidate=>candidate.every((code,index)=>keys[at+index]===code) && ['13','10'].includes(keys[at+candidate.length]));
    if(!form)return false;
    at+=form.length+1;
  }
  return at===keys.length;
}

const lines=(text:string)=>text.split('\n').filter(Boolean);
/**
 * The stand-in's own records of a run: it logged each prompt once and in order, held the first turn and let the next prompt end
 * it, received no other key, and its pane shows each prompt once. `pane` is the full `capture-pane -p -J` text.
 */
export function reportingAgentDeliveredOnce(log:string,keys:string,pane:string,prompts:readonly string[]) {
  const rows=lines(log),submitted=rows.filter(row=>row.startsWith('SUBMIT ')).map(row=>row.slice(7));
  const once=(row:string)=>rows.filter(value=>value===row).length===1;
  if(JSON.stringify(submitted)!==JSON.stringify(prompts) || !once('READY') || !once('HOLD') || !once('HOLD_ENDED'))throw new Error('Owned tmux reporting agent did not log the prompts once, in order');
  if(!reportingAgentKeysAre(lines(keys),prompts))throw new Error('Owned tmux reporting agent received a key other than its prompts');
  if(prompts.some(prompt=>pane.split(`> ${prompt}`).length!==2))throw new Error('Owned tmux reporting agent pane does not show each prompt once');
}
