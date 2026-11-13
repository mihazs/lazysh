import {expect,test,type Page} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const pasted=['Fix this:','','- The agent view are not rendering HTML when the agent outputs html like in a pasted text for example.','- Implement infinite scroll in agent view history instead of having a button to load more.','- For agent view, inspire the design (ux/ui) in claude and chatgpt app.'].join('\n');
const item=(n:number)=>`- **#${1450+n} — Item ${n}:** Renders a strict sanitized subset. It allows tables, lists, links and bounded images, and never scripts, event handlers, iframes, forms or styles.\n  - Remote images stay blocked until you tap "Load image".\n  - Links open through the app's link handler.\n  - Tests use a corpus of XSS and obfuscation attempts.`;
const messages=[
  {id:'p',role:'user',blocks:[{type:'text',text:`<pasted_content id="05cc">${pasted}</pasted_content id="05cc">`}]},
  {id:'a',role:'assistant',blocks:[{type:'text',text:`I filed you three issues and a workflow for them:\n\n${[1,2,3,4,5,6,7,8,9,10].map(item).join('\n')}`}]},
];
const boxes=(page:Page)=>page.evaluate(()=>{
  const list=document.querySelector('.chat-messages')!, view=list.getBoundingClientRect();
  const clip=(element:Element)=>{const r=element.getBoundingClientRect();return {left:Math.max(r.left,view.left),right:Math.min(r.right,view.right),top:Math.max(r.top,view.top),bottom:Math.min(r.bottom,view.bottom)};};
  const messages=[...list.querySelectorAll('.agent-turn > article')].map(clip), jump=document.querySelector('.chat-follow-controls');
  const overlap=(a:ReturnType<typeof clip>,b:ReturnType<typeof clip>)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
  return {messages:messages.length,jump:!!jump,
    messageOverlap:messages.some((a,i)=>messages.some((b,j)=>i<j && overlap(a,b))),
    jumpOverlap:jump ? messages.some(message=>overlap(message,clip(jump))) : false};
});

for(const scheme of ['light','dark'] as const) for(const width of [360,390,415,430,768]) {
  test(`a running turn's long reply scrolls under no message box at ${width}px in ${scheme}`,async({page})=>{
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:scheme});
    await openAgentWork(page,messages,{activity:'working'});
    const list=page.locator('.chat-messages');
    await expect(page.locator('.agent-turn > article')).toHaveCount(2);
    for(const fraction of [0,0.4,0.7,1]) {
      await list.evaluate((node,f)=>{node.scrollTop=(node.scrollHeight-node.clientHeight)*f;},fraction);
      expect(await boxes(page),`scrolled to ${fraction}`).toMatchObject({messages:2,messageOverlap:false,jumpOverlap:false});
    }
  });
}

test('pasted content is one compact Pasted text block that expands and copies, never raw tags',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await openAgentWork(page,messages,{activity:'working'});
  const block=page.getByRole('region',{name:'Pasted text'});
  await expect(block).toBeVisible();
  await expect(page.getByText('pasted_content')).toHaveCount(0);
  await expect(block).toContainText('Fix this:');
  await expect(block).not.toContainText('inspire the design');
  await block.getByRole('button',{name:'Show all'}).click();
  await expect(block).toContainText('inspire the design');
  await block.getByRole('button',{name:'Show less'}).click();
  await expect(block).not.toContainText('inspire the design');
  await block.getByRole('button',{name:'Copy pasted text'}).click();
  await expect(block.getByRole('button',{name:'Copied'})).toBeVisible();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(pasted);
});
