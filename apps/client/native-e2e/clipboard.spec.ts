import {expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {NativeGui} from './fixture';
import {markerDrag} from './terminalSelection';
import {ownedSshGui,typeText} from './sshUi';

const fixture=ownedSshGui();

it('copies selected local terminal output to the real X clipboard that another X client reads',async()=>{
  fixture.captureSafe=true;
  const gui=fixture.gui=await NativeGui.start(),browser=gui.browser!;
  await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  gui.stage='clipboard local session';
  await gui.secondary(['--dir',gui.directory]);
  const terminal=await browser.$('.terminal-canvas .xterm-screen');await terminal.waitForDisplayed({timeout:20_000});
  await terminal.click();
  const nonce=randomBytes(6).toString('hex'),marker=`native-clipboard-${nonce}`;
  // Split the literal so the echoed command cannot satisfy the output row.
  await typeText(browser,`printf '%s%s\\n' native-clipboard- ${nonce}\n`);
  // WebDriver's getText joins the rows without newlines, so the row itself is what proves the output.
  await browser.waitUntil(async()=>await browser.execute(markerDrag,marker)!==null,{timeout:20_000,timeoutMsg:'Local PTY did not print the clipboard marker row'});
  expect(await gui.readClipboard()).not.toBe(marker);

  gui.stage='clipboard select and Copy';
  const drag=(await browser.execute(markerDrag,marker))!;
  const pointer=browser.action('pointer',{parameters:{pointerType:'mouse'}}).move({x:Math.round(drag.from.x),y:Math.round(drag.from.y)}).down({button:0});
  // xterm extends a selection on mouse moves, so the drag passes through intermediate points.
  for(let step=1;step<=6;step++)pointer.move({x:Math.round(drag.from.x+(drag.to.x-drag.from.x)*step/6),y:Math.round(drag.from.y),duration:30});
  await pointer.up({button:0}).perform();
  const actions=await browser.$('[role="toolbar"][aria-label="Selection actions"]');await actions.waitForDisplayed({timeout:5000});
  await (await actions.$('button=Copy')).click();
  await browser.waitUntil(async()=>await gui.readClipboard()===marker,{timeout:10_000,timeoutMsg:'Another X client did not read the copied terminal text from the real clipboard'});
  expect(gui.connections).toBe(0);
});
