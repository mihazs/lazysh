import {expect,test,type Locator,type Page} from '@playwright/test';
import {openAgentView} from './fixtures/agentViewHost';
import {designMessages} from './fixtures/agentDesignConversation';
import {controlContrast} from './fixtures/controlContrast';
import {designAudit} from './fixtures/designAudit';

type Theme='forest'|'midnight'|'paper';
const open=(page:Page,theme:Theme)=>openAgentView(page,{theme,messages:designMessages,state:'working'});
/** Waits for the timeline to settle at its end, where a new reply is read. */
const settled=(agent:Locator)=>expect.poll(()=>agent.locator('.chat-messages').evaluate(list=>list.scrollHeight-list.clientHeight-list.scrollTop)).toBeLessThanOrEqual(1);
const boxOf=async(locator:Locator)=>(await locator.boundingBox())!;

test.describe('the conversation reads as a calm column on a phone',()=>{
  test.use({viewport:{width:415,height:900},isMobile:true,hasTouch:true});

  test('prompts sit on the trailing edge, answers use the full width, and no message covers another or widens the page',async({page})=>{
    const agent=await open(page,'forest');await settled(agent);
    const turns=agent.locator('.agent-turn');
    await agent.locator('.chat-messages').evaluate(list=>{list.scrollTop=0;});
    const list=await boxOf(agent.locator('.chat-messages'));
    // The first prompt is a bubble on the trailing side, never wider than 88% of the column.
    const prompt=await boxOf(turns.nth(0).locator('.agent-bubble-user'));
    expect(prompt.x+prompt.width).toBeGreaterThan(list.x+list.width-24);
    expect(prompt.width).toBeLessThanOrEqual(list.width*0.88+1);
    const answer=turns.nth(0).locator('.agent-bubble-assistant').last();
    await answer.scrollIntoViewIfNeeded();
    const text=await boxOf(answer);
    expect(text.x).toBeLessThanOrEqual(list.x+17);
    expect(text.width).toBeGreaterThan(list.width-40);
    // Every direct child of a turn sits below the one before it: nothing is drawn over another message.
    const boxes=await turns.evaluateAll(all=>all.flatMap(turn=>[...turn.children].map(child=>{const rect=child.getBoundingClientRect();return {top:rect.top+scrollY,bottom:rect.bottom+scrollY,left:rect.left,right:rect.right};})));
    for(let index=1;index<boxes.length;index++)expect(boxes[index].top,`message ${index}`).toBeGreaterThanOrEqual(boxes[index-1].bottom-1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  });

  test('a code line and a wide table scroll inside their block instead of widening the message',async({page})=>{
    const agent=await open(page,'forest');await settled(agent);
    const code=agent.locator('.chat-code').first();
    await code.scrollIntoViewIfNeeded();
    const block=await boxOf(code),viewport=page.viewportSize()!;
    expect(block.x).toBeGreaterThanOrEqual(0);expect(block.x+block.width).toBeLessThanOrEqual(viewport.width);
    expect(await code.locator('pre').evaluate(pre=>pre.scrollWidth>pre.clientWidth&&getComputedStyle(pre).overflowX==='auto')).toBe(true);
    await expect(code.locator('.chat-code-language')).toHaveText('ts');
    await expect(code.locator('.hljs-keyword').first()).toBeVisible();
    const table=agent.getByRole('region',{name:'Table'}).first();
    const frame=await boxOf(table);
    expect(frame.x+frame.width).toBeLessThanOrEqual(viewport.width);
  });

  test('Copy code puts the exact code on the clipboard',async({page,context})=>{
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    const agent=await open(page,'forest');
    const code=agent.locator('.chat-code').first();
    await code.scrollIntoViewIfNeeded();
    await code.getByRole('button',{name:'Copy code'}).click();
    await expect(code.getByRole('button',{name:'Copied'})).toBeVisible();
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(await code.locator('code').evaluate(node=>node.textContent!));
    expect(await code.locator('code').textContent()).toContain('export async function restore');
  });

  test('a tap on a message shows when it was sent, and the time is there for a screen reader before that',async({page})=>{
    const agent=await open(page,'forest');await settled(agent);
    await agent.locator('.chat-messages').evaluate(list=>{list.scrollTop=0;});
    const prompt=agent.locator('.agent-bubble-user').first();
    const time=prompt.locator('time');
    await expect(time).toHaveAttribute('datetime','2026-11-13T10:30:00Z');
    expect(await time.evaluate(node=>node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    const copy=prompt.getByRole('button',{name:'Copy message'});
    expect(await copy.evaluate(node=>node.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
    await prompt.tap();
    await expect(time).toBeVisible();
    await expect(time).toContainText('Sent');
    // Copy message appears with the time, as a 44 px target, instead of sitting over the text.
    const box=await boxOf(copy);expect(box.width).toBe(44);expect(box.height).toBe(44);
    await prompt.tap({position:{x:10,y:10}});
    expect(await time.evaluate(node=>node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    expect(await copy.evaluate(node=>node.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
  });

  for(const theme of ['forest','midnight','paper'] as const)test(`text stays readable and nothing is cyan or bordered in the ${theme} theme`,async({page})=>{
    const agent=await open(page,theme);await settled(agent);
    await agent.locator('.agent-turn-activity > summary').first().click();
    const textSelector='.agent-bubble p, .agent-bubble li, .agent-bubble h2, .agent-bubble blockquote, .agent-bubble th, .agent-bubble td, .agent-bubble code, .chat-code-language, .chat-code-copy, .chat-code .hljs-keyword, .chat-code .hljs-string, .chat-code .hljs-comment, .chat-code .hljs-title, .chat-code .hljs-built_in, .chat-code .hljs-type, .agent-stamp';
    const root=agent.locator('.chat-messages');
    // The time is hidden until a tap; show it so its colour is audited too.
    await agent.locator('.agent-bubble-user').first().evaluate(node=>node.setAttribute('data-stamped',''));
    const ratios=await root.evaluate(controlContrast,{selector:textSelector});
    expect(ratios.length).toBeGreaterThan(12);
    for(const row of ratios)expect(row.ratio,`${row.tag} "${row.text}"`).toBeGreaterThanOrEqual(4.5);
    const found=await root.evaluate(designAudit);
    expect(found).toEqual({borderedControls:[],cyan:[]});
  });

  // `LAZYSH_AGENT_VIEW_SHOTS=<directory> bunx playwright test e2e/agent-view-design.spec.ts -g screenshots` writes the review images of the
  // design brief (docs/reference/agent-view-design.md): the same conversation in two themes at 415 x 900. `LAZYSH_AGENT_VIEW_SHOT_TAG` names the set.
  test('writes the review screenshots when asked',async({page})=>{
    const directory=process.env.LAZYSH_AGENT_VIEW_SHOTS;
    test.skip(!directory,'Only when LAZYSH_AGENT_VIEW_SHOTS names a directory.');
    for(const theme of ['forest','paper'] as const) {
      const agent=await open(page,theme);await settled(agent);
      const shot=async(name:string)=>{await page.waitForTimeout(400);await page.screenshot({path:`${directory}/${process.env.LAZYSH_AGENT_VIEW_SHOT_TAG??'after'}-${theme}-${name}.png`});};
      await shot('latest');
      await agent.getByText('export async function restore').first().evaluate(node=>(node.closest('figure')??node).scrollIntoView({block:'center'}));
      await shot('code');
      await agent.locator('.chat-messages').evaluate(list=>{list.scrollTop=0;});
      await shot('start');
      await page.reload();
    }
  });
});
