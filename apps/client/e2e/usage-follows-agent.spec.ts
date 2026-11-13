import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl,openPreferenceCategory,closePreferences} from './fixtures/workspaceControl';
import {tmuxChatSnapshot} from '../src/test/tmuxChat';

type Fixture={focus:string;accountReads:number;treeReads:number;paneReads:number;pane:string;state:'ready'|'timeout';old:boolean;reports:unknown[]};
declare global {interface Window {usageFixture:Fixture}}

const accounts=[
  {id:'anthropic',name:'Claude',shortName:'cld',used:100},{id:'openai',name:'Codex',shortName:'gpt',used:35},{id:'copilot',name:'GitHub Copilot',shortName:'ghc',used:7},
];

/** A connected host whose Herdr (or tmux) panes run Claude Code, Codex, Gemini and a plain shell; `primary` is the host's default account. */
async function open(page:Page,attached:{kind:'herdr'|'tmux';name:string}|null,primary='copilot') {
  await installNativeBridge(page);
  await page.addInitScript(({attached,accounts,primary,tmuxSnapshot})=>{
    if(attached)localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture',attached}]));
    // These tests count `herdr_tree` reads to prove when the usage item reads the pane; the tab strip reads the same tree, so it is off here.
    if(!sessionStorage.getItem('strip-off')){sessionStorage.setItem('strip-off','1');localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,tabStrip:'off'}));}
    const fixture:Fixture=window.usageFixture={focus:'p1',accountReads:0,treeReads:0,paneReads:0,pane:'%3',state:'ready',old:false,reports:[]};
    const pane=(id:string)=>({workspace_id:'w1',tab_id:'w1:t1',pane_id:id,terminal_id:`term-${id}`,cwd:'/work',focused:id===fixture.focus,agent_status:'idle'});
    const agent=(id:string,name:string)=>({terminal_id:`term-${id}`,workspace_id:'w1',tab_id:'w1:t1',pane_id:id,agent_status:'idle',agent:name,name:null});
    let connections=0;
    window.nativeFixtureInvoke=async(command,args)=>{
      switch(command) {
        case 'list_hosts':return [{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22}];
        case 'local_capability':return {available:false,reason:'Synthetic usage fixture.'};
        case 'transport_capabilities':return {mosh:false,et:false};
        case 'has_credentials':return false;
        case 'connect':return {sessionId:`ssh-${++connections}`};
        case 'attach_multiplexer':case 'attach_tmux':return {sessionId:`display-${String(args.name)}`};
        case 'multiplexer_sessions':return [{name:'main'}];
        case 'multiplexer_tree':return {tmuxAvailable:attached?.kind==='tmux',herdrAvailable:attached?.kind==='herdr',zellijAvailable:false,tools:[{kind:attached?.kind??'tmux',version:attached?.kind==='herdr'?'0.9.3':'3.4',support:attached?.kind==='herdr'?'navigationOnly':'full',missing:[]}],sessions:[]};
        case 'herdr_tree':
          fixture.treeReads++;
          return {workspaces:[{workspace_id:'w1',label:'work',focused:true,agent_status:'idle'}],tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:'1',number:1,focused:true,agent_status:'idle'}],
            panes:['p1','p2','p3','p4'].map(pane),agents:[agent('p1','claude'),agent('p2','codex'),agent('p3','gemini')]};
        case 'agent_snapshot':fixture.paneReads++;return {schemaVersion:1,sessions:fixture.reports};
        case 'tmux_chat':return {...tmuxSnapshot,destination:{...tmuxSnapshot.destination,paneId:fixture.pane}};
        case 'account_usage':
          fixture.accountReads++;
          if(fixture.state==='timeout')return {schemaVersion:1,state:'timeout',report:null};
          return {schemaVersion:1,source:'builtin',state:'ready',report:{primary,entries:accounts.map(account=>({id:account.id,name:account.name,shortName:account.shortName,plan:'Pro',status:'ready',stale:false,
            fetchedAt:new Date(Date.now()-(fixture.old?3_600_000:0)).toISOString(),resetCredits:null,rows:[{type:'metric',label:'Weekly',percent:account.used,value:`${account.used}%`,detail:'',headline:'percent',reading:'used',resetAt:null,windowSeconds:null,regen:null,modelPool:false}]}))}};
        default:if(command.startsWith('plugin:event|')||['resize','ack_output','disconnect','cancel_credential_auth','write_stdin'].includes(command))return;throw new Error(`Unexpected usage fixture command: ${command}`);
      }
    };
  },{attached,accounts,primary,tmuxSnapshot:tmuxChatSnapshot});
  await page.goto('/');
  if(attached)await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  else {
    if(await page.getByRole('button',{name:'Open hosts',exact:true}).isVisible())await page.getByRole('button',{name:'Open hosts',exact:true}).click();
    await page.getByRole('button',{name:'Connect to Fixture',exact:true}).click();
    await page.getByLabel('Password',{exact:true}).fill('owned-browser-fixture');
    await page.getByRole('button',{name:'Connect',exact:true}).click();
  }
}
const chip=(page:Page)=>page.getByRole('button',{name:'Open AI account usage',exact:true});
const fixture=(page:Page)=>page.evaluate(()=>({...window.usageFixture}));
const setFixture=(page:Page,patch:Partial<Fixture>)=>page.evaluate(patch=>{Object.assign(window.usageFixture,patch);},patch);
async function usageSetting(page:Page,mode:'Follow the current agent'|'Always show a chosen account'|'Hide the usage item') {
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'AccountUsage');
  await page.getByRole('radio',{name:mode,exact:true}).check();
}

