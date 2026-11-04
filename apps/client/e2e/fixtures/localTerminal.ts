import {expect,type Page} from '@playwright/test';

declare global {interface Window {simpleShortcutCopies:string[];simpleShortcutWrites:string[];simpleShortcutSteps:string[][];simpleShortcutResizes:{cols:number;rows:number}[];simpleShortcutTouchMoves:number;simpleShortcutPointerMoves:number;simpleShortcutTouchTarget:Element|null;simpleShortcutOutput:(text:string)=>void;simpleShortcutOpened:string[];simpleShortcutInput?:(data:string)=>void;simpleShortcutWriteFailure?:'backpressure'|'input_closed'}}

/** One synthetic local terminal: output is injected, input and opened links are recorded. No shell runs. */
export async function installLocalTerminal(page:Page) {
  await page.addInitScript(()=>{
    window.simpleShortcutWrites=[];window.simpleShortcutSteps=[];window.simpleShortcutResizes=[];window.simpleShortcutOpened=[];
    Object.defineProperty(window,'isTauri',{value:true});
    Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:Record<string,unknown>={})=>{
      if (command==='desktop_launch_read') return {directoryReceipt:null,hostReceipt:null,notice:null};
      if (command==='ui_locale_status') return {nativeAuthority:false};
      if (command==='app_lock_status') return {initialized:true,supported:false,reason:'Synthetic shortcut access fixture.',enabled:false,locked:false,generation:'0'};
      if (command==='app_lock_ready' || command==='adopt_session') return;
      if (command==='list_hosts') return [];
      if (command==='clipboard_is_android') return false;
      if (command==='open_web_url') {window.simpleShortcutOpened.push(args.url as string);return;}
      if (command === 'app_icon_status') return {available: false, current: 'unknown', reason: 'Alternate Home Screen icons require iOS; synthetic fixture.'};
      if (command==='local_capability') return {available:true,reason:'Synthetic shortcut fixture; no shell runs.'};
      if (command==='local_connect') {
        window.simpleShortcutOutput=text=>(args.events as {onmessage:(event:unknown)=>void}).onmessage({type:'data',data:Array.from(new TextEncoder().encode(text))});
        return {sessionId:'local:shortcut-fixture'};
      }
      if (command==='local_write') {
        const steps=args.steps as string[]|undefined;
        if(steps)window.simpleShortcutSteps.push(steps);
        window.simpleShortcutWrites.push(steps?steps.join(''):args.data as string);
        window.simpleShortcutInput?.(window.simpleShortcutWrites.at(-1)!);
        if(window.simpleShortcutWriteFailure)throw {kind:window.simpleShortcutWriteFailure,message:'Owned queue failure'};
        return;
      }
      if (command==='local_resize'){window.simpleShortcutResizes.push({cols:args.cols as number,rows:args.rows as number});return;}
      if (['local_ack','local_disconnect'].includes(command))return;
      if (command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected shortcut fixture command: ${command}`);
    }}});
  });
}

/** Opens that terminal with the browser's real clipboard, seeded with `BEFORE`. */
export async function openClipboardTerminal(page:Page) {
  await installLocalTerminal(page);
  await page.goto('/');
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(page.url()).origin});
  await page.evaluate(()=>navigator.clipboard.writeText('BEFORE'));
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>typeof window.simpleShortcutOutput)).toBe('function');
}
