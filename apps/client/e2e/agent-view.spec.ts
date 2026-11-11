import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {tmuxChatBound,tmuxChatSnapshot} from '../src/test/tmuxChat';

type Fixture={turns:{prompt:string;answer:string}[];typed:string;stdin:string[];inputs:Record<string,unknown>[];attachments:number;state:string;
  channels:Record<string,{onmessage:(event:unknown)=>void}>};
declare global {interface Window {agentView:Fixture;agentViewBase:(command:string)=>{value:unknown}|undefined}}
const transcript='/home/owner/.codex/sessions/rollout 世界.jsonl';

/** The commands every synthetic host answers the same way; each fixture adds its own on top. */
async function installBaseHost(page:Page) {
  await installNativeBridge(page);
  await page.addInitScript(()=>{
    let connections=0;
    window.agentViewBase=command=>{
      switch(command) {
        case 'list_hosts':return {value:[{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22}]};
        case 'local_capability':return {value:{available:false,reason:'Synthetic Agent view fixture.'}};
        case 'transport_capabilities':return {value:{mosh:false,et:false}};
        case 'has_credentials':return {value:false};
        case 'connect':return {value:{sessionId:`ssh-${++connections}`}};
        case 'apple_status_capability':return {value:{available:false,reason:'Synthetic fixture.'}};
        default:return command.startsWith('plugin:event|') || ['resize','ack_output','disconnect','cancel_credential_auth'].includes(command)?{value:undefined}:undefined;
      }
    };
  });
}

/** Two restored tmux terminals; hook reports tie a running Codex conversation to pane %3 of `work` only. */
async function open(page:Page) {
  await installBaseHost(page);
  await page.addInitScript(({snapshot,bound,transcript})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture',attached:{kind:'tmux',name:'work'}},{hostId:'fixture',attached:{kind:'tmux',name:'other'}}]));
    const fixture:Fixture=window.agentView={turns:[{prompt:'Explain the build',answer:'The build uses Vite.'}],typed:'',stdin:[],inputs:[],attachments:0,state:'working',channels:{}};
    const encoder=new TextEncoder();
    const echo=(session:string,text:string)=>fixture.channels[session]?.onmessage({type:'data',data:[...encoder.encode(text)]});
    // The synthetic agent answers each submitted prompt; the terminal echoes it once, as a TUI would.
    const submit=(text:string)=>{echo('display-work',`\r\n> ${text}\r\n`);fixture.turns.push({prompt:text,answer:`Answered: ${text}`});};
    window.nativeFixtureInvoke=async(command,args)=>{
      const base=window.agentViewBase(command);if(base)return base.value;
      if(command==='attach_tmux'){
        fixture.attachments++;const session=`display-${String(args.name)}`;
        fixture.channels[session]=args.events as Fixture['channels'][string];
        setTimeout(()=>echo(session,Array.from({length:40},(_,line)=>`${String(args.name)} scrollback ${line+1}\r\n`).join('')+'$ '));
        return {sessionId:session};
      }
      if(command==='tmux_chat'){
        const action=args.action as {kind:string;operation?:number;input?:{kind:string;text?:string}};
        fixture.inputs.push(action);
        if(action.kind==='snapshot')return {...snapshot,destination:{...snapshot.destination,paneId:args.sessionId==='display-work'?'%3':'%4'}};
        if(action.kind==='bind')return bound;
        if(action.kind==='release')return {kind:'released'};
        if(action.input?.kind==='send')submit(action.input.text!);
        return {kind:'delivered',nextOperation:action.operation!+1};
      }
      if(command==='write_stdin'){
        const data=String(args.data);fixture.stdin.push(data);
        for(const key of data){if(key==='\r'){submit(fixture.typed);fixture.typed='';}else{fixture.typed+=key;echo(String(args.sessionId),key);}}
        return;
      }
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[{sessionId:'codex-thread',agent:'Codex',project:'/work',state:fixture.state,updatedAt:new Date().toISOString(),summary:'Working on your prompt',paneId:'%3',eventCount:4}]};
      if(command==='agent_reported_history')return {schemaVersion:1,sessionId:'codex-thread',status:'available',path:transcript,reportedAt:'2026-11-09T10:00:00Z',paneId:'%3'};
      if(command==='agent_transcript'){
        if(args.path!==transcript || args.agent!=='codex' || args.view!=='conversation')throw new Error('Unexpected transcript');
        return {schemaVersion:1,agent:'codex',view:'active_branch',nextOffset:0,hasMore:false,messages:fixture.turns.flatMap((turn,index)=>[
          {id:`p${index}`,role:'user',blocks:[{type:'text',text:turn.prompt}]},
          {id:`t${index}`,role:'assistant',blocks:[{type:'tool_use',name:'shell',text:'ls'}]},
          {id:`a${index}`,role:'assistant',blocks:[{type:'text',text:turn.answer}]},
        ])};
      }
      if(command==='multiplexer_tree')return {tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}],sessions:[]};
      throw new Error(`Unexpected Agent view fixture command: ${command}`);
    };
  },{snapshot:tmuxChatSnapshot,bound:tmuxChatBound,transcript});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab',{name:'Fixture / work',exact:true}).click();
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('work scrollback 40');
}
const switcher=(page:Page)=>page.getByRole('group',{name:'Session view',exact:true});
const agentView=(page:Page)=>page.getByRole('region',{name:'Agent view',exact:true}).and(page.locator(':visible'));
const terminalText=(page:Page)=>page.locator('.terminal-pane:visible .xterm-rows').innerText();
/** Switches to the Agent view and waits for the bound conversation. */
async function showAgent(page:Page) {
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  const agent=agentView(page);
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  return agent;
}
const fixture=(page:Page)=>page.evaluate(()=>({...window.agentView,channels:undefined}));

