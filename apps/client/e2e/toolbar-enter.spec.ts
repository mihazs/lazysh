import {expect,test,type Locator,type Page} from '@playwright/test';
import {installLocalTerminal} from './fixtures/localTerminal';

/** An agent-style select menu: Down moves the highlight in place, a redraw (as after a keyboard resize) leaves the earlier copy in scrollback, and Enter streams the answer. */
async function openAgentMenu(page:Page,phone:boolean) {
  await installLocalTerminal(page);
  await page.addInitScript(()=>{
    if(!sessionStorage.getItem('toolbar-enter-seeded')){sessionStorage.setItem('toolbar-enter-seeded','1');localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar:['esc','up','down','enter'],chords:[{label:'Confirm',keys:'Enter'}]}));}
    // Claude Code's startup modes, then a menu redrawn in place at the bottom of the live screen.
    const menu=(choice:number)=>`\x1b[2K\r  Pick a color\r\n\x1b[2K${choice===0?'❯':' '} 1. Red\r\n\x1b[2K${choice===1?'❯':' '} 2. Blue\r\n\x1b[2K\r\n\x1b[2KEnter to select · Esc to cancel\x1b[4A\r`;
    let choice=0;
    window.simpleShortcutInput=data=>{
      if(data==='\x1b[B'){choice=1;window.simpleShortcutOutput(menu(choice));}
      else if(data==='\r')window.simpleShortcutOutput(`\x1b[J● Chose ${choice===1?'BLUE':'RED'}\r\n`+Array.from({length:60},(_,i)=>`agent reply ${i}\r\n`).join('')+'ANSWER_DONE');
    };
    // Push the drawn screen into scrollback, then draw the menu again on the live screen.
    Reflect.set(window,'agentRedraw',()=>window.simpleShortcutOutput('\x1b[4B'+'\r\n'.repeat(window.simpleShortcutResizes.at(-1)?.rows??60)+menu(choice)));
    Reflect.set(window,'agentMenu',()=>window.simpleShortcutOutput(Array.from({length:120},(_,i)=>`history ${i}\r\n`).join('')+'\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[?25l'+menu(choice)));
  });
  await page.goto('/');
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.simpleShortcutOutput)).toBe('function');
  await page.evaluate(()=>(Reflect.get(window,'agentMenu') as ()=>void)());
  const viewport=page.locator('.terminal-canvas:visible .xterm-viewport');
  await expect.poll(()=>fromBottom(viewport)).toBe(0);
  await page.evaluate(()=>{window.simpleShortcutWrites.length=0;});
  return viewport;
}
const fromBottom=(viewport:Locator)=>viewport.evaluate(node=>node.scrollHeight-node.clientHeight-node.scrollTop);
/** The agent redraws its menu and the reader is left one screen up in history, looking at the earlier copy. */
async function readStaleMenu(page:Page,viewport:Locator) {
  const rows=page.locator('.terminal-canvas:visible .xterm-rows');
  await page.evaluate(()=>(Reflect.get(window,'agentRedraw') as ()=>void)());
  // The live screen now holds only the redrawn menu; the earlier copy sits after the history in scrollback.
  await expect(rows).not.toContainText('history 119');
  await expect.poll(()=>fromBottom(viewport)).toBe(0);
  await viewport.evaluate(node=>{node.scrollTop-=node.clientHeight;});
  await expect(rows).toContainText('history 119');
  await expect(rows).toContainText('❯ 2. Blue');
  expect(await fromBottom(viewport)).toBeGreaterThan(0);
}

for(const via of ['toolbar','chord button','keyboard'] as const) test(`${via} Enter shows the agent answer instead of a stale menu copy`,async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  const viewport=await openAgentMenu(page,phone);
  const rows=page.locator('.terminal-canvas:visible .xterm-rows');
  const keys=page.locator('.terminal-keys:visible');
  const press=async(name:string)=>{const key=keys.getByRole('button',{name,exact:true});if(phone)await key.tap();else await key.click();};
  await press('Arrow down');
  await expect(rows).toContainText('❯ 2. Blue');
  await readStaleMenu(page,viewport);
  if(via==='toolbar')await press('enter');
  else if(via==='chord button')await press('Confirm');
  else await page.locator('.terminal-canvas:visible .xterm-helper-textarea').press('Enter');
  // Every Enter path delivers the same single carriage return, never a modified or newline key.
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites.filter(data=>data!=='\x1b[I'&&data!=='\x1b[O'))).toEqual(['\x1b[B','\r']);
  // Left in history the reader would keep seeing the frozen menu copy, as if Enter did nothing; every path follows to the answer instead.
  await expect(rows).toContainText('ANSWER_DONE');
  await expect(rows).toContainText('agent reply 59');
  await expect(rows).not.toContainText('Pick a color');
  expect(await fromBottom(viewport)).toBe(0);
});
