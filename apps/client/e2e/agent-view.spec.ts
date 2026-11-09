import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {tmuxChatBound,tmuxChatSnapshot} from '../src/test/tmuxChat';

type Fixture={turns:{prompt:string;answer:string}[];typed:string;stdin:string[];inputs:Record<string,unknown>[];attachments:number;state:string;
  channels:Record<string,{onmessage:(event:unknown)=>void}>};
declare global {interface Window {agentView:Fixture}}
const transcript='/home/owner/.codex/sessions/rollout 世界.jsonl';

/** Two restored tmux terminals; hook reports tie a running Codex conversation to pane %3 of `work` only. */
async function open(page:Page) {
  await installNativeBridge(page);
  await page.addInitScript(({snapshot,bound,transcript})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture',attached:{kind:'tmux',name:'work'}},{hostId:'fixture',attached:{kind:'tmux',name:'other'}}]));
    const fixture:Fixture=window.agentView={turns:[{prompt:'Explain the build',answer:'The build uses Vite.'}],typed:'',stdin:[],inputs:[],attachments:0,state:'working',channels:{}};
    const encoder=new TextEncoder();
    const echo=(session:string,text:string)=>fixture.channels[session]?.onmessage({type:'data',data:[...encoder.encode(text)]});
    // The synthetic agent answers each submitted prompt; the terminal echoes it once, as a TUI would.
    const submit=(text:string)=>{echo('display-work',`\r\n> ${text}\r\n`);fixture.turns.push({prompt:text,answer:`Answered: ${text}`});};
    let connections=0;
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic Agent view fixture.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:`ssh-${++connections}`};
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
      if(command==='multiplexer_tree')return {tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Synthetic fixture.'};
      if(command.startsWith('plugin:event|') || ['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
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
  await other.getByRole('button',{name:'Choose transcript',exact:true}).click();
  await expect(other.getByLabel('Transcript path',{exact:true})).toBeVisible();
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
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  const agent=agentView(page);
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await expect(agent.getByRole('checkbox')).toHaveCount(0);
  await expect(agent.getByRole('heading',{name:'user',exact:true})).toHaveCount(0);
  expect((await agent.getByRole('region',{name:'Conversation messages',exact:true}).boundingBox())!.height).toBeGreaterThan(844/2);
});