test('switches the same tmux session between Terminal and Agent mid-turn without touching the terminal, and both inputs reach both views',async({page})=>{
  await open(page);
  await expect(switcher(page).getByRole('button',{name:'Terminal',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.locator('.terminal-pane:visible .xterm').evaluate(node=>{node.setAttribute('data-original','');});
  const before=await fixture(page);
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  const agent=agentView(page);
  await expect(agent.getByRole('region',{name:'Turn',exact:true})).toHaveCount(1);
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await expect(agent.locator('header')).toContainText('Codex');await expect(agent.locator('header')).toContainText('Working');
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(0);
  // Mid-turn round trip: the same terminal node and scrollback return, nothing reconnects and no byte is written.
  await switcher(page).getByRole('button',{name:'Terminal',exact:true}).click();
  await expect(page.locator('.terminal-pane:visible .xterm[data-original]')).toHaveCount(1);
  expect(await terminalText(page)).toContain('work scrollback 40');
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  const after=await fixture(page);
  expect({attachments:after.attachments,stdin:after.stdin}).toEqual({attachments:before.attachments,stdin:[]});
  expect(after.inputs.every(input=>input.kind==='snapshot')).toBe(true);

  // A prompt sent from the Agent view reaches the terminal once and becomes a turn in the Agent view.
  await agent.getByRole('textbox',{name:'Draft for this terminal',exact:true}).fill('Add a test');
  await agent.getByRole('button',{name:'Choose terminal destination',exact:true}).click();
  await agent.getByRole('button',{name:'Confirm this destination',exact:true}).click();
  await agent.getByRole('button',{name:'Send to terminal',exact:true}).click();
  await expect(agent.getByText('Answered: Add a test',{exact:true})).toBeVisible({timeout:6000});
  await expect(agent.getByRole('region',{name:'Turn',exact:true})).toHaveCount(2);
  await switcher(page).getByRole('button',{name:'Terminal',exact:true}).click();
  expect((await terminalText(page)).split('> Add a test')).toHaveLength(2);
  expect((await fixture(page)).stdin).toEqual([]);

  // A prompt typed in the terminal appears as a new turn in the Agent view within one follow interval.
  await page.locator('.terminal-pane:visible .xterm').click();
  await page.keyboard.type('Typed here');await page.keyboard.press('Enter');
  await expect.poll(async()=>(await fixture(page)).turns.length).toBe(3);
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  await expect(agent.getByText('Answered: Typed here',{exact:true})).toBeVisible({timeout:6000});
});

test('desktop shortcut switches the same session without writing to the terminal',async({page},testInfo)=>{
  test.skip(testInfo.project.name==='phone','Hardware shortcut is covered on desktop.');
  await open(page);
  const before=await fixture(page);
  await page.locator('.terminal-pane:visible .xterm').click();
  await page.keyboard.press('Control+Shift+Y');
  await expect(agentView(page).getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await agentView(page).getByRole('textbox',{name:'Draft for this terminal',exact:true}).fill('Keep this draft');
  await page.keyboard.press('Control+Shift+Y');
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('work scrollback 40');
  const after=await fixture(page);
  expect({attachments:after.attachments,stdin:after.stdin}).toEqual({attachments:before.attachments,stdin:before.stdin});
  await page.keyboard.press('Control+Shift+Y');
  await expect(agentView(page).getByRole('textbox',{name:'Draft for this terminal',exact:true})).toHaveValue('Keep this draft');
});

test('remembers the chosen view per terminal across reopening, keeps new terminals on Terminal and explains a pane without an agent',async({page})=>{
  await open(page);
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  await expect(agentView(page).getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Fixture / other',exact:true}).click();
  await expect(switcher(page).getByRole('button',{name:'Terminal',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('other scrollback 40');
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  const other=agentView(page);
  await expect(other.getByText('No agent conversation for this terminal.',{exact:true})).toBeVisible();
  await other.getByRole('button',{name:'Show terminal',exact:true}).click();
  await expect(switcher(page).getByRole('button',{name:'Terminal',exact:true})).toHaveAttribute('aria-pressed','true');
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  await expect(other.getByRole('button',{name:'Choose transcript',exact:true})).toHaveCount(0);
  await other.getByRole('button',{name:/Codex · \/work/}).click();
  await expect(other.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await expect(other.getByLabel('Transcript path',{exact:true})).toHaveCount(0);
  await expect(other.getByRole('region',{name:'Terminal input'})).toHaveCount(0);
  await other.getByRole('button',{name:'Terminal',exact:true}).click();

  await page.reload();
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await page.getByRole('tab',{name:'Fixture / work',exact:true}).click();
  await expect(switcher(page).getByRole('button',{name:'Agent',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(agentView(page).getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Fixture / other',exact:true}).click();
  await expect(switcher(page).getByRole('button',{name:'Terminal',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
});

test('offers Both only from 1100 px of session width and updates both views during one turn',async({page},testInfo)=>{
  test.skip(testInfo.project.name==='phone','Phone width never offers Both; the desktop case checks both sides of the threshold.');
  await page.setViewportSize({width:1700,height:900});
  await open(page);
  const width=()=>page.locator('.session-body').evaluate(node=>node.clientWidth);
  expect(await width()).toBeGreaterThanOrEqual(1100);
  await switcher(page).getByRole('button',{name:'Both',exact:true}).click();
  const agent=agentView(page),terminal=page.locator('.terminal-pane:visible');
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  const [left,right]=[await terminal.boundingBox(),await agent.boundingBox()];
  expect(left!.x+left!.width).toBeLessThanOrEqual(right!.x+1);
  // The conversation, not the composer, fills the Agent side.
  expect((await agent.getByRole('form',{name:'Transcript draft',exact:true}).boundingBox())!.height).toBeLessThan(right!.height/4);
  await terminal.locator('.xterm').click();
  await page.keyboard.type('Both views');await page.keyboard.press('Enter');
  await expect(terminal.locator('.xterm-rows')).toContainText('> Both views');
  await expect(agent.getByText('Answered: Both views',{exact:true})).toBeVisible({timeout:6000});
  await page.setViewportSize({width:1000,height:800});
  await expect.poll(width).toBeLessThan(1100);
  await expect(switcher(page).getByRole('button',{name:'Both',exact:true})).toHaveCount(0);
  await expect(switcher(page).getByRole('button',{name:'Agent',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(0);
});

test('phone never offers Both',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Desktop thresholds are covered above.');
  await open(page);
  await expect(switcher(page).getByRole('button')).toHaveText(['Terminal','Agent']);
  const box=await switcher(page).boundingBox();
  expect(box!.x+box!.width).toBeLessThanOrEqual(390);
  // Icon segments are full touch targets and leave the session title readable.
  for(const button of await switcher(page).getByRole('button').all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.workspace-header').getByText('Fixture / work',{exact:true})).toBeVisible();
  expect(await page.locator('.workspace-header').getByText('Fixture / work',{exact:true}).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  // The Agent view reads like a chat: no recorded-reader follow controls, and the conversation keeps most of the screen.
  const agent=await showAgent(page);
  await expect(agent.getByRole('checkbox')).toHaveCount(0);
  await expect(agent.getByRole('heading',{name:'user',exact:true})).toHaveCount(0);
  expect((await agent.getByRole('region',{name:'Conversation messages',exact:true}).boundingBox())!.height).toBeGreaterThan(844/2);
  // Back on Terminal, a touch screen does not open the soft keyboard, which would shrink the remote pane.
  await switcher(page).getByRole('button',{name:'Terminal',exact:true}).click();
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('work scrollback 40');
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  expect(await page.evaluate(()=>Boolean(document.activeElement?.closest('.terminal-pane')))).toBe(false);
});

/** Stock Herdr host: six live agents, fifty ended hook reports without pane identity, and a companion that may predate conversation reading. */
/** What a real Claude Code transcript holds around a harness event: usage counters, a background-task notification typed by the harness and tool activity. */
const richConversation=[
  {id:'p0',role:'user',blocks:[{type:'text',text:'Explain the build'}]},
  {id:'t0',role:'assistant',blocks:[{type:'tool_use',name:'Bash',text:'ls'}]},
  {id:'a0',role:'assistant',blocks:[{type:'text',text:'The build uses Vite.'}],usage:{inputTokens:2,outputTokens:51,cacheReadTokens:157518,cacheWriteTokens:1790}},
  {id:'n0',role:'user',blocks:[{type:'text',text:'<task-notification>\n<task-id>bl44ejerw</task-id>\n<summary>Monitor event: "Version PRs whose checks are green or failed"</summary>\n<event>version PR #624 checks green</event>\n</task-notification>'}]},
  {id:'t1',role:'assistant',blocks:[{type:'tool_use',name:'Bash',text:'gh pr list'},{type:'tool_use',name:'Monitor',text:'watch'}]},
  {id:'a1',role:'assistant',blocks:[{type:'text',text:'v0.158.0 is published.'}],usage:{inputTokens:2,outputTokens:114,cacheReadTokens:153532,cacheWriteTokens:472}},
];
async function openHerdr(page:Page,companion:boolean,rich=false) {
  await installBaseHost(page);
  await page.addInitScript(({companion,rich,richConversation})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture',attached:{kind:'herdr',name:'owned'}}]));
    const sessions=['claude-0','claude-1','claude-2','claude-3','claude-4','claude-5'];
    const panes=sessions.map((id,index)=>({workspace_id:`w${index}`,tab_id:`w${index}:t1`,pane_id:`w${index}:p1`,terminal_id:`term-${index}`,cwd:`/home/owner/dev/project-${index}`,focused:false,agent_status:index===1?'working':'idle'}));
    const tree={workspaces:panes.map((pane,index)=>({workspace_id:pane.workspace_id,label:`[${index+1}] project-${index}`,focused:false,agent_status:pane.agent_status})),
      tabs:panes.map((pane,index)=>({workspace_id:pane.workspace_id,tab_id:pane.tab_id,label:`tab ${index}`,number:1,focused:false,agent_status:pane.agent_status})),panes,
      agents:panes.map((pane,index)=>({terminal_id:pane.terminal_id,workspace_id:pane.workspace_id,tab_id:pane.tab_id,pane_id:pane.pane_id,name:null,agent:'claude',agent_status:pane.agent_status,
        agent_session:{source:'herdr:claude',agent:'claude',kind:'id',value:`0000000${index}-0000-4000-8000-000000000000`}}))};
    const reports=Array.from({length:50},(_,index)=>({sessionId:`ended-${index}`,agent:'Claude Code',project:`/home/owner/old-${index}`,state:'done',updatedAt:new Date().toISOString(),summary:'Session ended',paneId:null,eventCount:3}));
    (window as unknown as {herdrFixture:{conversations:unknown[];entered:unknown[]}}).herdrFixture={conversations:[],entered:[]};
    const record=(window as unknown as {herdrFixture:{conversations:unknown[];entered:unknown[]}}).herdrFixture;
    window.nativeFixtureInvoke=async(command,args)=>{
      const base=window.agentViewBase(command);if(base)return base.value;
      if(command==='attach_multiplexer')return {sessionId:'display-owned'};
      if(command==='multiplexer_sessions')return [{name:'owned'}];
      if(command==='herdr_tree')return tree;
      if(command==='herdr_action'){record.entered.push(args.action);return;}
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:reports};
      if(command==='agent_reported_history')return {schemaVersion:1,sessionId:String(args.agentSessionId),status:'missing'};
      if(command==='agent_herdr_conversation'){
        const target=args.target as {agentSessionId:string};record.conversations.push(target.agentSessionId);
        if(!companion)throw {kind:'herdr_conversation_companion_required',message:'Update the companion'};
        return {schemaVersion:1,agent:'claude',view:'active_branch',nextOffset:0,hasMore:false,messages:rich?richConversation:[
          {id:'p',role:'user',blocks:[{type:'text',text:'Explain the build'}]},{id:'t',role:'assistant',blocks:[{type:'tool_use',name:'Bash',text:'ls'}]},{id:'a',role:'assistant',blocks:[{type:'text',text:'The build uses Vite.'}]}]};
      }
      if(command==='multiplexer_tree')return {tmuxAvailable:false,herdrAvailable:true,zellijAvailable:false,tools:[{kind:'herdr',version:'0.9.3',support:'full',missing:[]}],sessions:[]};
      throw new Error(`Unexpected Agent view fixture command: ${command}`);
    };
  },{companion,rich,richConversation});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
}
const herdrFixture=(page:Page)=>page.evaluate(()=>(window as unknown as {herdrFixture:{conversations:unknown[];entered:unknown[]}}).herdrFixture);

test('stock Herdr: the Agent view lists the live agents, and selecting one opens its native chat',async({page})=>{
  await openHerdr(page,true);
  const agent=agentView(page);
  // The live rows are reachable on screen and the fifty ended hook reports are not listed.
  const row=agent.locator('article.agent-card').filter({hasText:'project-5'});
  await expect(agent.locator('article.agent-card')).toHaveCount(6);
  await expect(agent.getByRole('region',{name:'Last-reported agent sessions',exact:true})).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();await expect(row).toBeInViewport();
  await expect(row).toContainText('claude');await expect(row).toContainText('/home/owner/dev/project-5');await expect(row).toContainText('[6] project-5');
  await row.getByRole('button',{name:/Open conversation/}).click();
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await expect(agent.getByRole('region',{name:'Turn',exact:true})).toHaveCount(1);
  await expect(agent.locator('header')).toContainText('Claude Code · project-5');
  expect([...new Set((await herdrFixture(page)).conversations)]).toEqual(['00000005-0000-4000-8000-000000000000']);
  await agent.getByRole('button',{name:'Agent view options',exact:true}).click();
  await agent.getByRole('button',{name:'Enter session',exact:true}).click();
  await expect.poll(async()=>(await herdrFixture(page)).entered).toEqual([{type:'focusPane',target:'w5:p1'}]);
});

test('stock Herdr with an old companion: the Agent view says to update it and still enters the pane',async({page})=>{
  await openHerdr(page,false);
  const agent=agentView(page);
  await agent.locator('article.agent-card').filter({hasText:'project-0'}).getByRole('button',{name:/Open conversation/}).click();
  await expect(agent.getByRole('alert')).toContainText('too old to read agent conversations');
  await expect(agent.getByRole('alert')).toBeInViewport();
  await expect(agent.getByRole('button',{name:'Host companion installation',exact:true})).toBeVisible();
  await agent.getByRole('button',{name:'Agent view options',exact:true}).click();
  await agent.getByRole('button',{name:'Enter session',exact:true}).click();
  await expect.poll(async()=>(await herdrFixture(page)).entered).toEqual([{type:'focusPane',target:'w0:p1'}]);
});

test('a selected conversation keeps its chrome to one compact row and shows harness records as events, not raw tags',async({page},testInfo)=>{
  await openHerdr(page,true,true);
  const agent=agentView(page);
  await agent.locator('article.agent-card').filter({hasText:'project-0'}).getByRole('button',{name:/Open conversation/}).click();
  await expect(agent.getByText('v0.158.0 is published.',{exact:true})).toBeVisible();
  const flow=agent.getByRole('region',{name:'Conversation messages',exact:true});
  // Nothing but the one header row sits between the session header and the first message.
  const header=await agent.locator('header').boundingBox(),first=await flow.boundingBox(),shell=await page.locator('.workspace-header').boundingBox();
  expect(header!.height).toBeLessThanOrEqual(48);
  expect(first!.y).toBeLessThanOrEqual(header!.y+header!.height+1);
  // On a phone the session header is the only thing above that row.
  if(testInfo.project.name==='phone')expect(first!.y-(shell!.y+shell!.height)).toBeLessThanOrEqual(52);
  await expect(agent.getByRole('button',{name:'Back to sessions'})).toHaveCount(0);
  await expect(agent.getByRole('button',{name:'Enter session'})).toHaveCount(0);
  await expect(agent.getByText(/not verified as belonging|association with this pane is unverified/)).toHaveCount(0);
  // The injected notification is a muted event row; the person's bubble is only what they typed. Counters are not in the flow.
  await expect(flow).not.toContainText(/<task-notification|inputTokens|cacheReadTokens|<task-id>/);
  await expect(flow.getByRole('article',{name:'user',exact:true})).toHaveText(['Explain the build']);
  await expect(flow.getByText(/^Task notification/)).toHaveText('Task notification · version PR #624 checks green');
  // The caveat, Back and Enter and the counters stay one tap away.
  await agent.getByRole('button',{name:'Agent view options',exact:true}).click();
  const menu=agent.getByRole('group',{name:'Agent view options',exact:true});
  await expect(menu.getByRole('button',{name:'Back to sessions',exact:true})).toBeVisible();
  await expect(menu.getByRole('button',{name:'Enter session',exact:true})).toBeVisible();
  await expect(menu).toContainText('not verified as belonging to this terminal');
  await expect(menu).toContainText('Last response: 2 input, 114 output, 153,532 cache read, 472 cache write tokens');
  expect((await menu.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('the bound composer is one line with a visible Send control beside it and the conversation keeps the screen',async({page})=>{
  await open(page);
  const agent=await showAgent(page);
  const draft=agent.getByRole('textbox',{name:'Draft for this terminal',exact:true}),stage=agent.getByRole('button',{name:'Stage in terminal',exact:true});
  const [field,send,composer,flow]=await Promise.all([draft.boundingBox(),stage.boundingBox(),agent.getByRole('form',{name:'Transcript draft',exact:true}).boundingBox(),agent.getByRole('region',{name:'Conversation messages',exact:true}).boundingBox()]);
  expect(field!.height).toBeLessThanOrEqual(48);
  expect(send!.y).toBeLessThan(field!.y+field!.height);expect(send!.x).toBeGreaterThan(field!.x+field!.width-1);
  expect(composer!.height).toBeLessThanOrEqual(150);
  // The composer grows with its text and stays within the screen.
  await draft.fill('one\ntwo\nthree');
  expect((await draft.boundingBox())!.height).toBeGreaterThan(field!.height+20);
  expect(flow!.height).toBeGreaterThan(page.viewportSize()!.height*0.5);
});
