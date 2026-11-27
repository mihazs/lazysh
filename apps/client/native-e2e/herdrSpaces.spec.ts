import {expect,it} from 'vitest';
import {HerdrFixture,herdrTools} from '../../../tests/support/androidHerdr';
import {NativeGui} from './fixture';
import {finishOwnedHerdr,openOwnedSsh,ownedSshGui} from './sshUi';

const fixture=ownedSshGui();
const storageKey='lazysh.multiplexer.layout';

it('chooses each Herdr Spaces layout against the real server, keeps it after the sidebar closes and opens an Agents row on its exact pane in the actual GUI',async()=>{
  const herdr=await HerdrFixture.start(herdrTools());fixture.ssh=herdr;
  const metadata=herdr.metadata(),{agent,agentContext}=metadata,history='history' in metadata?metadata.history:undefined;
  if(!history)throw new Error('Owned Herdr history pane required');
  const snapshot=async()=>JSON.parse(await herdr.run(['api','snapshot'])).result.snapshot;
  // A second real space, so the accordion has a space to keep closed; the server keeps the first one focused.
  await herdr.run(['workspace','create','--no-focus','--label','LAYOUT_SPACE_'+herdr.ssh.nonce,'--cwd',herdr.ssh.directory]);
  const gui=fixture.gui=await NativeGui.start();
  const {browser,terminal,owner}=await openOwnedSsh(gui,herdr.ssh,'ssh',undefined,{kind:'herdr',name:herdr.name});
  const open=async(mode:'workspaces'|'agents')=>{
    const view=await browser.$(`.herdr-navigation[data-mode="${mode==='agents'?'agents':'spaces'}"]:not([hidden])`);
    if(!await view.isDisplayed())await (await (await browser.$('.workspace-navigation-modes')).$(`button[data-workspace-mode="${mode}"]`)).click();
    await view.waitForDisplayed({timeout:20_000});
    return view;
  };
  const closeSidebar=async()=>{
    await (await browser.$('.workspace-destination-heading button[aria-label="Return to terminal"]')).click();
    await terminal.waitForDisplayed();
  };
  // What the layout selector, the stored preference, the tree and each space's expansion say right now.
  const shown=()=>browser.execute((key:string)=>{
    const root=document.querySelector('.herdr-navigation[data-mode="spaces"]:not([hidden])');
    const select=Array.from(root?.querySelectorAll('label')??[]).find(label=>label.textContent?.startsWith('Jump To layout'))?.querySelector('select');
    return {selected:select?.value,stored:localStorage.getItem(key),tree:root?.querySelector('.herdr-navigation-tree')?.className,
      open:Array.from(root?.querySelectorAll('li.herdr-space')??[]).map(space=>space.querySelector(':scope > ul')!==null)};
  },storageKey);
  const showing=(layout:string,open:number)=>browser.waitUntil(async()=>{
    const now=await shown();
    return now.selected===layout && now.stored===layout && !!now.tree?.split(' ').includes(`herdr-layout-${layout}`) && now.open.length===2 && now.open.filter(Boolean).length===open;
  },{timeout:20_000,timeoutMsg:`Herdr Spaces did not show the ${layout} layout with ${open} open space(s)`});
  const focused=(pane:string,tab:string)=>browser.waitUntil(async()=>{const now=await snapshot();return now.focused_pane_id===pane && now.focused_tab_id===tab;},
    {timeout:30_000,timeoutMsg:'The real Herdr server did not focus the pane chosen in the GUI'});
  // A row's navigation ends by closing the sidebar; waiting for the terminal keeps the next press off a row that is still busy.
  const choose=async(strong:string)=>{
    await (await (await open('workspaces')).$(`.//button[contains(@class,"herdr-navigation-row")][.//strong[normalize-space(.)=${JSON.stringify(strong)}]]`)).click();
    await terminal.waitForDisplayed();
  };

  gui.stage='owned Herdr Spaces layouts';
  await (await open('workspaces')).$('.herdr-navigation-tree').waitForDisplayed({timeout:20_000});
  expect((await shown()).selected).toBe('list');
  expect((await snapshot()).workspaces).toHaveLength(2);
  // Each layout keeps focusing the exact pane the row names, the preference is stored when chosen and is what the reopened sidebar shows.
  for(const [layout,spaces] of [['accordion',1],['grid',2],['list',2]] as const) {
    await (await (await (await open('workspaces')).$('label*=Jump To layout')).$('select')).selectByAttribute('value',layout);
    await showing(layout,spaces);
    await closeSidebar();
    await open('workspaces');
    await showing(layout,spaces);
    await choose(history.paneId);
    await focused(history.paneId,history.tabId);
    await open('workspaces');
    await showing(layout,spaces);
    await choose('codex');
    await focused(agent.paneId,agent.tabId);
  }

  gui.stage='owned Herdr Agents row to the exact pane';
  await herdr.run(['tab','focus',history.tabId]);
  await focused(history.paneId,history.tabId);
  const agents=await open('agents');
  const rows=()=>agents.$$('.herdr-agent-row button.herdr-navigation-row');
  await browser.waitUntil(async()=>(await rows()).length===1,{timeout:30_000,timeoutMsg:'Herdr Agents did not list the reported agent'});
  const [row]=await rows();
  // The row names its agent, its workspace, tab and folder before it moves anything.
  expect(await row.$('strong').getText()).toBe('codex');
  expect(await row.$('small').getProperty('textContent')).toBe(agentContext);
  await row.click();
  await terminal.waitForDisplayed();
  await focused(agent.paneId,agent.tabId);

  await finishOwnedHerdr(gui,browser,terminal,owner,herdr);
},180_000);
