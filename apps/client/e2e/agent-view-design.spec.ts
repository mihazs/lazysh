import {expect,test,type Locator,type Page} from '@playwright/test';
import {openAgentView} from './fixtures/agentViewHost';
import {setKeyboard} from './fixtures/softKeyboard';
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

  test('the composer is one rounded line that grows, with round 44 px controls and the slash and file chips while it has the focus',async({page})=>{
    const agent=await openWork(page,'forest');await settled(agent);
    const composer=agent.getByRole('region',{name:'Message composer'});
    const field=agent.getByRole('textbox',{name:'Draft for this terminal'});
    const send=agent.getByRole('button',{name:'Send to the agent'}),stop=agent.getByRole('button',{name:'Request stop'});
    await expect(send).toBeDisabled();
    // One row: the field and the controls share a baseline band; the controls are 44 px circles.
    const one=await boxOf(composer);
    for(const control of [send,stop,agent.getByRole('button',{name:'Add attachment'})]) {
      const box=await boxOf(control);
      expect(box.width).toBe(44);expect(box.height).toBe(44);
      expect(await control.evaluate(node=>getComputedStyle(node).borderTopLeftRadius)).toBe('50%');
      expect(box.y).toBeGreaterThanOrEqual(one.y);expect(box.y+box.height).toBeLessThanOrEqual(one.y+one.height);
    }
    expect(one.height).toBeLessThan(80);
    // The chips are not there until the field has the focus, and the page does not move when they appear.
    await expect(agent.getByRole('group',{name:'Insert'})).toBeHidden();
    await field.focus();
    await expect(agent.getByRole('group',{name:'Insert'})).toBeVisible();
    await agent.getByRole('button',{name:'Commands'}).click();
    await expect(field).toHaveValue('/');
    await expect(agent.getByRole('listbox',{name:'Slash commands'})).toBeVisible();
    await field.fill('');
    // A text that needs a second line takes the tall layout: the field has the whole width and the controls move under it.
    await field.fill('Run the whole suite again and tell me which tests sleep, then update the contributor guide with the new key.');
    const tall=await boxOf(composer),area=await boxOf(field),sendBox=await boxOf(send);
    expect(tall.height).toBeGreaterThan(one.height+40);
    expect(area.width).toBeGreaterThan(tall.width-24);
    expect(sendBox.y).toBeGreaterThan(area.y+area.height-1);
    expect(await send.isEnabled()).toBe(true);
    // Back to nothing: the one-line layout returns.
    await field.fill('');
    await field.blur();
    expect((await boxOf(composer)).height).toBeLessThan(80);
    const viewport=page.viewportSize()!;
    expect((await boxOf(composer)).x+(await boxOf(composer)).width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  });

  test('with the on-screen keyboard up the composer and the line being typed stay in view',async({page})=>{
    const agent=await openWork(page,'forest');await settled(agent);
    const field=agent.getByRole('textbox',{name:'Draft for this terminal'});
    await field.focus();
    await setKeyboard(page,true);
    await field.fill('First line\nSecond line\nThird line');
    const viewport=page.viewportSize()!,box=await boxOf(agent.locator('.agent-composer'));
    expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height);
    // The conversation keeps room to be read above it.
    expect((await boxOf(agent.locator('.chat-messages'))).height).toBeGreaterThan(120);
  });

  for(const theme of ['forest','midnight','paper'] as const)test(`the composer keeps 4.5:1 on its controls, chips and palette in the ${theme} theme`,async({page})=>{
    const agent=await openWork(page,theme);await settled(agent);
    const field=agent.getByRole('textbox',{name:'Draft for this terminal'});
    await field.focus();
    await agent.getByRole('button',{name:/Commands/}).click();
    const selector='.agent-composer-send, .agent-composer-stop, .agent-composer-row > .icon-button, .agent-composer-row > textarea, .agent-composer-insert button, .agent-composer-palette button, .agent-composer-palette code';
    // Buttons fade between fills; the ratio is read once they have settled.
    const lowest=async(only=selector)=>Math.min(...(await agent.locator('.agent-composer').evaluate(controlContrast,{selector:only})).map(row=>row.ratio));
    expect((await agent.locator('.agent-composer').evaluate(controlContrast,{selector})).length).toBeGreaterThan(6);
    await expect.poll(()=>lowest()).toBeGreaterThanOrEqual(4.5);
    await field.fill('Ship it');
    await expect.poll(()=>lowest('.agent-composer-send')).toBeGreaterThanOrEqual(4.5);
    expect(await agent.locator('.agent-composer').evaluate(designAudit)).toEqual({borderedControls:[],cyan:[]});
  });

  const richSession={model:'claude-sonnet-5',mode:'plan',folder:'lazysh',branch:'main',usage:{usedTokens:84000,limitTokens:200000}};

  test('the header names the agent on one line and what it is doing on a second, in 44 px, with 44 px buttons',async({page})=>{
    const agent=await openAgentView(page,{theme:'forest',messages:workMessages,state:'working',activity:'working',session:richSession});await settled(agent);
    const header=agent.locator('header');
    const title=header.locator('strong');
    await expect(title).toHaveText('Claude Code · lazysh');
    // The whole name shows: nothing is cut to make room for the chips.
    expect(await title.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    expect((await boxOf(header)).height).toBeLessThanOrEqual(44);
    const facts=header.locator('.agent-view-facts');
    await expect(facts).toContainText('Working');
    await expect(facts.getByText('Plan mode',{exact:true})).toBeVisible();
    await expect(facts.getByText('58% left',{exact:true})).toBeVisible();
    // The title is above its facts, both left-aligned to the same edge.
    const [t,f]=[await boxOf(title),await boxOf(facts)];
    expect(f.y).toBeGreaterThanOrEqual(t.y+t.height-1);expect(Math.abs(f.x-t.x)).toBeLessThanOrEqual(1);
    for(const button of await header.getByRole('button').all()) {const box=await boxOf(button);expect(box.width).toBe(44);expect(box.height).toBe(44);}
    await expect(header.getByRole('button',{name:'Agent view options'})).toBeInViewport();
  });

  test('Jump to latest floats over the end of the timeline without moving a line, and takes you back',async({page})=>{
    const agent=await openAgentView(page,{theme:'forest',messages:designMessages,state:'working',session:richSession});await settled(agent);
    const list=agent.locator('.chat-messages');
    await expect(agent.getByRole('button',{name:'Jump to latest'})).toHaveCount(0);
    const height=await list.evaluate(node=>node.scrollHeight);
    await list.evaluate(node=>{node.scrollTop=0;});
    const jump=agent.getByRole('button',{name:'Jump to latest'});
    await expect(jump).toBeVisible();
    // It takes no room in the flow of the timeline, and it floats over the end of it, centred.
    expect(await list.evaluate(node=>node.scrollHeight)).toBe(height);
    const [button,area]=[await boxOf(jump),await boxOf(list)];
    expect(button.width).toBe(44);expect(button.height).toBe(44);
    expect(Math.abs(button.x+button.width/2-(area.x+area.width/2))).toBeLessThanOrEqual(2);
    expect(button.y+button.height).toBeLessThanOrEqual(area.y+area.height);expect(button.y).toBeGreaterThan(area.y+area.height-80);
    await jump.click();
    await expect(jump).toHaveCount(0);
    await settled(agent);
  });

  test('the working line shows three dots while the turn runs, still under reduced motion, and one steady dot when it waits for you',async({page})=>{
    const running=await openAgentView(page,{theme:'forest',messages:workMessages,state:'working',activity:'working'});await settled(running);
    const dots=running.locator('.agent-working-dots > i');
    await expect(dots).toHaveCount(3);
    expect(await dots.first().evaluate(node=>getComputedStyle(node).animationName)).not.toBe('none');
    await page.emulateMedia({reducedMotion:'reduce'});
    for(const dot of await dots.all()) expect(await dot.evaluate(node=>getComputedStyle(node).animationName)).toBe('none');
    await expect(running.getByRole('status').filter({hasText:'Working'})).toBeVisible();
  });

  test('a conversation with nothing in it says so instead of showing a blank page',async({page})=>{
    const agent=await openAgentView(page,{theme:'forest',messages:[],state:'done'});
    await expect(agent.getByText('No messages yet',{exact:true})).toBeVisible();
    await expect(agent.getByText(/appears here as it happens/)).toBeVisible();
    await expect(agent.getByRole('textbox',{name:'Draft for this terminal'})).toBeVisible();
  });

  test('a short window keeps the conversation and the field: the facts, the chips and the padding give way',async({page})=>{
    await page.setViewportSize({width:415,height:560});
    const agent=await openAgentView(page,{theme:'forest',messages:workMessages,state:'working',activity:'working',session:richSession});await settled(agent);
    const header=agent.locator('header');
    expect((await boxOf(header)).height).toBeLessThanOrEqual(40);
    await expect(header.locator('.agent-view-facts')).toBeHidden();
    await expect(header.locator('strong')).toHaveText('Claude Code · lazysh');
    const field=agent.getByRole('textbox',{name:'Draft for this terminal'});
    await field.focus();
    await expect(agent.getByRole('group',{name:'Insert'})).toBeHidden();
    const [list,composer]=[await boxOf(agent.locator('.chat-messages')),await boxOf(agent.locator('.agent-composer'))];
    expect(list.height).toBeGreaterThan(150);
    expect(composer.y+composer.height).toBeLessThanOrEqual(560);
    expect(await field.evaluate(node=>getComputedStyle(node).fontSize)).toBe('16px');
  });

  for(const theme of ['forest','midnight','paper'] as const)test(`the header, the jump button and the empty state keep 4.5:1 in the ${theme} theme`,async({page})=>{
    const agent=await openAgentView(page,{theme,messages:designMessages,state:'working',activity:'working',session:richSession});await settled(agent);
    await agent.locator('.chat-messages').evaluate(node=>{node.scrollTop=0;});
    await expect(agent.getByRole('button',{name:'Jump to latest'})).toBeVisible();
    const selector='header strong, header .agent-view-state, header .agent-pill, header .icon-button, .agent-jump-box button, .agent-working-row > span:last-child';
    await expect.poll(async()=>Math.min(...(await agent.evaluate(controlContrast,{selector})).map(row=>row.ratio))).toBeGreaterThanOrEqual(4.5);
    expect((await agent.evaluate(controlContrast,{selector})).length).toBeGreaterThan(5);
    expect(await agent.evaluate(designAudit)).toEqual({borderedControls:[],cyan:[]});
    const empty=await openAgentView(page,{theme,messages:[],state:'done'});
    await expect(empty.locator('.agent-empty')).toBeVisible();
    for(const row of await empty.locator('.agent-empty').evaluate(controlContrast,{selector:'.agent-empty strong, .agent-empty p'}))expect(row.ratio).toBeGreaterThanOrEqual(4.5);
  });


  test('on a wide window the column stays 40 rem and what is under it lines up with the messages',async({page})=>{
    await page.setViewportSize({width:1280,height:850});
    const agent=await openAgentView(page,{theme:'forest',messages:workMessages,work:designWork,state:'working',activity:'working'});await settled(agent);
    const turn=await boxOf(agent.locator('.agent-turn').first());
    expect(turn.width).toBeLessThanOrEqual(640+1);
    for(const part of [agent.locator('.agent-composer'),agent.locator('.agent-plan-chip'),agent.locator('.agent-working-row')]) {
      const box=await boxOf(part);
      expect(Math.abs(box.x-turn.x)).toBeLessThanOrEqual(12);
      expect(Math.abs((box.x+box.width)-(turn.x+turn.width))).toBeLessThanOrEqual(12);
    }
  });


  test('a reply that grows below the reader moves nothing above it, nor the composer, nor the working line',async({page})=>{
    const agent=await openAgentView(page,{theme:'forest',messages:designMessages,state:'working',activity:'working'});await settled(agent);
    const list=agent.locator('.chat-messages');
    await list.evaluate(node=>{node.scrollTop=0;});
    const anchors=[agent.locator('.agent-bubble-user').first(),agent.locator('.agent-composer'),agent.locator('.agent-working-row'),agent.getByRole('button',{name:'Jump to latest'})];
    await expect(anchors[3]).toBeVisible();
    // The button fades in once when it appears; the positions are read after that.
    await anchors[3].evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
    const before=await Promise.all(anchors.map(boxOf));
    // The agent writes on: the last answer grows by twenty lines, in three parts.
    for(let part=1;part<=3;part++) {
      await page.evaluate(({part})=>{
        const last={id:'a-live',role:'assistant',blocks:[{type:'text',text:Array.from({length:part*7},(_,line)=>`Streaming line ${line+1} of the reply that keeps growing.`).join('\n\n')}]};
        window.agentViewDesign.emit({type:'delta',gen:1,seq:part+1,upserts:[{id:'a-live',rev:part,message:last}],drops:[]});
      },{part});
      await expect(agent.getByText(`Streaming line ${part*7} of the reply`)).toBeAttached();
      expect(await Promise.all(anchors.map(boxOf))).toEqual(before);
    }
    // Still reading above: the list was not dragged down to the new text, and the button is still there to go to it.
    expect(await list.evaluate(node=>node.scrollTop)).toBe(0);
    await expect(anchors[3]).toBeVisible();
  });

  // `LAZYSH_AGENT_VIEW_SHOTS=<directory> bunx playwright test e2e/agent-view-design.spec.ts -g screenshots` writes the review images of the
  // design brief (docs/reference/agent-view-design.md): the same conversations in two themes at 415 x 900. `LAZYSH_AGENT_VIEW_SHOT_TAG` names the set.
  test('writes the review screenshots when asked',async({page})=>{
    const directory=process.env.LAZYSH_AGENT_VIEW_SHOTS;
    test.skip(!directory,'Only when LAZYSH_AGENT_VIEW_SHOTS names a directory.');
    test.setTimeout(180_000);
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
      const field=work.getByRole('textbox',{name:'Draft for this terminal'});
      await work.locator('.chat-messages').evaluate(list=>{list.scrollTop=list.scrollHeight;});
      await shot('composer',theme,'empty');
      await field.fill('Run the whole suite again and tell me which tests sleep, then update the contributor guide with the new key.\nKeep it short.');
      await shot('composer',theme,'typing');
      await field.fill('');
      await field.fill('/');
      await shot('composer',theme,'commands');
      await field.fill('');
      await field.fill('Look at @');
      await shot('composer',theme,'files');
      // The frame: the header with its facts, the jump button while reading earlier text, and a conversation with nothing in it yet.
      const frame=await openAgentView(page,{theme,messages:designMessages,state:'working',activity:'working',session:{model:'claude-sonnet-5',mode:'plan',folder:'lazysh',branch:'main',usage:{usedTokens:84000,limitTokens:200000}}});await settled(frame);
      await frame.locator('.chat-messages').evaluate(list=>{list.scrollTop=0;});
      await shot('frame',theme,'header');
      const empty=await openAgentView(page,{theme,messages:[],state:'done'});
      await expect(empty.getByRole('textbox',{name:'Draft for this terminal'})).toBeVisible();
      await shot('frame',theme,'empty');
      await page.reload();
    }
  });
});
