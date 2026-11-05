import {expect,test,type Page} from '@playwright/test';
import {mountHerdrSpaces as mount} from './fixtures/herdrSpacesPage';

const commands=(page:Page)=>page.evaluate(()=>window.herdrCreate.calls.map(call=>call.command));
async function openWorktree(page:Page) {
  const more=page.getByRole('button',{name:'More actions for Development',exact:true});
  await more.click();await expect(more).toHaveAttribute('aria-expanded','true');
  await page.getByRole('menu',{name:'More actions for Development'}).getByRole('menuitem',{name:'New worktree from Development'}).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}
const call=(page:Page,command:string)=>page.evaluate(command=>window.herdrCreate.calls.filter(call=>call.command===command).map(call=>call.args),command);
async function fitsWidth(page:Page) {
  const size=await page.getByRole('dialog').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth,viewport:window.innerWidth,right:node.getBoundingClientRect().right}));
  expect(size.scroll,JSON.stringify(size)).toBeLessThanOrEqual(size.width);
  expect(size.right,JSON.stringify(size)).toBeLessThanOrEqual(size.viewport);
}

test('new workspace validates, shows the exact command and starts no agent unless asked',async({page})=>{
  await mount(page);
  await page.getByRole('button',{name:'New workspace',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'New Herdr workspace'});
  await expect(dialog.getByRole('radio',{name:'No, only create it'})).toBeChecked();
  await dialog.getByRole('button',{name:'Review commands'}).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a label');
  await dialog.getByRole('textbox',{name:'Workspace or tab label'}).fill("api's $(touch nope)");
  await dialog.getByRole('textbox',{name:'Herdr project directory'}).fill('relative/path');
  await dialog.getByRole('button',{name:'Review commands'}).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter an absolute path');
  // Browse the host over the existing SFTP listing; hidden entries and files are not offered.
  await dialog.getByRole('button',{name:'Browse host folders'}).click();
  const browser=dialog.getByRole('region',{name:'Browse host folders'});
  await expect(browser.getByRole('button',{name:'.hidden'})).toHaveCount(0);
  await expect(browser.getByRole('button',{name:'notes.txt'})).toHaveCount(0);
  await browser.getByRole('button',{name:'srv',exact:true}).click();
  await browser.getByRole('button',{name:'api',exact:true}).click();
  await expect(dialog.getByRole('textbox',{name:'Herdr project directory'})).toHaveValue('/srv/api');
  await dialog.getByRole('combobox',{name:'Known directories'}).selectOption('/srv/app');
  await fitsWidth(page);
  await dialog.getByRole('button',{name:'Review commands'}).click();
  const [plan]=await call(page,'herdr_workspace_plan');
  expect(plan).toEqual({name:'default',request:{target:{type:'directory',label:"api's $(touch nope)",directory:'/srv/app'}}});
  await expect(dialog.locator('ol code')).toHaveText(["'herdr' '--session' 'default' 'workspace' 'create' '--no-focus' '--label' 'api'\\''s $(touch nope)' '--cwd' '/srv/app'"]);
  await expect(dialog.getByText('No agent will be started.')).toBeVisible();
  await fitsWidth(page);
  expect(await commands(page)).not.toContain('herdr_workspace_create');
  await dialog.getByRole('button',{name:'Create',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await call(page,'herdr_workspace_create')).toEqual([{sessionId:'herdr-create-host',name:'default',request:plan!.request}]);
  await expect.poll(()=>page.evaluate(()=>window.herdrCreate.navigations)).toEqual([{kind:'workspace',workspace:'w9'}]);
  const issued=await commands(page);
  for(const forbidden of ['herdr_agent_kinds','herdr_action','herdr_chat','write_stdin'])expect(issued).not.toContain(forbidden);
});

test('worktree dialog requires an explicit agent choice and keeps partial results',async({page})=>{
  await mount(page,{outcome:{worktree:'/srv/app-worktrees/review',workspaceId:'w9',paneId:'w9:p1',failure:{stage:'agent',message:'timeout: timed out waiting for agent startup'}}});
  // Only workspaces with a reported directory offer the action.
  await expect(page.getByRole('button',{name:'More actions for Scratch'})).toHaveCount(0);
  await openWorktree(page);
  const dialog=page.getByRole('dialog',{name:'New worktree from Development'});
  await expect(dialog.getByRole('textbox',{name:'New branch'})).toHaveValue('development');
  await expect(dialog.getByRole('textbox',{name:'Base revision'})).toHaveValue('main');
  await expect(dialog.getByRole('textbox',{name:'Worktree path'})).toHaveValue('/srv/app-worktrees/development');
  expect(await call(page,'herdr_repository')).toEqual([{sessionId:'herdr-create-host',directory:'/srv/app'}]);
  await dialog.getByRole('textbox',{name:'New branch'}).fill('bad..name');
  await dialog.getByRole('button',{name:'Review commands'}).click();
  await expect(dialog.getByRole('alert')).toContainText('valid Git branch name');
  await dialog.getByRole('textbox',{name:'New branch'}).fill('feat/review');
  await expect(dialog.getByRole('textbox',{name:'Worktree path'})).toHaveValue('/srv/app-worktrees/feat-review');
  await dialog.getByRole('textbox',{name:'Worktree path'}).fill('/srv/app-worktrees/review');
  await dialog.getByRole('textbox',{name:'New branch'}).fill('feat/review');
  await expect(dialog.getByRole('textbox',{name:'Worktree path'})).toHaveValue('/srv/app-worktrees/review');
  expect(await commands(page)).not.toContain('herdr_agent_kinds');
  await dialog.getByRole('radio',{name:'Yes, start an agent'}).check();
  const agent=dialog.getByRole('combobox',{name:'Agent'});
  await expect(agent.locator('option')).toHaveText(['Choose an agent','Codex (codex)','OpenCode (opencode)']);
  await dialog.getByRole('button',{name:'Review commands'}).click();
  await expect(dialog.getByRole('alert')).toContainText('Choose which agent to start');
  expect(await commands(page)).not.toContain('herdr_workspace_plan');
  await agent.selectOption('opencode');
  await expect(dialog.getByRole('textbox',{name:'Initial prompt (optional)'})).toHaveCount(0);
  await agent.selectOption('codex');
  await dialog.getByRole('textbox',{name:'Initial prompt (optional)'}).fill("review 'this'");
  await fitsWidth(page);
  await dialog.getByRole('button',{name:'Review commands'}).click();
  const [plan]=await call(page,'herdr_workspace_plan') as {request:{agent:{name:string}}}[];
  expect(plan!.request.agent.name).toMatch(/^codex-[0-9a-f]{8}$/);
  const name=plan!.request.agent.name;
  await expect(dialog.locator('ol code')).toHaveText([
    "'command' '-v' '--' 'codex'",
    "'git' '-C' '/srv/app' 'worktree' 'add' '-b' 'feat/review' '--' '/srv/app-worktrees/review' 'main'",
    "'herdr' '--session' 'default' 'workspace' 'create' '--no-focus' '--label' 'feat/review' '--cwd' '/srv/app-worktrees/review'",
    `'herdr' '--session' 'default' 'agent' 'start' '${name}' '--kind' 'codex' '--pane' '<new-workspace-pane>' '--timeout' '60000' '--' 'review '\\''this'\\'''`,
  ]);
  await expect(dialog.getByText('becomes the first pane of the new workspace')).toBeVisible();
  await fitsWidth(page);
  await dialog.getByRole('button',{name:'Back'}).click();
  await expect(dialog.getByRole('textbox',{name:'Worktree path'})).toHaveValue('/srv/app-worktrees/review');
  await dialog.getByRole('button',{name:'Review commands'}).click();
  expect(await commands(page)).not.toContain('herdr_workspace_create');
  await dialog.getByRole('button',{name:'Create and start agent'}).click();
  await expect(dialog.getByRole('alert')).toContainText('The worktree was created at /srv/app-worktrees/review.');
  await expect(dialog.getByRole('alert')).toContainText('timeout: timed out waiting for agent startup');
  await expect(dialog.getByRole('alert')).toContainText('Nothing was removed');
  const [created]=await call(page,'herdr_workspace_create') as {request:unknown}[];
  expect((await call(page,'herdr_workspace_plan')).map(plan=>plan.request)).toEqual([created!.request,created!.request]);
  expect(created!.request).toEqual({target:{type:'worktree',repository:'/srv/app',branch:'feat/review',base:'main',path:'/srv/app-worktrees/review'},agent:{kind:'codex',name,prompt:"review 'this'"}});
  expect(await page.evaluate(()=>window.herdrCreate.navigations)).toEqual([]);
  await dialog.getByRole('button',{name:'Open workspace'}).click();
  await expect.poll(()=>page.evaluate(()=>window.herdrCreate.navigations)).toEqual([{kind:'workspace',workspace:'w9'}]);
  const issued=await commands(page);
  for(const forbidden of ['herdr_action','herdr_chat','write_stdin'])expect(issued).not.toContain(forbidden);
});

test('closing the agent question without choosing never launches anything',async({page})=>{
  await mount(page);
  await openWorktree(page);
  const dialog=page.getByRole('dialog',{name:'New worktree from Development'});
  await dialog.getByRole('radio',{name:'Yes, start an agent'}).check();
  await dialog.getByRole('radio',{name:'No, only create it'}).check();
  await expect(dialog.getByRole('combobox',{name:'Agent'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Review commands'}).click();
  await expect(dialog.locator('ol code')).toHaveCount(2);
  await expect(dialog.getByText('No agent will be started.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await commands(page)).not.toContain('herdr_workspace_create');
});
