import {expect,it} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeGui} from './fixture';
import {IME_COMMIT,IME_PINYIN,IME_TEXT} from './inputMethod';
import {SshFixture} from '../../../tests/support/sshFixture';
import {herdrTools} from '../../../tests/support/androidHerdr';
import {openOwnedSsh,challengeOwnedSsh,disconnectOwnedSsh,ownedSshGui,startOwnedReceiver,workspaceAction} from './sshUi';

const fixture=ownedSshGui();
type Browser=NonNullable<NativeGui['browser']>;
type Trace=({type:string;data:string;trusted:boolean})[];
const TRACE='__ownedImeInput';

/** Record the page's text input events, with whether the engine or a script made each one. */
const traceInput=(browser:Browser)=>browser.execute((key:string)=>{
  const events:Trace=[];
  for(const type of ['compositionstart','compositionupdate','compositionend','input'])
    document.addEventListener(type,event=>{events.push({type,data:(event as CompositionEvent).data,trusted:event.isTrusted});},true);
  Object.defineProperty(window,key,{value:events,configurable:true});
},TRACE);
const observed=(browser:Browser)=>browser.execute((key:string)=>(window as unknown as Record<string,Trace>)[key],TRACE);

/**
 * Type Pinyin and then the commit key as real X events through the owned IBus engine. `target` is the editable that
 * gets page focus. The Tauri webview turns preedit off, so the page sees only the committed text: the IME's own
 * candidates are never DOM state, and the commit is observed as the page's trusted input events.
 */
async function composePinyin(gui:NativeGui,browser:Browser,target:()=>Promise<unknown>) {
  const ime=gui.inputMethodSession;
  gui.stage='owned IME focus';
  // IBus serves only a focused client, and with no window manager the X server must be told which window it is.
  await ime.focusWindow('lazysh');
  await target();
  await traceInput(browser);
  expect(await browser.execute(()=>document.hasFocus())).toBe(true);
  gui.stage='owned IME Pinyin composition';
  await ime.withPinyin(async()=>{
    await ime.press(IME_PINYIN);
    // The engine only holds the Pinyin until the commit key, so there is no page state to wait for between the two.
    await delay(500);
    await ime.press(IME_COMMIT);
    await browser.waitUntil(async()=>(await observed(browser)).some(event=>event.data===IME_TEXT),
      {timeout:15_000,timeoutMsg:'IBus did not commit the expected Pinyin candidate'}).catch(async primary=>{
      console.info('Owned IME observation',await ime.diagnostic(),JSON.stringify(await observed(browser).catch(()=>'unavailable')));
      throw primary;
    });
  });
  // Every event came from the input method, none from a script, and the text arrived once.
  const events=await observed(browser);
  expect(events.every(event=>event.trusted)).toBe(true);
  expect(events.filter(event=>event.type==='input'&&event.data===IME_TEXT)).toHaveLength(1);
}

it('commits Pinyin composed through a real IBus in the WebKitGTK terminal and its owned SSH receiver gets the bytes once',async()=>{
  fixture.captureSafe=false;
  const tools=herdrTools(),ssh=fixture.ssh=await SshFixture.start(tools);
  const gui=fixture.gui=await NativeGui.startWithInputMethod();
  const {browser,terminal,owner}=await openOwnedSsh(gui,ssh);
  await challengeOwnedSsh(gui,ssh,terminal,owner);
  const {bytes}=await startOwnedReceiver(gui,ssh,terminal,tools.receiverBinary,'IME');
  fixture.captureSafe=true;
  await composePinyin(gui,browser,()=>terminal.click());
  const committed=Buffer.from(IME_TEXT);
  await browser.waitUntil(async()=>(await bytes()).equals(committed),{timeout:10_000,timeoutMsg:'Committed Pinyin did not reach the owned SSH receiver'});
  // A duplicate or a late edit would arrive after the first copy.
  await delay(2000);
  expect(await bytes()).toEqual(committed);
  expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);
  await disconnectOwnedSsh(gui,terminal);
},180_000);

it('commits Pinyin composed through a real IBus into the Chat composer draft',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true});
  const gui=fixture.gui=await NativeGui.startWithInputMethod();
  const {browser,terminal,owner}=await openOwnedSsh(gui,ssh);
  await challengeOwnedSsh(gui,ssh,terminal,owner);
  fixture.captureSafe=true;
  gui.stage='owned IME Chat composer';
  await workspaceAction(gui,'Transcript');
  const draft=await browser.$('form.chat-composer textarea');await draft.waitForDisplayed();
  await composePinyin(gui,browser,()=>draft.click());
  await browser.waitUntil(async()=>(await draft.getValue())===IME_TEXT,{timeout:5000,timeoutMsg:'Chat composer draft was not the committed Pinyin'});
  await delay(1000);
  expect(await draft.getValue()).toBe(IME_TEXT);
  expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);
  await workspaceAction(gui,'Terminal');await terminal.waitForDisplayed();
  await disconnectOwnedSsh(gui,terminal);
},180_000);
