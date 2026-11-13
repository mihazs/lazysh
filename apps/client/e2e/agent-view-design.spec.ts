import {expect,test,type Locator,type Page} from '@playwright/test';
import {openAgentView} from './fixtures/agentViewHost';
import {designMessages,designWork,questionMessages,workMessages} from './fixtures/agentDesignConversation';
import {controlContrast} from './fixtures/controlContrast';
import {designAudit} from './fixtures/designAudit';

type Theme='forest'|'midnight'|'paper';
const open=(page:Page,theme:Theme)=>openAgentView(page,{theme,messages:designMessages,state:'working'});
const openWork=(page:Page,theme:Theme)=>openAgentView(page,{theme,messages:workMessages,work:designWork,state:'working',activity:'working'});
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

  test('work is quiet: a folded row opens to borderless tool rows, a call that went well is one mark, a failure and a running call say so',async({page})=>{
    const agent=await openWork(page,'forest');await settled(agent);
    const fold=agent.locator('.agent-turn-activity');
    await expect(fold).not.toHaveAttribute('open','');
    await expect(fold.locator(':scope > summary')).toContainText('Ran 2 commands');
    await fold.locator(':scope > summary').click();
    const rows=fold.locator('.agent-tool');
    await expect(rows).toHaveCount(5);
    // Every row is a full-width bar at least 44 px tall with no border of its own.
    for(const row of await rows.all()) {
      const box=await boxOf(row.locator('summary'));
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await row.evaluate(node=>getComputedStyle(node).borderTopWidth)).toBe('0px');
    }
    const [read,edit,failed,sub,running]=[0,1,2,3,4].map(index=>rows.nth(index));
    // A call that went well shows a mark; its word stays in the page for a screen reader.
    expect(await read.locator('.agent-tool-status-text').evaluate(node=>node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await expect(read.locator('.agent-tool-status-text')).toHaveText('Done');
    await expect(edit.locator('.agent-diff-counts').first()).toBeVisible();
    await expect(failed.locator('.agent-tool-status-text')).toBeVisible();
    await expect(failed.locator('.agent-tool-status-text')).toHaveText('Failed · exit code 1');
    await expect(running.locator('.agent-tool-status-text')).toBeVisible();
    await expect(running).toHaveAttribute('data-status','running');
    await expect(sub.locator('summary')).toContainText('Audit the other retry tests');
    // Opening a row shows what it did without moving the rows above it.
    const above=await boxOf(read.locator('summary'));
    await failed.locator('summary').click();
    await expect(failed.getByLabel('Output')).toContainText('expected 3 attempts');
    expect(await boxOf(read.locator('summary'))).toEqual(above);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  });

  test('the plan is one chip that fills as steps finish, and opens to a checklist',async({page})=>{
    const agent=await openWork(page,'forest');await settled(agent);
    const chip=agent.getByRole('button',{name:/1 of 3/});
    await expect(chip).toContainText('Run the whole suite');
    const [width,fill]=await chip.evaluate(node=>[node.getBoundingClientRect().width,node.style.getPropertyValue('--plan-done')]);
    expect(width).toBeGreaterThan(200);expect(fill).toBe('33%');
    await chip.click();
    const plan=agent.getByRole('region',{name:'Plan'});
    await expect(plan.getByRole('listitem')).toHaveText(['DoneUse a fake clock in the retry test','In progressRun the whole suite','PendingUpdate the contributor guide']);
    // The marks are drawn, not typed: each step has an 18 px circle and no pill of text.
    for(const mark of await plan.locator('.chat-plan-status').all())expect((await boxOf(mark)).width).toBe(18);
  });

  test('a question and a failure read as cards, not as boxed forms',async({page})=>{
    const asked=await openAgentView(page,{theme:'forest',messages:questionMessages,state:'needs_attention'});
    const card=asked.getByRole('region',{name:'Question'});
    await expect(card).toContainText('Which registry should the release publish to?');
    await expect(card).toContainText('GitHub Packages');
    expect(await card.evaluate(node=>getComputedStyle(node).borderTopWidth)).toBe('0px');
    expect(await card.locator('fieldset').evaluate(node=>getComputedStyle(node).borderTopWidth)).toBe('0px');
  });

  for(const theme of ['forest','midnight','paper'] as const)test(`the work rows keep 4.5:1 text and add no border or cyan in the ${theme} theme`,async({page})=>{
    const agent=await openWork(page,theme);await settled(agent);
    await agent.locator('.agent-turn-activity > summary').click();
    await agent.getByRole('button',{name:/1 of 3/}).click();
    await agent.locator('.agent-tool[data-kind="diff"] > summary').click();
    await agent.locator('.agent-tool[data-status="error"] > summary').click();
    const selector='.agent-diff-lines > span, .agent-tool pre, .agent-turn-activity > summary, .agent-tool > summary strong, .agent-tool-summary, .agent-tool-status, .agent-diff-counts span, .chat-card h5, .chat-card p, .chat-plan-entries li > span:last-child, .agent-plan-chip button, .agent-status-bar button';
    const ratios=await agent.evaluate(controlContrast,{selector});
    expect(ratios.length).toBeGreaterThan(18);
    for(const row of ratios)expect(row.ratio,`${row.tag} "${row.text}"`).toBeGreaterThanOrEqual(4.5);
    expect(await agent.evaluate(designAudit)).toEqual({borderedControls:[],cyan:[]});
  });

  // `LAZYSH_AGENT_VIEW_SHOTS=<directory> bunx playwright test e2e/agent-view-design.spec.ts -g screenshots` writes the review images of the
  // design brief (docs/reference/agent-view-design.md): the same conversations in two themes at 415 x 900. `LAZYSH_AGENT_VIEW_SHOT_TAG` names the set.
  test('writes the review screenshots when asked',async({page})=>{
    const directory=process.env.LAZYSH_AGENT_VIEW_SHOTS;
    test.skip(!directory,'Only when LAZYSH_AGENT_VIEW_SHOTS names a directory.');
    const shot=async(set:string,theme:Theme,name:string)=>{await page.waitForTimeout(400);await page.screenshot({path:`${directory}/${set}-${process.env.LAZYSH_AGENT_VIEW_SHOT_TAG??'after'}-${theme}-${name}.png`});};
    for(const theme of ['forest','paper'] as const) {
      const agent=await open(page,theme);await settled(agent);
      await shot('conversation',theme,'latest');
      await agent.getByText('export async function restore').first().evaluate(node=>(node.closest('figure')??node).scrollIntoView({block:'center'}));
      await shot('conversation',theme,'code');
      await agent.locator('.chat-messages').evaluate(list=>{list.scrollTop=0;});
      await shot('conversation',theme,'start');
      const work=await openWork(page,theme);await settled(work);
      await work.locator('.agent-turn-activity > summary').click();
      await shot('work',theme,'rows');
      await work.locator('.agent-tool[data-status="error"] > summary').click();
      await work.getByRole('button',{name:/1 of 3/}).click();
      await work.locator('.chat-messages').evaluate(list=>{list.scrollTop=list.scrollHeight;});
      await shot('work',theme,'plan');
      await page.reload();
    }
  });
});
