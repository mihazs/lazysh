import {expect,test,type Locator,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import type {mountAgentBoard} from './fixtures/AgentBoardHarness';
declare global {interface Window {agentBoard:ReturnType<typeof mountAgentBoard>;}}

const now=Date.parse('2026-10-29T12:05:00Z');
/** Synthetic inbox rows; identifiers only need the stored 64-hex shape. */
function inboxRows(){
  const rows:[string,string,string,string,number,string][]=[['1','needs_attention','Claude Code','/srv/ai-memory',60,'owned-1'],['2','working','Codex','/srv/lazysh',240,'owned-1'],['3','done','Codex','/srv/lazysh',1500,'ended'],['4','done','Claude Code','/srv/notes',7200,'owned-1']];
  return rows.map(([id,state,agent,project,age,sessionId])=>({id:id.repeat(64),eventId:String(Number(id)+4).repeat(64),sessionId,hostId:'h1',hostName:'studio',agent,project,agentSessionId:`r${id}`,state,updatedAt:new Date(now-age*1000).toISOString(),paneId:`%${id}`}));
}

async function expectReachable(page:Page,control:Locator){
  await control.scrollIntoViewIfNeeded();
  const box=(await control.boundingBox())!;const width=page.viewportSize()!.width;
  expect(box.height).toBeGreaterThanOrEqual(44);expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
}

test('agent inbox groups events by state with reachable row actions and folded settings',async({page},testInfo)=>{
  await installNativeBridge(page);
  await page.clock.install({time:new Date(now)});
  await page.addInitScript(rows=>{
    localStorage.setItem('lazysh.inbox.v1',JSON.stringify({version:1,monitoring:true,notifications:false,rows,latest:{}}));
    window.nativeFixtureInvoke=async command=>{
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:false,reason:'Synthetic'};
      if(command.startsWith('plugin:'))return;
      throw new Error(`Unexpected native command: ${command}`);
    };
  },inboxRows());
  await page.goto('/');
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  const tools=page.getByRole('dialog');
  for(const summary of await tools.locator('details:not([open]) > summary').all())await summary.click();
  await tools.getByRole('button',{name:'Open notification inbox',exact:true}).click();
  const inbox=page.getByRole('region',{name:'Agent inbox',exact:true});
  await expect(inbox).toBeVisible();
  await expect(inbox.getByRole('heading',{level:4})).toHaveText([/^Needs you\s*1$/,/^Working\s*1$/,/^Done\s*2$/]);
  const attention=inbox.getByRole('article',{name:'Claude Code'}).first();
  await expect(attention).toContainText('ai-memory');
  await expect(attention.locator('time')).toHaveAttribute('datetime','2026-10-29T12:04:00.000Z');
  await expect(attention.locator('time')).toHaveText(/1 min/);
  expect(await inbox.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await expectReachable(page,attention.getByRole('button',{name:'Open connected session',exact:true}));
  await expectReachable(page,attention.getByRole('button',{name:'Archive',exact:true}));
  const settings=inbox.locator('details.inbox-settings');
  await expect(settings).not.toHaveAttribute('open','');
  await expect(inbox.getByRole('checkbox',{name:'Monitor connected hosts',exact:true})).toBeHidden();
  await page.screenshot({path:testInfo.outputPath('agent-inbox.png')});
  const ended=inbox.locator('article').filter({hasText:'/srv/lazysh'}).filter({has:page.locator('[data-state="done"]')});
  await expect(ended.getByRole('button',{name:'Open connected session',exact:true})).toBeDisabled();
  const done=inbox.getByRole('button',{name:/^Done\s*2$/});
  await done.click();
  await expect(done).toHaveAttribute('aria-expanded','false');
  await expect(inbox.locator('article')).toHaveCount(2);
  await attention.getByRole('button',{name:'Archive',exact:true}).click();
  await expect(inbox.locator('article')).toHaveCount(1);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.inbox.v1')!).rows.length)).toBe(3);
  await settings.locator('summary').click();
  await expect(inbox.getByRole('checkbox',{name:'Monitor connected hosts',exact:true})).toBeChecked();
});

test('approval card counts down and keeps the decision pair side by side and touchable',async({page},testInfo)=>{
  await page.goto('/');
  await page.evaluate(async()=>{const {mountAgentBoard}=await import('/e2e/fixtures/AgentBoardHarness.tsx');window.agentBoard=mountAgentBoard();});
  const root=page.locator('.agent-board-fixture');
  const card=root.locator('.approval-panel article');
  await expect(card).toHaveCount(1);
  const expiry=card.locator('.approval-expiry time');
  await expect(expiry).toHaveText(/^Expires in (9|10):\d\d$/);
  const first=await expiry.textContent();
  await expect(expiry).not.toHaveText(first!,{timeout:3000});
  await expect(card.locator('dt')).toHaveText(['Project','Agent session','Pane']);
  const deny=card.getByRole('button',{name:'Deny request',exact:true});const allow=card.getByRole('button',{name:'Allow this request',exact:true});
  await expectReachable(page,deny);await expectReachable(page,allow);
  const [denyBox,allowBox]=[(await deny.boundingBox())!,(await allow.boundingBox())!];
  expect(Math.abs(denyBox.y-allowBox.y)).toBeLessThan(1);expect(denyBox.x+denyBox.width).toBeLessThanOrEqual(allowBox.x);
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await card.screenshot({path:testInfo.outputPath('approval-card.png')});
  await allow.click();
  await expect(allow).toBeDisabled();
  expect((await page.evaluate(()=>window.agentBoard.calls)).filter(call=>call.command==='resolve_agent_approval')).toHaveLength(1);
  await page.evaluate(()=>window.agentBoard.complete());
  await expect(card).toHaveCount(0);
});