test('Herdr: the usage item follows the focused pane, falls back with no agent, and says so for an agent without an account',async({page},testInfo)=>{
  await page.setViewportSize({width:415,height:900});
  await open(page,{kind:'herdr',name:'main'});
  // On by default, no setting touched: Claude Code is focused, so the bar shows the Claude account, not the host default (GitHub Copilot).
  await expect(chip(page)).toHaveText('Claude 100% used',{timeout:15_000});
  await page.screenshot({path:testInfo.outputPath('follow-claude.png')});
  await setFixture(page,{focus:'p2'});
  await expect(chip(page)).toHaveText('Codex 35% used',{timeout:15_000});
  await page.screenshot({path:testInfo.outputPath('follow-codex.png')});
  await setFixture(page,{focus:'p3'});
  await expect(chip(page)).toHaveText('No usage for gemini',{timeout:15_000});
  await expect(chip(page).locator('meter')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('follow-unsupported-agent.png')});
  await setFixture(page,{focus:'p4'});
  await expect(chip(page)).toHaveText('GitHub Copilot 7% used',{timeout:15_000});
  await page.screenshot({path:testInfo.outputPath('follow-fallback-host-default.png')});
  // Following needs no account read per pane change.
  expect((await fixture(page)).accountReads).toBe(1);
  const layout=await chip(page).evaluate(button=>({overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,footer:button.closest('footer')!.scrollWidth>button.closest('footer')!.clientWidth}));
  expect(layout).toEqual({overflow:false,footer:false});
});

test('Preferences: always showing a chosen account ignores the pane, hiding removes the item and stops reading the pane, following resumes',async({page},testInfo)=>{
  await open(page,{kind:'herdr',name:'main'});
  await expect(chip(page)).toHaveText('Claude 100% used',{timeout:15_000});
  await usageSetting(page,'Always show a chosen account');
  await page.getByLabel('Account when always shown, or when no agent is detected').selectOption('openai');
  await closePreferences(page);
  await expect(chip(page)).toHaveText('Codex 35% used');
  await setFixture(page,{focus:'p3'});
  await page.waitForTimeout(6000);
  await expect(chip(page)).toHaveText('Codex 35% used');
  await page.screenshot({path:testInfo.outputPath('fixed-codex.png')});
  await usageSetting(page,'Hide the usage item');
  await closePreferences(page);
  await expect(chip(page)).toHaveCount(0);
  const reads=(await fixture(page)).treeReads;
  await page.waitForTimeout(6500);
  expect((await fixture(page)).treeReads).toBe(reads);
  await usageSetting(page,'Follow the current agent');
  await closePreferences(page);
  await expect(chip(page)).toHaveText('No usage for gemini',{timeout:15_000});
});

test('the pane is not read while a short phone window hides the whole bar',async({page})=>{
  await page.setViewportSize({width:390,height:640});
  await open(page,{kind:'herdr',name:'main'});
  await expect(page.locator('.workspace-footer')).toBeHidden();
  await page.waitForTimeout(6500);
  expect((await fixture(page)).treeReads).toBe(0);
  // Back to a tall window: the bar returns and starts following again.
  await page.setViewportSize({width:390,height:844});
  await expect(chip(page)).toHaveText('Claude 100% used',{timeout:15_000});
});

test('stale and unavailable states stay honest while following',async({page},testInfo)=>{
  await page.setViewportSize({width:415,height:900});
  await open(page,{kind:'herdr',name:'main'});
  await setFixture(page,{old:true});
  await page.getByRole('button',{name:'Open AI account usage',exact:true}).click();
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(chip(page)).toContainText('Claude 100% used');
  await expect(chip(page).getByLabel('Stale account usage')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('follow-stale.png')});
  await setFixture(page,{state:'timeout'});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByText('The account usage refresh timed out.')).toBeVisible();
  await expect(chip(page)).toContainText('Claude 100% used');
  await expect(chip(page).getByLabel('Stale account usage')).toBeVisible();
});

test('tmux: the item follows the pane the terminal is attached to through the companion report',async({page},testInfo)=>{
  await page.setViewportSize({width:415,height:900});
  await open(page,{kind:'tmux',name:'work'});
  const report=(agent:string,paneId:string,summary='Turn finished')=>({sessionId:`${agent}-${paneId}`,agent,project:'/work',state:'done',updatedAt:new Date().toISOString(),summary,paneId,eventCount:2});
  // Nothing reported for the pane yet: the host default shows.
  await expect(chip(page)).toHaveText('GitHub Copilot 7% used',{timeout:15_000});
  await setFixture(page,{reports:[report('Codex','%3')]});
  await expect(chip(page)).toHaveText('Codex 35% used',{timeout:15_000});
  await page.screenshot({path:testInfo.outputPath('tmux-codex.png')});
  await setFixture(page,{reports:[report('Claude Code','%3','Bash'),report('Codex','%3')]});
  await expect(chip(page)).toHaveText('Claude 100% used',{timeout:15_000});
  await setFixture(page,{pane:'%9'});
  await expect(chip(page)).toHaveText('GitHub Copilot 7% used',{timeout:15_000});
});

test('a plain connection has no pane to read, so the host default shows and nothing polls',async({page})=>{
  await open(page,null);
  await expect(chip(page)).toHaveText('GitHub Copilot 7% used',{timeout:15_000});
  await page.waitForTimeout(6500);
  const state=await fixture(page);
  expect([state.treeReads,state.paneReads]).toEqual([0,0]);
});
