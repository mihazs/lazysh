import {expect} from 'vitest';
import {recordedPageCall} from '../../../tests/support/recordedCards';
import type {NativeGui} from './fixture';

export type RecordedSource={agent:string;view?:string;path:string;sessionId?:string};
type Owner=Awaited<ReturnType<NativeGui['appOwner']>>;
const panel='//section[contains(concat(" ",@class," ")," chat-panel ")]';

/** The Transcript panel controls the recorded native cases drive, through the public UI only. */
export function recordedReader(gui:NativeGui,owner:Owner) {
  const browser=gui.browser!;
  const choose=(label:string,value:string)=>browser.waitUntil(async()=>{
    const select=await browser.$(`${panel}//label[normalize-space(text())="${label}"]/select`);
    if(await select.getValue()!==value)await select.selectByAttribute('value',value);
    return await select.getValue()===value;
  },{timeout:5000,timeoutMsg:`Recorded ${label} did not select ${value}`});
  const open=async(source:RecordedSource)=>{
    // Choosing Codex resets View to records, so View is chosen after Agent.
    await choose('Agent',source.agent);await choose('View',source.view??'conversation');
    await (await browser.$('.chat-panel input[placeholder="Absolute host path to session.jsonl"]')).setValue(source.path);
    if(source.sessionId!==undefined && source.agent==='opencode')await (await browser.$(`${panel}//label[normalize-space(text())="Transcript session ID"]/input`)).setValue(source.sessionId);
    expect(await browser.execute(()=>Array.from(document.querySelectorAll<HTMLSelectElement>('.chat-panel select'),x=>x.value).slice(0,2))).toEqual([source.agent,source.view??'conversation']);
    await (await browser.$(`${panel}//button[normalize-space(.)="Open transcript"]`)).click();
  };
  // The page compares in place, so the result never depends on driver object serialization.
  const awaitPage=async(stage:string,name:'messages'|'cards',argument:unknown,timeout=20_000)=>{
    try{await browser.waitUntil(async()=>await browser.execute(`return ${recordedPageCall(name,argument)}`)===true,{timeout,timeoutMsg:stage});}
    catch(primary){
      console.info('Owned recorded page observation',stage,await browser.execute(`return ${recordedPageCall(name,argument,true)}`).catch(()=>'unavailable'));
      throw primary;
    }
  };
  // Reading never opens another tab, replaces the app or connects again.
  const unchanged=async()=>{expect(await browser.$$('[role="tab"]')).toHaveLength(1);expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);};
  return {choose,open,awaitPage,unchanged};
}
