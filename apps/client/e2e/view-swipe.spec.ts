import {expect,test,type Page} from '@playwright/test';
import {conversationText,openSwipeWorkspace,touchscreen} from './fixtures/swipeHost';
import {oneUi,reportGestureInsets} from './fixtures/gestureInsets';

test.use({viewport:{width:415,height:900}});
const switcher=(page:Page)=>page.getByRole('group',{name:'Session view',exact:true});
const agentView=(page:Page)=>page.getByRole('region',{name:'Agent view',exact:true}).and(page.locator(':visible'));
const terminal=(page:Page)=>page.locator('.terminal-pane:visible');
const emptyAgent='No agent conversation for this terminal.';
const stored=(page:Page)=>page.evaluate(()=>localStorage.getItem('lazysh-session-views'));
/** The strip the swipes move: the whole session body, at a height away from the soft-key rows. */
async function body(page:Page) {
  const box=(await page.locator('.session-body').boundingBox())!;
  const y=box.y+box.height/2;
  return {rightEdge:{x:box.x+box.width-4,y},centre:{x:box.x+box.width*0.4,y},left:{x:box.x+40,y},right:{x:box.x+box.width-60,y},width:box.width};
}
/** The gesture engine refuses a touch while the user types or a drag is settling; wait until it would accept one. */
const quiet=(page:Page)=>expect.poll(()=>page.evaluate(async()=>(await import('/src/edgeGestures.ts')).isTextInteractionActive())).toBe(false);
const showAgent=async(page:Page)=>{await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();await expect(agentView(page).getByText(emptyAgent)).toBeVisible();};

