import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {tmuxChatBound,tmuxChatSnapshot} from '../src/test/tmuxChat';
import {preview} from './fixtures/recorded-images/browser';

type Fixture={uploads:string[];watchTargets:{inlineImages?:boolean}[];listed:string[];queued?:{text:string;timestamp?:string}[];turns:{prompt:string;answer:string}[];typed:string;stdin:string[];inputs:Record<string,unknown>[];attachments:number;state:string;summary?:string;session?:unknown;
  channels:Record<string,{onmessage:(event:unknown)=>void}>;polls:number;watchMode:'off'|'stream'|'old';watch?:{onmessage:(event:unknown)=>void};watchStops:number;
  emit:(frame:unknown)=>void;messages:()=>unknown[]};
declare global {interface Window {approvals:{id:string;decisions:unknown[]};agentView:Fixture;agentViewBase:(command:string)=>{value:unknown}|undefined}}
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
  await page.addInitScript(({snapshot,bound,transcript,image})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture',attached:{kind:'tmux',name:'work'}},{hostId:'fixture',attached:{kind:'tmux',name:'other'}}]));
    // A recorded image is attached to the first prompt; it only comes back when the view asked for previews.
    const messages=(images=false)=>fixture.turns.flatMap((turn,index)=>[
      {id:`p${index}`,role:'user',blocks:[{type:'text',text:turn.prompt},...(index===0&&images?[{type:'image',text:'Attachment: view in the host agent terminal',imagePreview:image}]:[])]},
      {id:`t${index}`,role:'assistant',blocks:[{type:'tool_use',name:'shell',text:'ls'}]},
      {id:`a${index}`,role:'assistant',blocks:[{type:'text',text:turn.answer}]},
    ]);
    const fixture:Fixture=window.agentView={turns:[{prompt:'Explain the build',answer:'The build uses Vite.'}],typed:'',stdin:[],inputs:[],attachments:0,state:'working',channels:{},listed:[],uploads:[],watchTargets:[],polls:0,watchMode:'off',watchStops:0,
      emit:frame=>fixture.watch?.onmessage({type:'frame',frame}),messages};
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
        if(action.input?.kind==='send' || action.input?.kind==='send_long')submit(action.input.text!);
        return {kind:'delivered',nextOperation:action.operation!+1};
      }
      if(command==='write_stdin'){
        const data=String(args.data);fixture.stdin.push(data);
        for(const key of data){if(key==='\r'){submit(fixture.typed);fixture.typed='';}else{fixture.typed+=key;echo(String(args.sessionId),key);}}
        return;
      }
      // The host stores each upload under /tmp by its file name.
      if(command==='upload_reserve')return {uploadId:'4d1c9ace-94cf-4588-8775-3888061a05bd'};
      if(command==='upload_cancel')return {outcome:'unknown_or_settled'};
      if(command==='upload_file'){fixture.uploads.push(String(args.path));return {path:`/tmp/lazysh-fixture/${String(args.path)}`};}
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[{sessionId:'codex-thread',agent:'Codex',project:'/work',state:fixture.state,updatedAt:new Date().toISOString(),summary:fixture.summary??'Working on your prompt',paneId:'%3',eventCount:4}]};
      if(command==='agent_reported_history')return {schemaVersion:1,sessionId:'codex-thread',status:'available',path:transcript,reportedAt:'2026-11-09T10:00:00Z',paneId:'%3'};
      if(command==='agent_transcript'){
        if(args.path!==transcript || args.agent!=='codex' || args.view!=='conversation')throw new Error('Unexpected transcript');
        fixture.polls++;
        return {schemaVersion:1,agent:'codex',view:'active_branch',nextOffset:0,hasMore:false,session:fixture.session,...(fixture.queued?.length?{queued:fixture.queued}:{}),messages:messages()};
        return {schemaVersion:1,agent:'codex',view:'active_branch',nextOffset:0,hasMore:false,messages:messages(args.inlineImages===true)};
      }
      // The synthetic host's `transcript-watch`: off (cannot open), an old companion, or a stream the test drives.
      if(command==='agent_watch_start'){
        if(fixture.watchMode==='off')throw new Error('The channel could not open');
        const events=args.events as {onmessage:(event:unknown)=>void};fixture.watch=events;
        const target=args.target as {inlineImages?:boolean};fixture.watchTargets.push(target);
        setTimeout(()=>{
          if(fixture.watchMode==='old')return events.onmessage({type:'unavailable',reason:'companion_required'});
          fixture.emit({type:'hello',protocol:1,agent:'codex'});
          fixture.emit({type:'snapshot',gen:1,seq:1,entries:messages(target.inlineImages===true).map(message=>({id:(message as {id:string}).id,rev:1,message}))});
        });
        return 'watch-1';
      }
      if(command==='agent_watch_stop'){fixture.watchStops++;return;}
      if(command==='list_directory'){
        fixture.listed.push(String(args.path));
        return args.path==='/work'?[{name:'src',isDir:true,size:0},{name:'README.md',isDir:false,size:12},{name:'.env',isDir:false,size:1}]:[{name:'app.ts',isDir:false,size:3}];
      }
      if(command==='multiplexer_tree')return {tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}],sessions:[]};
      throw new Error(`Unexpected Agent view fixture command: ${command}`);
    };
  },{snapshot:tmuxChatSnapshot,bound:tmuxChatBound,transcript,image:preview('regions.png')});
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
const fixture=(page:Page)=>page.evaluate(()=>({...window.agentView,channels:undefined,watch:undefined,emit:undefined,messages:undefined}));

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
  // The composer binds to the proven pane by itself; binding is not sending.
  expect(after.inputs.some(input=>input.kind==='input')).toBe(false);expect(after.inputs.some(input=>input.kind==='bind')).toBe(true);

  // A prompt sent from the Agent view reaches the terminal once and becomes a turn in the Agent view.
  await agent.getByRole('textbox',{name:'Draft for this terminal',exact:true}).fill('Add a test');
  await expect(agent.getByRole('button',{name:'Choose terminal destination',exact:true})).toHaveCount(0);
  await agent.getByRole('button',{name:'Send to the agent',exact:true}).click();
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

