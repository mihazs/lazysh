import {expect,type Page} from '@playwright/test';
import {installNativeBridge} from './nativeBridge';
import {tmuxChatSnapshot} from '../../src/test/tmuxChat';

type Point={x:number;y:number};
/** One connected tmux session on a synthetic host with no agent in its pane, so the Agent view shows its empty state. */
const answers:Record<string,unknown>={
  list_hosts:[{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22}],
  local_capability:{available:false,reason:'Synthetic swipe fixture.'},
  transport_capabilities:{mosh:false,et:false},
  apple_status_capability:{available:false,reason:'Synthetic fixture.'},
  has_credentials:false,
  connect:{sessionId:'ssh-1'},
  attach_tmux:{sessionId:'display-work'},
  agent_snapshot:{schemaVersion:1,sessions:[]},
  multiplexer_tree:{tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}],sessions:[]},
};

/** What the Agent view shows when a Codex conversation is tied to the pane: one prompt and an answer with a code block. */
const conversation={
  agent_snapshot:{schemaVersion:1,sessions:[{sessionId:'codex-thread',agent:'Codex',project:'/work',state:'working',updatedAt:new Date().toISOString(),summary:'Working',paneId:'%3',eventCount:4}]},
  agent_reported_history_reference:{schemaVersion:1,sessionId:'codex-thread',status:'available',reference:'4e0da3cb-f6d1-468c-89fb-52d2602bd310',reportedAt:'2026-11-09T10:00:00Z',paneId:'%3'},
  agent_reported_conversation:{schemaVersion:1,agent:'codex',view:'active_branch',nextOffset:0,hasMore:false,messages:[
    {id:'p0',role:'user',blocks:[{type:'text',text:'Explain the build'}]},
    {id:'a0',role:'assistant',blocks:[{type:'text',text:'The build uses Vite.\n\n```sh\nbun run build --mode production --sourcemap --minify terser --outDir dist/release --base /\n```'}]},
  ]},
};
export const conversationText='The build uses Vite.';

/** Opens the restored `work` session and waits for its terminal. */
export async function openSwipeWorkspace(page:Page,tied=false) {
  await installNativeBridge(page);
  await page.addInitScript(({answers,snapshot})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture',attached:{kind:'tmux',name:'work'}}]));
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='attach_tmux'){
        const events=args.events as {onmessage:(event:unknown)=>void};
        setTimeout(()=>events.onmessage({type:'data',data:[...new TextEncoder().encode('work scrollback\r\n$ ')]}));
      }
      if(command==='tmux_chat')return (args.action as {kind:string}).kind==='snapshot'?snapshot:{kind:'released'};
      if(command in answers)return answers[command];
      if(command.startsWith('plugin:event|') || ['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
      throw new Error(`Unexpected swipe fixture command: ${command}`);
    };
  },{answers:tied?{...answers,...conversation}:answers,snapshot:tmuxChatSnapshot});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('work scrollback');
}

/** Real browser touch input; the desktop project emulates a touch screen so the same sequences run there. */
export async function touchscreen(page:Page,emulate:boolean) {
  const cdp=await page.context().newCDPSession(page);
  if(emulate)await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const send=(type:'touchStart'|'touchMove'|'touchEnd'|'touchCancel',points:Point[])=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});
  const along=(from:Point,to:Point,fraction:number)=>({x:from.x+(to.x-from.x)*fraction,y:from.y+(to.y-from.y)*fraction});
  return {
    cdp,
    /** Presses at `from` and moves a `fraction` of the way to `to`, leaving the finger down. */
    async hold(from:Point,to:Point,fraction=1,pace=0) {
      await send('touchStart',[from]);
      for(let step=1;step<=8;step++){await send('touchMove',[along(from,to,fraction*step/8)]);if(pace)await page.waitForTimeout(pace);}
    },
    lift:()=>send('touchEnd',[]),
    interrupt:()=>send('touchCancel',[]),
    async swipe(from:Point,to:Point) {await this.hold(from,to);await this.lift();},
  };
}
export type Touchscreen=Awaited<ReturnType<typeof touchscreen>>;
