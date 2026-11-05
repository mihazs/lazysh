import {expect,test,type Page} from '@playwright/test';
import {mountHerdrSpaces} from './fixtures/herdrSpacesPage';

const repo='/home/fixture/dev/harness-improver';
const worktree=`${repo}/.worktrees/readiness-ai-memory-handoff-with-a-long-branch`;
const pane=(workspace:string,tab:string,id:string,terminal:string,cwd:string,status:string)=>({workspace_id:workspace,tab_id:tab,pane_id:id,terminal_id:terminal,cwd,focused:false,agent_status:status});
/** Mirrors the reported phone layout: a busy space with nested tabs, long names and paths, and one quiet space. */
const tree={
  workspaces:[{workspace_id:'w1',label:'harness-improver',focused:true,agent_status:'working'},{workspace_id:'w2',label:'lazysh',focused:false,agent_status:'idle'}],
  tabs:[
    {workspace_id:'w1',tab_id:'w1:t1',label:'readiness › Ai-memory handoff for the long running harness review',number:1,focused:true,agent_status:'working'},
    {workspace_id:'w1',tab_id:'w1:t2',label:'review',number:2,focused:false,agent_status:'working'},
    {workspace_id:'w2',tab_id:'w2:t1',label:'shell',number:1,focused:false,agent_status:'idle'},
  ],
  panes:[
    pane('w1','w1:t1','w1:p1','term-claude',worktree,'working'),
    pane('w1','w1:t1','w1:p2','term-shell',repo,'blocked'),
    pane('w1','w1:t2','w1:p3','term-codex',repo,'working'),
    pane('w2','w2:t1','w2:p1','term-lazysh','/srv/lazysh','idle'),
  ],
  agents:[
    {terminal_id:'term-claude',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',name:null,agent:'claude',agent_status:'working'},
    {terminal_id:'term-codex',workspace_id:'w1',tab_id:'w1:t2',pane_id:'w1:p3',name:'codex',agent:'codex',agent_status:'working'},
  ],
};

async function mount(page:Page,phone:boolean) {
  await mountHerdrSpaces(page,{tree,hostLabel:'fixture@desktop.invalid · Mosh',sidebar:true},'harness-improver');
  // The desktop Workspaces sidebar is at least 300px wide; check the narrowest one.
  if(!phone)await page.locator('.herdr-create-fixture > .sidebar').evaluate(node=>{node.style.width='300px';});
  return page.getByRole('region',{name:'Herdr navigation',exact:true});
}
const row=(page:Page,label:string)=>page.locator('.herdr-navigation-tree button.herdr-navigation-row').filter({has:page.locator('strong').getByText(label,{exact:true})});

test('Spaces rows use one indentation step, stay on one line and show each status once',async({page},testInfo)=>{
  const live=await mount(page,testInfo.project.name==='phone');
  await expect(live.locator('.herdr-navigation-tree > li')).toHaveCount(2);
  const layout=await live.evaluate(node=>{
    const shown=(element:Element)=>{const box=element.getBoundingClientRect();return box.width>1 && box.height>1;};
    const lines=(element:Element)=>{const range=document.createRange();range.selectNodeContents(element);return new Set(Array.from(range.getClientRects()).filter(rect=>rect.width>0).map(rect=>Math.round(rect.top))).size;};
    return Array.from(node.querySelectorAll('.herdr-navigation-tree > li')).map(space=>{
      const rows=Array.from(space.querySelectorAll('button.herdr-navigation-row'));
      return {
        indents:[...new Set(rows.map(row=>Math.round(row.getBoundingClientRect().left)))].sort((a,b)=>a-b),
        wrapped:rows.flatMap(row=>Array.from(row.querySelectorAll('strong, small')).filter(shown).filter(text=>lines(text)>1).map(text=>text.textContent)),
        statuses:rows.flatMap(row=>Array.from(row.querySelectorAll(':scope > small')).filter(shown).map(status=>[row.querySelector('strong')?.textContent,status.textContent])),
      };
    });
  });
  expect(await live.locator('header small').evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);return new Set(Array.from(range.getClientRects()).map(rect=>Math.round(rect.top))).size;})).toBe(1);
  for(const space of layout) {
    expect(space.indents,JSON.stringify(space)).toHaveLength(2);
    expect(space.indents[1]!-space.indents[0]!).toBeGreaterThanOrEqual(8);
    expect(space.indents[1]!-space.indents[0]!).toBeLessThanOrEqual(24);
    expect(space.wrapped).toEqual([]);
  }
  // The space carries the aggregate; a pane shows its own state only when it differs from its tab.
  expect(layout.map(space=>space.statuses)).toEqual([[['harness-improver','Working'],['w1:p2','Needs attention']],[['lazysh','Idle']]]);
  const claude=row(page,'claude');
  await expect(claude).toHaveAccessibleName(/^claude.*~\/dev\/harness-improver\/\.worktrees\/readiness-ai-memory-handoff-with-a-long-branch.*Working$/);
  await expect(claude.locator('small').first()).toHaveText('~/dev/harness-improver/.worktrees/readiness-ai-memory-handoff-with-a-long-branch');
  await expect(claude.locator('small').first()).toHaveAttribute('title',worktree);
  await expect(row(page,'w2:p1').locator('small').first()).toHaveText('/srv/lazysh');
  await expect(row(page,'harness-improver')).toContainText('2 tabs');
  await expect(row(page,'lazysh')).toContainText('1 tab');
  for(const button of await live.getByRole('button').all()) {
    await expect(button).toHaveAccessibleName(/\S/);
    if(!await button.isVisible())continue;
    const box=(await button.boundingBox())!;
    expect(box.height,await button.innerText()).toBeGreaterThanOrEqual(44);expect(box.width).toBeGreaterThanOrEqual(44);
  }
  // The search row (search, server, focus note, refresh), New workspace and the tree share the same edges; nothing scrolls sideways.
  const edges=await page.evaluate(()=>{
    const box=(selector:string)=>document.querySelector(selector)!.getBoundingClientRect();
    const refresh=box('.herdr-navigation > header > .icon-button[title="Refresh Herdr tree"]'),search=box('.herdr-navigation input[type=search]');
    return {searchRow:[search.left,refresh.right],rows:[search.top,refresh.top],create:[box('.herdr-create-trigger').left,box('.herdr-create-trigger').right],tree:[box('.herdr-navigation-tree').left,box('.herdr-navigation-tree').right]};
  });
  expect(Math.abs(edges.rows[0]!-edges.rows[1]!),JSON.stringify(edges)).toBeLessThanOrEqual(8);
  for(const edge of [edges.create,edges.tree])for(const side of [0,1])expect(Math.abs(edge[side]!-edges.searchRow[side]!),JSON.stringify(edges)).toBeLessThanOrEqual(1);
  expect(await page.locator('.herdr-create-fixture > .sidebar').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('herdr-spaces-declutter.png')});
});