test('names what the agent waits for in the header and opens the Agent view from a needs-you notification',async({page})=>{
  await open(page);
  await page.evaluate(()=>{window.agentView.state='needs_attention';window.agentView.summary='AskUserQuestion';});
  // A needs-you notification tap lands on the Agent view of its session, not the terminal.
  await expect(switcher(page).getByRole('button',{name:'Terminal',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lazysh-inbox-open',{detail:{sessionId:'display-work',waiting:true}})));
  const agent=agentView(page);
  await expect(agent.locator('header')).toContainText('Waiting for your answer · ',{timeout:8000});
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(0);
  const bounds=await agent.boundingBox();const header=await agent.locator('header').boundingBox();
  expect(header!.x+header!.width).toBeLessThanOrEqual(bounds!.x+bounds!.width+1);
  // The session list of a terminal without an agent counts the waiting session and names what it waits for.
  await page.getByRole('tab',{name:'Fixture / other',exact:true}).click();
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  const list=agentView(page).getByRole('region',{name:'Last-reported agent sessions',exact:true});
  await expect(list.getByRole('status')).toHaveText('1 waiting for you');
  await expect(list.getByRole('button',{name:/Codex · \/work · Waiting for your answer · /})).toBeVisible();
  const row=await list.getByRole('button').first().boundingBox();expect(row!.x+row!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('answers a Claude permission request from the Agent view through the approval hook and writes no key to the terminal',async({page})=>{
  await open(page);
  // The same pane now runs Claude Code, which has one pending permission request.
  await page.evaluate(()=>{
    const base=window.nativeFixtureInvoke!;
    window.approvals={id:'11111111-1111-4111-8111-111111111111',decisions:[]};
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='agent_approvals')return {schemaVersion:1,requests:window.approvals.decisions.length?[]:[{id:window.approvals.id,expectedHash:'a'.repeat(64),agent:'claude',sessionId:'claude-thread',project:'/work',paneId:'%3',toolName:'Bash',toolInput:{command:'git push'},createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()}]};
      if(command==='resolve_agent_approval'){window.approvals.decisions.push(args);return {schemaVersion:1,accepted:true};}
      const result=await base(command,command==='agent_transcript'?{...args,agent:'codex'}:args);
      if(command==='agent_snapshot')return {...(result as {sessions:object[]}),sessions:(result as {sessions:object[]}).sessions.map(session=>({...session,agent:'Claude Code',sessionId:'claude-thread'}))};
      if(command==='agent_reported_history')return {...(result as object),sessionId:'claude-thread'};
      if(command==='agent_transcript')return {...(result as object),agent:'claude'};
      return result;
    };
  });
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  const dock=agentView(page).getByRole('region',{name:'Pending approvals',exact:true});
  await expect(dock).toContainText('git push',{timeout:8000});
  const deny=dock.getByRole('button',{name:'Deny request',exact:true});
  await expect(deny).toBeEnabled();
  const box=await deny.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(36);
  const before=await fixture(page);
  await deny.click();
  await expect(dock).toHaveCount(0);
  expect(await page.evaluate(()=>window.approvals.decisions)).toEqual([expect.objectContaining({id:'11111111-1111-4111-8111-111111111111',agentSessionId:'claude-thread',paneId:'%3',decision:'deny'})]);
  const after=await fixture(page);
  expect(after.stdin).toEqual(before.stdin);expect(after.inputs.some(input=>input.kind==='input')).toBe(false);
});

test('answers the open Claude question with the digit of the chosen option and the pane keeps showing the terminal',async({page})=>{
  await open(page);
  await page.evaluate(()=>{
    const base=window.nativeFixtureInvoke!;
    window.nativeFixtureInvoke=async(command,args)=>{
      const result=await base(command,command==='agent_transcript'?{...args,agent:'codex'}:args);
      if(command==='agent_snapshot')return {...(result as {sessions:object[]}),sessions:(result as {sessions:object[]}).sessions.map(session=>({...session,agent:'Claude Code',sessionId:'claude-thread',state:'needs_attention'}))};
      if(command==='agent_reported_history')return {...(result as object),sessionId:'claude-thread'};
      if(command==='agent_transcript')return {...(result as {messages:object[]}),agent:'claude',activity:'waiting',messages:[
        {id:'p',role:'user',blocks:[{type:'text',text:'Ask me a question'}]},
        {id:'a',role:'assistant',blocks:[{type:'tool_use',id:'q1',name:'AskUserQuestion',text:'{}',card:{kind:'question',questions:[{question:'Pick a color',header:'Color',multiple:false,options:[{label:'Red'},{label:'Blue'}]}]}}]}]};
      return result;
    };
  });
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  const agent=agentView(page);
  const card=agent.getByRole('region',{name:'Question',exact:true});
  await expect(card).toContainText('Pick a color',{timeout:8000});
  const blue=card.getByRole('button',{name:'Blue',exact:true});
  await expect(blue).toBeEnabled();
  expect((await blue.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  await blue.click();
  await expect(card.getByRole('status')).toContainText('Sent to the terminal');
  const fixture=await page.evaluate(()=>window.agentView.inputs);
  expect(fixture.filter(action=>action.kind==='input')).toEqual([expect.objectContaining({input:{kind:'select',option:2,of:2}})]);
  const box=await card.boundingBox();expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
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
  // A conversation nothing ties to this terminal keeps the explicit destination confirmation.
  await expect(other.getByRole('button',{name:'Choose terminal destination',exact:true})).toBeVisible();
  await expect(other.getByRole('button',{name:'Send to the agent',exact:true})).toHaveCount(0);
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

/** What a real Claude Code transcript holds around a harness event: usage counters, a background-task notification typed by the harness and tool activity. */
const richConversation=[
  {id:'p0',role:'user',blocks:[{type:'text',text:'Explain the build'}]},
  {id:'t0',role:'assistant',blocks:[{type:'tool_use',name:'Bash',text:'ls'}]},
  {id:'a0',role:'assistant',blocks:[{type:'text',text:'The build uses Vite.'}],usage:{inputTokens:2,outputTokens:51,cacheReadTokens:157518,cacheWriteTokens:1790}},
  {id:'n0',role:'user',blocks:[{type:'text',text:'<task-notification>\n<task-id>bl44ejerw</task-id>\n<summary>Monitor event: "Version PRs whose checks are green or failed"</summary>\n<event>version PR #624 checks green</event>\n</task-notification>'}]},
  {id:'t1',role:'assistant',blocks:[{type:'tool_use',name:'Bash',text:'gh pr list'},{type:'tool_use',name:'Monitor',text:'watch'}]},
  {id:'a1',role:'assistant',blocks:[{type:'text',text:'v0.158.0 is published.'}],usage:{inputTokens:2,outputTokens:114,cacheReadTokens:153532,cacheWriteTokens:472}},
];
/** Stock Herdr host: six live agents (one per workspace `w0`..`w5`), fifty ended hook reports without pane identity, and a companion that may predate conversation reading.
 * `focus` is the focused pane (`w2:p1`); the page can move it later through `herdrFixture.focus`. `agents` limits how many agents run. */
async function openHerdr(page:Page,companion:boolean,rich=false,start:{focus?:string;agents?:number;launch?:boolean}={}) {
  await installBaseHost(page);
  await page.addInitScript(({companion,rich,richConversation,start})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture',attached:{kind:'herdr',name:'owned'}}]));
    const sessions=['claude-0','claude-1','claude-2','claude-3','claude-4','claude-5'];
    const base=sessions.map((id,index)=>({workspace_id:`w${index}`,tab_id:`w${index}:t1`,pane_id:`w${index}:p1`,terminal_id:`term-${index}`,cwd:`/home/owner/dev/project-${index}`,agent_status:index===1?'working':'idle'}));
    // A shell pane without an agent sits in its own tab of workspace w0.
    const shell={workspace_id:'w0',tab_id:'w0:t2',pane_id:'w0:p2',terminal_id:'term-shell',cwd:'/home/owner/dev/project-0',agent_status:'idle'};
    const count=start.agents??6;
    const tree=()=>{
      const focus=(window as unknown as {herdrFixture:{focus:string}}).herdrFixture.focus;
      const panes=[...base,shell].map(pane=>({...pane,focused:pane.pane_id===focus}));
      return {workspaces:base.map((pane,index)=>({workspace_id:pane.workspace_id,label:`[${index+1}] project-${index}`,focused:pane.workspace_id===focus.split(':')[0],agent_status:pane.agent_status})),
        tabs:[...base,shell].map((pane,index)=>({workspace_id:pane.workspace_id,tab_id:pane.tab_id,label:`tab ${index}`,number:1,focused:pane.pane_id===focus,agent_status:pane.agent_status})),panes,
        agents:base.slice(0,count).map((pane,index)=>({terminal_id:pane.terminal_id,workspace_id:pane.workspace_id,tab_id:pane.tab_id,pane_id:pane.pane_id,name:null,agent:'claude',agent_status:pane.agent_status,
          agent_session:{source:'herdr:claude',agent:'claude',kind:'id',value:`0000000${index}-0000-4000-8000-000000000000`}}))};
    };
    const reports=Array.from({length:50},(_,index)=>({sessionId:`ended-${index}`,agent:'Claude Code',project:`/home/owner/old-${index}`,state:'done',updatedAt:new Date().toISOString(),summary:'Session ended',paneId:null,eventCount:3}));
    type Fixture={conversations:unknown[];entered:unknown[];focus:string;inputs:unknown[];inputError?:unknown};
    (window as unknown as {herdrFixture:Fixture}).herdrFixture={conversations:[],entered:[],focus:start.focus??'',inputs:[]};
    const record=(window as unknown as {herdrFixture:Fixture}).herdrFixture;
    window.nativeFixtureInvoke=async(command,args)=>{
      const base=window.agentViewBase(command);if(base)return base.value;
      if(command==='attach_multiplexer')return {sessionId:'display-owned'};
      if(command==='multiplexer_sessions')return [{name:'owned'}];
      if(command==='herdr_tree')return tree();
      if(command==='herdr_action'){record.entered.push(args.action);return;}
      // Stock Herdr has no guard: the status says so and every guarded call is refused. Only its own agent commands deliver input.
      if(command==='herdr_chat'){if((args.action as {kind:string}).kind==='status')return {kind:'status',available:false};throw {kind:'herdr_chat_unavailable',message:'no guard'};}
      if(command==='herdr_agent_input'){if(record.inputError)throw record.inputError;record.inputs.push({target:args.target,input:args.input});return;}
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:reports};
      if(command==='agent_reported_history')return {schemaVersion:1,sessionId:String(args.agentSessionId),status:'missing'};
      if(command==='agent_herdr_conversation'){
        const target=args.target as {agentSessionId:string};record.conversations.push(target.agentSessionId);
        if(!companion)throw {kind:'herdr_conversation_companion_required',message:'Update the companion'};
        return {schemaVersion:1,agent:'claude',view:'active_branch',nextOffset:0,hasMore:false,messages:rich?richConversation:[
          {id:'p',role:'user',blocks:[{type:'text',text:'Explain the build'}]},{id:'t',role:'assistant',blocks:[{type:'tool_use',name:'Bash',text:'ls'}]},{id:'a',role:'assistant',blocks:[{type:'text',text:'The build uses Vite.'}]}]};
      }
      if(command==='multiplexer_tree')return {tmuxAvailable:false,herdrAvailable:true,zellijAvailable:false,tools:[{kind:'herdr',version:'0.9.3',support:start.launch?'full':'navigationOnly',missing:[]}],sessions:[]};
      throw new Error(`Unexpected Agent view fixture command: ${command}`);
    };
  },{companion,rich,richConversation,start});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
}
const herdrFixture=(page:Page)=>page.evaluate(()=>(window as unknown as {herdrFixture:{conversations:unknown[];entered:unknown[];inputs:unknown[]}}).herdrFixture);
const focusPane=(page:Page,pane:string)=>page.evaluate(pane=>{(window as unknown as {herdrFixture:{focus:string}}).herdrFixture.focus=pane;},pane);

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

test('stock Herdr: the composer sends through Herdr\'s own agent input, and a refused send shows one notice that keeps the draft',async({page})=>{
  await openHerdr(page,true,false,{focus:'w2:p1'});
  const agent=agentView(page);
  const field=agent.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await expect(agent.getByRole('alert')).toHaveCount(0);
  await field.fill('Run the tests');
  await agent.getByRole('button',{name:'Send to the agent',exact:true}).click();
  await expect.poll(async()=>(await herdrFixture(page)).inputs).toEqual([{target:{herdrSession:'owned',pane:'w2:p1',terminal:'term-2',agent:'claude',agentSessionId:'00000002-0000-4000-8000-000000000000'},input:{kind:'send',text:'Run the tests'}}]);
  await expect(field).toHaveValue('');
  await expect(agent.getByRole('alert')).toHaveCount(0);
  // The agent waits for an approval: one notice, the draft is kept, and nothing else is shown under the composer.
  await page.evaluate(()=>{(window as unknown as {herdrFixture:{inputError:unknown}}).herdrFixture.inputError={kind:'herdr_chat_blocked',message:'blocked'};});
  await field.fill('Next step');
  await agent.getByRole('button',{name:'Send to the agent',exact:true}).click();
  const notice=agent.getByRole('alert');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('Message not sent');await expect(notice).toContainText('waiting for an answer or approval');
  await expect(notice.getByRole('button',{name:'Open terminal',exact:true})).toBeVisible();
  await expect(agent.getByText('Reconnect to the terminal')).toHaveCount(0);
  await expect(field).toHaveValue('Next step');
  const [box,viewport]=await Promise.all([notice.boundingBox(),page.viewportSize()]);
  expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(viewport!.width);expect(box!.height).toBeLessThan(220);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  await notice.getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect(agent.getByRole('alert')).toHaveCount(0);await expect(field).toHaveValue('Next step');
  expect((await herdrFixture(page)).inputs).toHaveLength(1);
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
  const draft=agent.getByRole('textbox',{name:'Draft for this terminal',exact:true}),stage=agent.getByRole('button',{name:'Send to the agent',exact:true});
  const [field,send,composer,flow]=await Promise.all([draft.boundingBox(),stage.boundingBox(),agent.getByRole('form',{name:'Transcript draft',exact:true}).boundingBox(),agent.getByRole('region',{name:'Conversation messages',exact:true}).boundingBox()]);
  expect(field!.height).toBeLessThanOrEqual(48);
  expect(send!.y).toBeLessThan(field!.y+field!.height);expect(send!.x).toBeGreaterThan(field!.x+field!.width-1);
  expect(composer!.height).toBeLessThanOrEqual(150);
  // The composer grows with its text and stays within the screen.
  await draft.fill('one\ntwo\nthree');
  expect((await draft.boundingBox())!.height).toBeGreaterThan(field!.height+20);
  expect(flow!.height).toBeGreaterThan(page.viewportSize()!.height*0.5);
});

/** Opens the Agent view with the synthetic host's `transcript-watch` in the given mode. */
async function openLive(page:Page,mode:Fixture['watchMode']) {
  await open(page);
  await page.evaluate(mode=>{window.agentView.watchMode=mode;},mode);
  return showAgent(page);
}
const flowOf=(agent:ReturnType<typeof agentView>)=>agent.getByRole('region',{name:'Conversation messages',exact:true});
const watchState=(agent:ReturnType<typeof agentView>)=>agent.locator('section.chat-panel');

test('live: a reply that grows in parts is patched in place over one channel, without polling, a reload or a scroll jump',async({page})=>{
  const agent=await openLive(page,'stream');
  await expect(watchState(agent)).toHaveAttribute('data-watch','live');
  const flow=flowOf(agent);
  // Enough earlier turns that the reader can be well above the tail.
  await page.evaluate(()=>{
    const fixture=window.agentView;
    for(let index=1;index<=12;index++)fixture.turns.push({prompt:`Earlier question ${index}`,answer:`Earlier answer ${index}`});
    fixture.emit({type:'snapshot',gen:2,seq:2,entries:fixture.messages().map(message=>({id:(message as {id:string}).id,rev:1,message}))});
  });
  await expect(flow.getByText('Earlier answer 12',{exact:true})).toBeVisible();
  const polls=(await fixture(page)).polls;
  await expect.poll(()=>flow.evaluate(node=>node.scrollHeight-node.clientHeight-node.scrollTop)).toBeLessThan(30);
  // Scroll up to an earlier answer and remember the element and the offset.
  const earlier=flow.getByText('Earlier answer 3',{exact:true});
  await earlier.scrollIntoViewIfNeeded();
  await earlier.evaluate(node=>{node.closest('article')!.setAttribute('data-original','');});
  await flow.evaluate(node=>{node.scrollTop-=40;node.dispatchEvent(new Event('scroll'));});
  await expect(agent.getByRole('button',{name:'Jump to latest',exact:true})).toBeVisible();
  const top=await flow.evaluate(node=>node.scrollTop);
  const at=await earlier.evaluate(node=>node.getBoundingClientRect().top);
  // The last answer arrives in three parts, and an earlier one is revised in place meanwhile.
  const last=`a${12}`;
  const parts=['The build','The build uses','The build uses Vite and a test run.'];
  for(const [index,text] of parts.entries()) {
    await page.evaluate(({text,index,last})=>{
      const fixture=window.agentView;fixture.turns[12].answer=text;
      fixture.emit({type:'delta',gen:2,seq:3+index,upserts:[{id:last,rev:2+index,message:{id:last,role:'assistant',blocks:[{type:'text',text}]}}],drops:[]});
    },{text,index,last});
    await expect(flow.getByText(text,{exact:true})).toBeVisible();
  }
  await page.evaluate(()=>window.agentView.emit({type:'delta',gen:2,seq:6,upserts:[{id:'a3',rev:2,message:{id:'a3',role:'assistant',blocks:[{type:'text',text:'Earlier answer 3, revised'}]}}],drops:[]}));
  await expect(flow.getByText('Earlier answer 3, revised',{exact:true})).toBeVisible();
  // Nothing was replaced and the reader did not move: same element, same offset, same scroll position.
  await expect(flow.locator('article[data-original]')).toHaveCount(1);
  expect(await flow.evaluate(node=>node.scrollTop)).toBe(top);
  expect(Math.abs((await flow.getByText('Earlier answer 3, revised',{exact:true}).evaluate(node=>node.getBoundingClientRect().top))-at)).toBeLessThan(2);
  await expect(agent.getByRole('button',{name:'Jump to latest',exact:true})).toBeVisible();
  // Jump to latest returns to the tail, where the new text is.
  await agent.getByRole('button',{name:'Jump to latest',exact:true}).click();
  await expect(flow.getByText(parts[2],{exact:true})).toBeInViewport();
  await page.waitForTimeout(3000);
  expect((await fixture(page)).polls).toBe(polls);
});

test('live: the stream follows the tail while the reader is there and shows the agent working',async({page})=>{
  const agent=await openLive(page,'stream');
  const flow=flowOf(agent);
  await expect(watchState(agent)).toHaveAttribute('data-watch','live');
  await page.evaluate(()=>{
    const fixture=window.agentView;
    for(let index=1;index<=12;index++)fixture.turns.push({prompt:`Question ${index}`,answer:`Answer ${index}`});
    fixture.emit({type:'snapshot',gen:2,seq:2,activity:'working',entries:fixture.messages().map(message=>({id:(message as {id:string}).id,rev:1,message}))});
  });
  await expect(agent.getByRole('status').filter({hasText:'Agent is working'})).toBeVisible();
  await expect(flow.getByText('Answer 12',{exact:true})).toBeInViewport();
  const elapsed=await page.evaluate(()=>new Promise<number>(resolve=>{
    const started=performance.now();
    new MutationObserver((_records,observer)=>{
      if(document.body.textContent?.includes('Fresh answer')){observer.disconnect();resolve(performance.now()-started);}
    }).observe(document.body,{childList:true,subtree:true,characterData:true});
    const fixture=window.agentView;fixture.turns.push({prompt:'Fresh question',answer:'Fresh answer'});
    fixture.emit({type:'delta',gen:2,seq:3,upserts:fixture.messages().slice(-3).map(message=>({id:(message as {id:string}).id,rev:1,message})),drops:[],activity:null});
  }));
  console.log(`stream frame to rendered card: ${elapsed.toFixed(0)} ms`);
  expect(elapsed).toBeLessThan(500);
  await expect(flow.getByText('Fresh answer',{exact:true})).toBeInViewport();
  await expect(agent.getByText('Agent is working',{exact:true})).toHaveCount(0);
});

test('delayed: without a watch channel the view polls every 2 seconds and says it can lag',async({page})=>{
  const agent=await openLive(page,'off');
  await expect(agent.getByText('Live updates are unavailable, so this view refreshes every 2 seconds and can lag.',{exact:true})).toBeVisible();
  await expect(watchState(agent)).toHaveAttribute('data-watch','delayed');
  const polls=(await fixture(page)).polls;
  await page.evaluate(()=>window.agentView.turns.push({prompt:'Typed in the terminal',answer:'Answered by polling'}));
  await expect(agent.getByText('Answered by polling',{exact:true})).toBeVisible({timeout:6000});
  expect((await fixture(page)).polls).toBeGreaterThan(polls);
});

test('an old host companion: the view says what to update, offers the installation and keeps polling',async({page})=>{
  const agent=await openLive(page,'old');
  await expect(agent.getByText(/Live updates need a newer host companion/)).toBeVisible();
  await expect(watchState(agent)).toHaveAttribute('data-watch','unsupported');
  await page.evaluate(()=>window.agentView.turns.push({prompt:'Typed in the terminal',answer:'Answered by polling'}));
  await expect(agent.getByText('Answered by polling',{exact:true})).toBeVisible({timeout:6000});
  await expect(agent.getByRole('button',{name:'Host companion installation',exact:true})).toBeVisible();
});

test('leaving the Agent view closes the channel and coming back opens a new one',async({page})=>{
  const agent=await openLive(page,'stream');
  await expect(watchState(agent)).toHaveAttribute('data-watch','live');
  await switcher(page).getByRole('button',{name:'Terminal',exact:true}).click();
  await expect.poll(async()=>(await fixture(page)).watchStops).toBe(1);
  await switcher(page).getByRole('button',{name:'Agent',exact:true}).click();
  await expect(watchState(agent)).toHaveAttribute('data-watch','live');
});

test('Herdr: the Agent view opens the focused pane\'s chat by itself and re-links when focus moves',async({page})=>{
  await openHerdr(page,true,false,{focus:'w2:p1'});
  const agent=agentView(page);
  // No list and no pick: the agent of the focused pane is the chat, named by its folder.
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toBeVisible();
  await expect(agent.locator('header')).toContainText('Claude Code · project-2');
  await expect(agent.locator('article.agent-card')).toHaveCount(0);
  expect([...new Set((await herdrFixture(page)).conversations)]).toEqual(['00000002-0000-4000-8000-000000000000']);
  // Focusing another workspace re-links within one poll; the old pane's chat does not stay.
  await focusPane(page,'w4:p1');
  await expect(agent.locator('header')).toContainText('Claude Code · project-4',{timeout:8000});
  expect([...new Set((await herdrFixture(page)).conversations)].at(-1)).toBe('00000004-0000-4000-8000-000000000000');
  // A pane without an agent while agents run: the live list, with the reason, never the previous chat.
  await focusPane(page,'w0:p2');
  await expect(agent.getByText('No agent runs in the focused pane. Choose a live agent.',{exact:true})).toBeVisible({timeout:8000});
  await expect(agent.locator('article.agent-card')).toHaveCount(6);
  await expect(agent.getByText('The build uses Vite.',{exact:true})).toHaveCount(0);
  // Picking one marks it as not this pane's; moving focus back to an agent pane drops the pick.
  await agent.locator('article.agent-card').filter({hasText:'project-5'}).getByRole('button',{name:/Open conversation/}).click();
  await expect(agent.locator('header')).toContainText('Not this pane');
  await focusPane(page,'w1:p1');
  await expect(agent.locator('header')).toContainText('Claude Code · project-1',{timeout:8000});
  await expect(agent.locator('header')).not.toContainText('Not this pane');
});

test('Herdr: with no agent running the Agent view offers to start one through the workspace launcher',async({page})=>{
  await openHerdr(page,true,false,{focus:'w0:p2',agents:0,launch:true});
  const agent=agentView(page);
  await expect(agent.getByText('No agent is running in this session.',{exact:true})).toBeVisible();
  await expect(agent.locator('article.agent-card')).toHaveCount(0);
  await expect(agent.getByRole('button',{name:'Start Claude Code',exact:true})).toBeVisible();
  await expect(agent.getByRole('button',{name:'Show terminal',exact:true})).toBeVisible();
  await agent.getByRole('button',{name:'Start an agent',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'New Herdr workspace'});
  await expect(dialog.getByRole('radio',{name:'Yes, start an agent'})).toBeChecked();
  await dialog.getByRole('button',{name:'Cancel'}).click();
  expect((await herdrFixture(page)).entered).toEqual([]);
});

test('Enter sends from a hardware keyboard and stays a line break on a touch keyboard; Stop reaches the terminal once',async({page},testInfo)=>{
  await open(page);
  const agent=await showAgent(page);
  const draft=agent.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  await expect(agent.getByRole('button',{name:'Request stop',exact:true})).toBeVisible();
  await draft.fill('First line');
  await draft.press('Shift+Enter');await draft.pressSequentially('second line');
  await expect(draft).toHaveValue('First line\nsecond line');
  await draft.press('Enter');
  if(testInfo.project.name==='phone') {
    await expect(draft).toHaveValue('First line\nsecond line\n');
    await agent.getByRole('button',{name:'Send to the agent',exact:true}).click();
  }
  await expect(agent.getByText('Answered: First line\nsecond line',{exact:false})).toBeVisible({timeout:6000});
  await expect(draft).toHaveValue('');
  const sent=(await fixture(page)).inputs.filter(input=>(input as {input?:{kind:string}}).input?.kind==='send');
  expect(sent).toHaveLength(1);
  await agent.getByRole('button',{name:'Request stop',exact:true}).click();
  expect((await fixture(page)).inputs.filter(input=>(input as {input?:{kind:string}}).input?.kind==='request_stop')).toHaveLength(0);
  await agent.getByRole('button',{name:'Tap again to stop the agent',exact:true}).click();
  await expect.poll(async()=>(await fixture(page)).inputs.filter(input=>(input as {input?:{kind:string}}).input?.kind==='request_stop').length).toBe(1);
});

test('a message queued while the agent works shows as a card between the turns and the composer, and goes once taken',async({page})=>{
  await open(page);
  const agent=await showAgent(page);
  await page.evaluate(()=>{window.agentView.queued=[{text:'then run the tests'},{text:'and update the docs'}];});
  const cards=agent.getByRole('region',{name:'Queued messages',exact:true});
  await expect(cards).toBeVisible({timeout:6000});
  await expect(cards.getByRole('article')).toHaveText([/Queued.*then run the tests/s,/Queued.*and update the docs/s]);
  const [box,composer]=await Promise.all([cards.boundingBox(),agent.getByRole('form',{name:'Transcript draft',exact:true}).boundingBox()]);
  expect(box!.y+box!.height).toBeLessThanOrEqual(composer!.y+1);expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.evaluate(()=>{window.agentView.queued=[];});
  await expect(cards).toHaveCount(0,{timeout:6000});
});

test('live: a queued message arrives and leaves on stream frames without a poll',async({page})=>{
  const agent=await openLive(page,'stream');
  await expect(watchState(agent)).toHaveAttribute('data-watch','live');
  const polls=(await fixture(page)).polls;
  await page.evaluate(()=>window.agentView.emit({type:'delta',gen:1,seq:2,upserts:[],drops:[],queued:[{text:'next, please'}]}));
  const cards=agent.getByRole('region',{name:'Queued messages',exact:true});
  await expect(cards.getByRole('article')).toHaveText([/Queued.*next, please/s]);
  await page.evaluate(()=>window.agentView.emit({type:'delta',gen:1,seq:3,upserts:[],drops:[],queued:[]}));
  await expect(cards).toHaveCount(0);
  expect((await fixture(page)).polls).toBe(polls);
});

test('the slash palette filters and inserts a command, history recalls the last prompt, and a leading ! shows its mode',async({page})=>{
  await open(page);
  const agent=await showAgent(page);
  const draft=agent.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  await draft.fill('/com');
  const palette=agent.getByRole('listbox',{name:'Slash commands',exact:true});
  await expect(palette.getByRole('option')).toHaveCount(1);
  const [list,field]=await Promise.all([palette.boundingBox(),draft.boundingBox()]);
  expect(list!.y+list!.height).toBeLessThanOrEqual(field!.y+1);
  expect(list!.x).toBeGreaterThanOrEqual(0);expect(list!.x+list!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await palette.getByRole('button',{name:/\/compact/}).click();
  await expect(draft).toHaveValue('/compact ');
  await expect(palette).toHaveCount(0);
  await draft.fill('!echo hi');
  await expect(agent.getByText('Shell command',{exact:true})).toBeVisible();
  await agent.getByRole('button',{name:'Send to the agent',exact:true}).click();
  await expect(draft).toHaveValue('');
  await expect(agent.getByText('Answered: !echo hi',{exact:true})).toBeVisible({timeout:6000});
  // Up in an empty composer brings back what was just sent, byte for byte.
  await draft.press('ArrowUp');
  await expect(draft).toHaveValue('!echo hi');
  const sent=(await fixture(page)).inputs.filter(input=>(input as {input?:{kind:string}}).input?.kind==='send');
  expect(sent.map(input=>(input as {input:{text:string}}).input.text)).toEqual(['!echo hi']);
});

test('an @ mention lists the agent folder, completes a file and a folder, and refuses a path outside the folder',async({page})=>{
  await open(page);
  const agent=await showAgent(page);
  const draft=agent.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  await draft.fill('read @');
  const list=agent.getByRole('listbox',{name:'Files and folders',exact:true});
  await expect(list.getByRole('option')).toHaveText(['src/','README.md']);
  const [box,field]=await Promise.all([list.boundingBox(),draft.boundingBox()]);
  expect(box!.y+box!.height).toBeLessThanOrEqual(field!.y+1);expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await list.getByRole('button',{name:'src/'}).click();
  await expect(draft).toHaveValue('read @src/');
  await expect(list.getByRole('option')).toHaveText(['app.ts']);
  await list.getByRole('button',{name:'app.ts'}).click();
  await expect(draft).toHaveValue('read @src/app.ts ');
  await expect.poll(async()=>(await page.evaluate(()=>window.agentView.listed))).toEqual(['/work','/work/src']);
  await draft.fill('read @../');
  await expect(list).toHaveCount(0);
  await draft.fill('read @/etc/');
  await page.waitForTimeout(400);
  expect(await page.evaluate(()=>window.agentView.listed)).toEqual(['/work','/work/src']);
  await agent.getByRole('button',{name:'Send to the agent',exact:true}).click();
  await expect(draft).toHaveValue('');
  const sent=(await page.evaluate(()=>window.agentView.inputs)).filter(input=>(input as {input?:{kind:string}}).input?.kind==='send');
  expect(sent.map(input=>(input as {input:{text:string}}).input.text)).toEqual(['read @/etc/']);
});

test('an attached image opens from the user bubble without moving the scroll position, once the preview switch is on, also over the live stream',async({page})=>{
  const agent=await openLive(page,'stream');
  await expect(watchState(agent)).toHaveAttribute('data-watch','live');
  expect((await fixture(page)).watchTargets.at(-1)?.inlineImages).toBeUndefined();
  const flow=agent.getByRole('region',{name:'Conversation messages',exact:true});
  // Codex previews are opt-in: nothing is requested and no control shows until the switch is on.
  await expect(agent.getByRole('button',{name:/· View$/})).toHaveCount(0);
  await agent.getByRole('button',{name:'Agent view options',exact:true}).click();
  await agent.getByRole('checkbox',{name:'Show image previews',exact:true}).check();
  await page.keyboard.press('Escape');
  const image=agent.getByRole('button',{name:'Image 32 × 16 · View',exact:true});
  await expect(image).toBeVisible();
  // The stream itself carries the previews: the channel was reopened asking for them.
  await expect(watchState(agent)).toHaveAttribute('data-watch','live');
  expect((await fixture(page)).watchTargets.at(-1)?.inlineImages).toBe(true);
  await flow.evaluate(node=>{node.scrollTop=0;});
  await image.click();
  const viewer=agent.getByRole('region',{name:'Recorded image preview',exact:true});
  await expect(viewer.getByRole('img',{name:'Recorded image preview'})).toBeVisible();
  await viewer.getByRole('button',{name:'Close image preview',exact:true}).click();
  await expect(viewer).toHaveCount(0);
  expect(await flow.evaluate(node=>node.scrollTop)).toBe(0);
});

// One decodable pixel; the host only needs real PNG bytes to accept it as an image.
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('a pasted or picked file becomes a token chip that survives edits and reaches the agent as the uploaded path, once',async({page})=>{
  await open(page);
  const agent=await showAgent(page);
  const draft=agent.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  await draft.fill('compare');
  // Paste from the clipboard, as a desktop browser delivers a copied screenshot.
  await draft.evaluate((element,data)=>{
    const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],'before.png',{type:'image/png'}));
    element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  },pixel);
  await expect(draft).toHaveValue('compare [Image #1] ');
  // Pick through the paperclip, the only way on a phone.
  await agent.getByRole('button',{name:'Add attachment',exact:true}).click();
  await page.getByLabel('Choose attachment',{exact:true}).setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('notes')});
  await page.getByRole('button',{name:'Upload attachment',exact:true}).click();
  await page.getByRole('button',{name:'Add uploaded path to Chat draft',exact:true}).click();
  await expect(draft).toHaveValue('compare [Image #1] [File #2] ');
  const chips=agent.getByRole('list',{name:'Draft attachments',exact:true});
  await expect(chips.getByRole('listitem')).toHaveText(['[Image #1] before.png','[File #2] notes.txt']);
  const [box,field]=await Promise.all([chips.boundingBox(),draft.boundingBox()]);
  expect(box!.y+box!.height).toBeLessThanOrEqual(field!.y+1);expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // Backspace right after a token takes the whole token and its chip.
  await draft.evaluate((element:HTMLTextAreaElement)=>{const end=element.value.indexOf('[File #2]')+'[File #2]'.length;element.focus();element.setSelectionRange(end,end);});
  await draft.press('Backspace');
  await expect(draft).toHaveValue('compare [Image #1]  ');
  await expect(chips.getByRole('listitem')).toHaveText(['[Image #1] before.png']);
  await agent.getByRole('button',{name:'Send to the agent',exact:true}).click();
  await expect(draft).toHaveValue('');
  await expect(chips).toHaveCount(0);
  const sent=(await fixture(page)).inputs.filter(input=>(input as {input?:{kind:string}}).input?.kind==='send');
  expect(sent.map(input=>(input as {input:{text:string}}).input.text)).toEqual(["compare '/tmp/lazysh-fixture/before.png'  "]);
  expect((await fixture(page)).uploads).toEqual(['before.png','notes.txt']);
});

test('a prompt over 4 KiB is sent whole as one long send, and one past the bound is refused with its limit',async({page})=>{
  await open(page);
  const agent=await showAgent(page);
  const draft=agent.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  const long=Array.from({length:600},(_,line)=>`line ${line} of a long brief`).join('\n');
  await draft.fill(long);
  await agent.getByRole('button',{name:'Send to the agent',exact:true}).click();
  await expect(draft).toHaveValue('');
  const sent=(await fixture(page)).inputs.filter(input=>['send','send_long'].includes((input as {input?:{kind:string}}).input?.kind ?? ''));
  expect(sent.map(input=>(input as {input:{kind:string;text:string}}).input)).toEqual([{kind:'send_long',text:long}]);
  await draft.fill('é'.repeat(32769));
  await expect(agent.getByText('Too long for confirmed input (65,536 bytes). Shorten it or use Stage in terminal.',{exact:true})).toBeVisible();
  await expect(agent.getByRole('button',{name:'Send to the agent',exact:true})).toBeDisabled();
});

test('shows model, plan mode and context left in one header row without taking chat space',async({page})=>{
  await open(page);
  await page.evaluate(()=>{window.agentView.session={model:'gpt-6.1-terra',mode:'plan',effort:'medium',approval:'never',folder:'app',branch:'fix/login',worktree:'fix-login',usage:{usedTokens:380000,limitTokens:475000}};});
  const agent=await showAgent(page);
  const header=agent.locator('header');
  await expect(header.getByText('Plan mode',{exact:true})).toBeVisible();
  await expect(header.getByText('20% left',{exact:true})).toBeVisible();
  // One row of the existing height; the buttons stay reachable at the end of it.
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(44);
  await expect(header.getByRole('button',{name:'Agent view options',exact:true})).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await header.getByRole('button',{name:'Agent view options',exact:true}).click();
  await expect(agent.getByRole('group',{name:'Agent view options',exact:true}).getByText('gpt-6.1-terra · medium',{exact:true})).toBeVisible();
  const sheet=agent.getByRole('group',{name:'Agent view options',exact:true});
  await expect(sheet.getByText('fix/login',{exact:true})).toBeVisible();
  await expect(sheet.getByText('app',{exact:true})).toBeVisible();
  // Wide panes also draw the branch in the header; a narrow phone leaves it to the sheet so the row does not grow.
  await expect(header.getByTitle('Git branch')).toBeVisible({visible:(page.viewportSize()?.width??0)>=520});
});
