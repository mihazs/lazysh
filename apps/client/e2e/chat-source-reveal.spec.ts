import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl} from './fixtures/workspaceControl';

const agentSelect=".chat-panel select:has(option[value='codex'])";
const longText='Synthetic recorded line '.repeat(30);

// Android native tests tap a select at its centre after revealing it. A partly scrolled
// panel must still let the whole control come into view below the context navigation.
test('a partly clipped recorded-source select becomes fully hit-testable below navigation',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone context navigation above the chat scroll panel');
  await page.setViewportSize({width:412,height:660});
  await installNativeBridge(page);
  await page.addInitScript(longText=>{
    window.nativeFixtureInvoke=async(command,args)=>{
      switch(command) {
        case 'list_hosts':return [{id:'reveal',name:'Reveal',hostname:'reveal.invalid',username:'owner',port:22}];
        case 'local_capability':case 'apple_status_capability':return {available:false,reason:'Synthetic reveal fixture.'};
        case 'transport_capabilities':return {mosh:false,et:false};
        case 'has_credentials':return false;
        case 'connect':return {sessionId:'reveal-session'};
        case 'agent_transcript':return {schemaVersion:1,agent:args.agent,view:'active_branch',nextOffset:0,hasMore:false,
          messages:Array.from({length:8},(_,index)=>({id:`reveal-${index}`,role:index%2?'assistant':'user',blocks:[{type:'text',text:longText}]}))};
      }
      if(command.startsWith('plugin:event|') || ['resize','ack_output','write','disconnect'].includes(command))return;
      throw new Error(`Unexpected reveal fixture command: ${command}`);
    };
  },longText);
  await page.goto('/');
  await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Reveal',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('synthetic-entry');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await (await workspaceControl(page,'Transcript')).click();
  await page.getByRole('combobox',{name:'Agent',exact:true}).selectOption('codex');
  await page.getByRole('combobox',{name:'View',exact:true}).selectOption('conversation');
  await page.getByLabel('Transcript path',{exact:true}).fill('/fixture/codex.jsonl');
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await expect(page.locator('.chat-conversation-messages .chat-message')).toHaveCount(8);
  const probe=(reveal:boolean)=>page.evaluate(({selector,reveal})=>{
    const target=document.querySelector<HTMLElement>(selector)!,panel=target.closest<HTMLElement>('.chat-panel')!;
    if(reveal)target.scrollIntoView({block:'nearest',inline:'nearest'});
    else panel.scrollTop+=target.getBoundingClientRect().top-panel.getBoundingClientRect().top+26;
    // Integer scroll offsets may leave a sub-pixel fraction, so compare whole CSS pixels.
    const edges=(rect:DOMRect)=>[rect.top,rect.bottom,rect.left,rect.right].map(Math.round);
    const box=target.getBoundingClientRect(),[top,bottom,left,right]=edges(box),[portTop,portBottom,portLeft,portRight]=edges(panel.getBoundingClientRect());
    const hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
    return {inside:top>=portTop && bottom<=portBottom && left>=portLeft && right<=portRight,
      hitOwned:hit===target,underNavigation:!!hit?.closest('nav.context-navigation')};
  },{selector:agentSelect,reveal});
  // The state the Android run reached: 26 px of the select clipped at the panel top.
  expect(await probe(false)).toEqual({inside:false,hitOwned:false,underNavigation:true});
  expect(await probe(true)).toEqual({inside:true,hitOwned:true,underNavigation:false});
});