test('collapsed spaces and tabs show counts, single-pane tabs have no disclosure and every row still navigates',async({page},testInfo)=>{
  const live=await mount(page,testInfo.project.name==='phone');
  await expect(live.getByRole('button',{name:'Expand or collapse review',exact:true})).toHaveCount(0);
  await expect(live.getByRole('button',{name:'Expand or collapse shell',exact:true})).toHaveCount(0);
  const tab=live.getByRole('button',{name:'Expand or collapse readiness › Ai-memory handoff for the long running harness review',exact:true});
  const tabRow=row(page,'readiness › Ai-memory handoff for the long running harness review');
  await expect(tabRow).not.toContainText('2 panes');
  await tab.click();
  await expect(tab).toHaveAttribute('aria-expanded','false');
  await expect(row(page,'claude')).toHaveCount(0);await expect(row(page,'w1:p2')).toHaveCount(0);
  await expect(tabRow).toContainText('2 panes');
  await expect(row(page,'codex')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('herdr-spaces-collapsed-tab.png')});
  await tab.click();await expect(row(page,'claude')).toBeVisible();
  const space=live.getByRole('button',{name:'Expand or collapse harness-improver',exact:true});
  await space.click();await expect(space).toHaveAttribute('aria-expanded','false');
  await expect(tabRow).toHaveCount(0);await expect(row(page,'harness-improver')).toContainText('2 tabs');
  await space.click();
  await row(page,'harness-improver').click();
  await row(page,'review').click();
  await row(page,'claude').click();
  await expect.poll(()=>page.evaluate(()=>window.herdrCreate.navigations)).toEqual([
    {kind:'workspace',workspace:'w1'},
    {kind:'tab',workspace:'w1',tab:'w1:t2'},
    {kind:'pane',workspace:'w1',tab:'w1:t1',pane:'w1:p1',terminal:'term-claude'},
  ]);
});

test('space actions live in an overflow menu opened by its button or a long press',async({page},testInfo)=>{
  const live=await mount(page,testInfo.project.name==='phone');
  await expect(live.getByRole('button',{name:'New worktree from harness-improver',exact:true})).toHaveCount(0);
  const more=live.getByRole('button',{name:'More actions for harness-improver',exact:true});
  await more.click();
  const menu=page.getByRole('menu',{name:'More actions for harness-improver'});
  const item=menu.getByRole('menuitem',{name:'New worktree from harness-improver'});
  await expect(item).toBeFocused();await expect(item).toBeInViewport({ratio:1});
  await page.screenshot({path:testInfo.outputPath('herdr-spaces-actions.png')});
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);await expect(more).toBeFocused();await expect(more).toHaveAttribute('aria-expanded','false');
  await row(page,'harness-improver').dispatchEvent('contextmenu');
  await expect(item).toBeFocused();
  await page.locator('.herdr-navigation input[type=search]').click();
  await expect(menu).toHaveCount(0);
  await more.click();await item.click();
  await expect(page.getByRole('dialog',{name:'New worktree from harness-improver'})).toBeVisible();
  expect(await page.evaluate(()=>window.herdrCreate.navigations)).toEqual([]);
});