test.describe('phone',()=>{
  test.skip(({isMobile})=>!isMobile,'The swipes belong to phones.');

  test('a right-edge swipe left shows the Agent view and the opposite swipe returns to the terminal, which is remembered',async({page})=>{
    await openSwipeWorkspace(page);
    const touch=await touchscreen(page,false);
    const {rightEdge,left,centre,right}=await body(page);
    await touch.swipe(rightEdge,left);
    await expect(agentView(page).getByText(emptyAgent)).toBeVisible();
    await expect(terminal(page)).toHaveCount(0);
    await expect(switcher(page).getByRole('button',{name:'Agent',exact:true})).toHaveAttribute('aria-pressed','true');
    expect(await stored(page)).toContain('"agent"');
    await page.reload();
    await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
    await expect(agentView(page).getByText(emptyAgent)).toBeVisible();

    await touch.swipe(centre,right);
    await expect(terminal(page)).toHaveCount(1);
    await expect(agentView(page)).toHaveCount(0);
    await expect(switcher(page).getByRole('button',{name:'Terminal',exact:true})).toHaveAttribute('aria-pressed','true');
    expect(await stored(page)).not.toContain('"agent"');
  });

  test('on Android gesture navigation a handle inside the Back zone starts the switch, and the screen edge does not',async({page})=>{
    await openSwipeWorkspace(page);
    const touch=await touchscreen(page,false);
    await reportGestureInsets(page,oneUi);
    const handle=page.locator('[data-gesture-handle="right"]');
    await expect(handle).toBeVisible();
    const grip=(await handle.boundingBox())!;
    // The handle starts beyond the system's 32 dp Back zone, never inside it.
    expect(grip.x+grip.width).toBeLessThanOrEqual(415-32);
    const {rightEdge,left}=await body(page);
    await touch.swipe(rightEdge,left);
    await expect(terminal(page)).toHaveCount(1);
    await expect(agentView(page)).toHaveCount(0);
    // The screen-edge drag above counted as a scroll for a moment.
    await quiet(page);
    const from={x:grip.x+grip.width/2,y:grip.y+grip.height/2};
    await touch.swipe(from,{x:left.x,y:from.y});
    await expect(agentView(page).getByText(emptyAgent)).toBeVisible();
    await expect(handle).toHaveCount(0);
    await switcher(page).getByRole('button',{name:'Terminal',exact:true}).click();
    await handle.tap();
    await expect(agentView(page).getByText(emptyAgent)).toBeVisible();
  });

  test('on Android gesture navigation a swipe from the area just inside the Back zone starts the switch at any height above the toolbar',async({page})=>{
    await openSwipeWorkspace(page);
    const touch=await touchscreen(page,false);
    await reportGestureInsets(page,oneUi);
    const box=(await page.locator('.session-body').boundingBox())!,{left}=await body(page);
    // The Back zone is 32 dp and the area is 4 dp past it, 40 dp deep: 415 - 36 is its inner edge, 415 - 76 its outer.
    await quiet(page);
    await touch.swipe({x:415-20,y:box.y+60},{...left,y:box.y+60});
    await expect(terminal(page)).toHaveCount(1);
    await quiet(page);
    await touch.swipe({x:415-90,y:box.y+60},{...left,y:box.y+60});
    await expect(terminal(page)).toHaveCount(1);
    await quiet(page);
    await touch.swipe({x:415-50,y:box.y+60},{...left,y:box.y+60});
    await expect(agentView(page).getByText(emptyAgent)).toBeVisible();
  });

  test('the Terminal | Agent buttons still switch without a gesture',async({page})=>{
    await openSwipeWorkspace(page);
    await showAgent(page);
    await switcher(page).getByRole('button',{name:'Terminal',exact:true}).click();
    await expect(terminal(page)).toHaveCount(1);
  });

  test('the pages follow the finger, and a short, slow or interrupted swipe leaves the view unchanged',async({page},testInfo)=>{
    await openSwipeWorkspace(page);
    const touch=await touchscreen(page,false);
    const {rightEdge,left,width}=await body(page);
    await touch.hold(rightEdge,left,0.25,30);
    // Mid-drag both pages are on screen, side by side, and the Agent view has entered from the right.
    await testInfo.attach('mid-swipe-415x900',{body:await page.screenshot(),contentType:'image/png'});
    const agentBox=(await page.getByRole('region',{name:'Agent view',exact:true}).boundingBox())!;
    const terminalBox=(await page.locator('.terminal-pane-swiping').boundingBox())!;
    expect(agentBox.x).toBeGreaterThan(width*0.2);expect(agentBox.x).toBeLessThan(width*0.9);
    expect(terminalBox.x).toBeLessThan(-width*0.1);
    expect(Math.round(agentBox.x-(terminalBox.x+terminalBox.width))).toBe(0);
    await touch.lift();
    await expect(terminal(page)).toHaveCount(1);
    await expect(page.getByRole('region',{name:'Agent view',exact:true})).toBeHidden();
    expect((await terminal(page).boundingBox())!.x).toBe(0);
    expect(await stored(page)).toBeNull();

    await touch.hold(rightEdge,left,0.8,30);
    await touch.interrupt();
    await expect(terminal(page)).toHaveCount(1);
    await expect(page.getByRole('region',{name:'Agent view',exact:true})).toBeHidden();

    await showAgent(page);
    const {centre,right}=await body(page);
    await touch.hold(centre,right,0.3,30);
    expect((await agentView(page).boundingBox())!.x).toBeGreaterThan(width*0.05);
    await touch.lift();
    await expect(agentView(page).getByText(emptyAgent)).toBeVisible();
    await expect(terminal(page)).toHaveCount(0);
  });

  test('no swipe starts in the middle of the terminal, while the user is typing, or while a text field has the focus',async({page})=>{
    await openSwipeWorkspace(page);
    const touch=await touchscreen(page,false);
    const {rightEdge,left,right,centre}=await body(page);
    const stays=async(shown:'terminal'|'agent')=>{
      await expect(shown==='terminal'?terminal(page):agentView(page).getByText(emptyAgent)).toBeVisible();
      await expect(shown==='terminal'?page.getByRole('region',{name:'Agent view',exact:true}):terminal(page)).toBeHidden();
    };
    await touch.swipe(right,left);
    await stays('terminal');
    await terminal(page).locator('.xterm').click();
    await page.keyboard.type('ls');
    await touch.swipe(rightEdge,left);
    await stays('terminal');
    expect(await stored(page)).toBeNull();
    // Once typing has stopped, the same swipe works.
    await quiet(page);
    await touch.swipe(rightEdge,left);
    await expect(agentView(page).getByText(emptyAgent)).toBeVisible();
    // A focused text field in the Agent view refuses the return swipe until it loses the focus.
    await agentView(page).evaluate(view=>{const field=document.createElement('textarea');field.id='draft';field.setAttribute('aria-label','Draft');view.append(field);});
    await page.locator('#draft').focus();
    await touch.swipe(centre,right);
    await stays('agent');
    await page.locator('#draft').blur();
    await quiet(page);
    await touch.swipe(centre,right);
    await expect(terminal(page)).toHaveCount(1);
  });

  test('with a conversation shown, the return swipe starts on its messages and never inside a horizontally scrollable block',async({page})=>{
    await openSwipeWorkspace(page,true);
    const touch=await touchscreen(page,false);
    await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
    const agent=agentView(page);
    await expect(agent.getByText(conversationText)).toBeVisible();
    // Wide content such as a diff or a table: the block pans sideways on its own.
    await agent.locator('.agent-bubble-assistant').evaluate(bubble=>{
      const block=document.createElement('div');
      block.id='wide-block';block.style.cssText='overflow-x:auto;height:120px';
      block.innerHTML='<pre style="width:1600px;margin:0;white-space:pre">'+'wide diff line '.repeat(100)+'</pre>';
      bubble.append(block);block.scrollLeft=300;
    });
    const block=(await page.locator('#wide-block').boundingBox())!;
    const inside={x:block.x+block.width*0.3,y:block.y+block.height/2};
    await touch.swipe(inside,{x:block.x+block.width-30,y:inside.y});
    await expect(agent.getByText(conversationText)).toBeVisible();
    await expect(terminal(page)).toHaveCount(0);
    expect(await page.locator('#wide-block').evaluate(node=>node.scrollLeft)).toBeLessThan(300);
    // The same swipe on the message text next to it returns to the terminal.
    await quiet(page);
    const text=(await agent.getByText(conversationText).boundingBox())!;
    await touch.swipe({x:text.x+text.width*0.2,y:text.y+text.height/2},{x:text.x+text.width+150,y:text.y+text.height/2});
    await expect(terminal(page)).toHaveCount(1);
  });
});

test('a window wider than a phone keeps its buttons and ignores the swipe',async({page})=>{
  await page.setViewportSize({width:1280,height:850});
  await openSwipeWorkspace(page);
  const touch=await touchscreen(page,true);
  const {rightEdge,left}=await body(page);
  await touch.swipe(rightEdge,left);
  await expect(terminal(page)).toHaveCount(1);
  await showAgent(page);
});
