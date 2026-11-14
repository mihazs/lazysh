import {expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {openOwnedSsh,ownedSshGui,typeText} from './sshUi';

const fixture=ownedSshGui();
type Browser=NonNullable<NativeGui['browser']>;
type Terminal=Awaited<ReturnType<Browser['$']>>;
const nonce=()=>randomBytes(6).toString('hex');
const region=(name:string)=>`[role="region"][aria-label="${name}"]`;

async function ownedTerminal() {
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true});
  const gui=fixture.gui=await NativeGui.start();
  const {browser,terminal}=await openOwnedSsh(gui,ssh);
  fixture.captureSafe=true;
  return {gui,browser,terminal};
}
/** Types a command into the real remote shell. */
async function run(browser:Browser,terminal:Terminal,command:string) {
  await terminal.click();
  await typeText(browser,`${command}\n`);
}
/** Viewport point of the middle of `text` inside the terminal row whose whole text is `row`, or null while that row is not drawn. */
function pointOn(browser:Browser,terminal:Terminal,row:string,text:string) {
  return browser.execute((screen:HTMLElement,row:string,text:string)=>{
    const line=Array.from(screen.querySelectorAll('.xterm-rows > div')).find(item=>item.textContent?.trim()===row);
    if(!line)return null;
    let offset=(line.textContent??'').indexOf(text)+Math.floor(text.length/2);
    const nodes=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
    for(let node=nodes.nextNode();node;node=nodes.nextNode()) {
      const length=node.textContent!.length;
      if(offset<length) {
        const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+1);
        const box=range.getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
      }
      offset-=length;
    }
    return null;
  },terminal as unknown as HTMLElement,row,text);
}

it('an OSC 52 request from the remote shell writes the real X clipboard only after Allow',async()=>{
  const {gui,browser,terminal}=await ownedTerminal();
  const before=`BEFORE_${nonce()}`,text=`OSC52_${nonce()}`;
  await gui.seedClipboard(before);
  gui.stage='owned OSC 52 consent';
  await run(browser,terminal,`printf '\\033]52;c;%s\\007' "$(printf %s ${text} | base64)"`);
  const prompt=await browser.$(region('Remote clipboard request'));
  await prompt.waitForDisplayed({timeout:20_000});
  expect(await prompt.getText()).toContain(text);
  expect(await gui.readClipboard()).toBe(before);
  await (await prompt.$('button=Allow this copy')).click();
  await browser.waitUntil(async()=>await gui.readClipboard()===text,{timeout:10_000,timeoutMsg:'Allow did not reach the X clipboard'});
});

it('Open in browser hands a terminal link to the desktop URL opener',async()=>{
  const {gui,browser,terminal}=await ownedTerminal();
  const opened=await gui.stubUrlOpener();
  const url=`https://example.invalid/lazysh/${nonce()}?q=1`,row=`see ${url} here`;
  await run(browser,terminal,`printf 'see %s here\\n' ${url}`);
  gui.stage='owned terminal link';
  const prompt=await browser.$(region('Terminal link'));
  await browser.waitUntil(async()=>{
    const at=await pointOn(browser,terminal,row,url);
    if(!at)return false;
    await browser.action('pointer').move({x:at.x,y:at.y}).move({x:at.x+1,y:at.y}).down().up().perform();
    return prompt.isDisplayed();
  },{timeout:20_000,timeoutMsg:'Terminal link prompt was not shown'});
  expect(await prompt.getText()).toContain(url);
  expect(await opened()).toEqual([]);
  await (await prompt.$('button=Open in browser')).click();
  await browser.waitUntil(async()=>(await opened()).length>0,{timeout:10_000,timeoutMsg:'The desktop URL opener was not run'});
  expect(await opened()).toEqual([url]);
});

it('toolbar Paste sends the real X clipboard to the remote shell',async()=>{
  const {gui,browser,terminal}=await ownedTerminal();
  const text=`PASTE ${nonce()} (kept) "as typed"`;
  gui.stage='owned toolbar paste';
  // WebKitGTK reads the page-visible clipboard as text/plain; GTK, Qt and browsers offer that target next to UTF8_STRING, a bare UTF8_STRING owner reads as empty.
  await gui.seedClipboard(text,'text/plain;charset=utf-8');
  await run(browser,terminal,`IFS= read -r pasted; printf 'GOT<%s>END\\n' "$pasted"`);
  await (await (await browser.$('.terminal-keys')).$('button=paste')).click();
  // Paste sends the text without Enter, so only the remote read receives it once the line ends.
  expect(await terminal.getText()).not.toContain(`GOT<${text}>END`);
  await terminal.click();
  await typeText(browser,'\n');
  await browser.waitUntil(async()=>(await terminal.getText()).includes(`GOT<${text}>END`),{timeout:20_000,timeoutMsg:'The remote shell did not receive the pasted clipboard'});
});
