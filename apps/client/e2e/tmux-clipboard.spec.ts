import {expect,test,type Page} from '@playwright/test';
import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {openClipboardTerminal} from './fixtures/localTerminal';

const tmux=process.env.LAZYSH_TEST_TMUX??'tmux';
const available=spawnSync(tmux,['-V']).status===0&&spawnSync('script',['--version']).status===0;
declare global {interface Window {tmuxInput:(data:string)=>Promise<void>}}

/** A real tmux server and client in a PTY; lazysh's terminal pane renders the client's bytes. */
async function attachTmux(page:Page,command:string) {
  const root=mkdtempSync(join(tmpdir(),'lazysh-tmux-clipboard-')),socket=join(root,'socket'),config=join(root,'tmux.conf');
  // Quiet `set` keeps older tmux releases without allow-passthrough usable.
  writeFileSync(config,['set -g status off','set -g mode-keys vi','set -g set-clipboard on','set -gq allow-passthrough on',
    "set -as terminal-overrides ',xterm*:Ms=\\E]52;%p1%s;%p2%s\\007'"].join('\n'));
  const env={...process.env,TERM:'xterm-256color'};
  const run=(...args:string[])=>expect(spawnSync(tmux,['-S',socket,'-f',config,...args],{env}).status).toBe(0);
  run('new-session','-d','-x','80','-y','24',command);
  const client:ChildProcessWithoutNullStreams=spawn('script',['-qfec',`stty cols 80 rows 24; exec ${tmux} -S ${socket} attach`,'/dev/null'],{env});
  const decoder=new StringDecoder('utf8');
  await page.exposeFunction('tmuxInput',(data:string)=>{client.stdin.write(data);});
  await page.evaluate(()=>{window.simpleShortcutInput=data=>void window.tmuxInput(data);});
  client.stdout.on('data',(chunk:Buffer)=>{const text=decoder.write(chunk);if(text)void page.evaluate(text=>window.simpleShortcutOutput(text),text).catch(()=>{});});
  return {run,dispose(){client.kill();spawnSync(tmux,['-S',socket,'kill-server']);rmSync(root,{recursive:true,force:true});}};
}



async function allow(page:Page,text:string) {
  const region=page.getByRole('region',{name:'Remote clipboard request',exact:true});
  await expect(region).toContainText(text);
  expect(await page.evaluate(()=>navigator.clipboard.readText())).not.toBe(text);
  await region.getByRole('button',{name:'Allow this copy',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(text);
}

test.describe('real tmux',()=>{
  // CI installs tmux, so a missing binary there fails the spec rather than hiding it as a skip.
  test.skip(!available&&!process.env.CI,'Requires tmux and util-linux script on PATH (LAZYSH_TEST_TMUX selects a tmux binary).');
  let session:Awaited<ReturnType<typeof attachTmux>>|undefined;
  test.afterEach(()=>{session?.dispose();session=undefined;});

  test('copy-mode search and copy reach the device clipboard through OSC 52 consent',async({page})=>{
    await openClipboardTerminal(page);
    session=await attachTmux(page,"printf 'alpha COPY_TARGET omega\\n'; exec sleep 600");
    await expect(page.locator('.terminal-canvas:visible .xterm-rows')).toContainText('COPY_TARGET');
    await page.locator('.terminal-canvas:visible .xterm-helper-textarea').focus();
    // The tmux "Copy mode" shortcut sends the prefix and `[`; the reader then searches and copies.
    await page.keyboard.press('Control+b');await page.keyboard.type('[');
    await page.keyboard.type('?COPY_TARGET');await page.keyboard.press('Enter');
    await page.keyboard.type(' e');await page.keyboard.press('Enter');
    await allow(page,'COPY_TARGET');
  });

  test('an application OSC 52 passes through tmux to the same consent prompt',async({page})=>{
    await openClipboardTerminal(page);
    session=await attachTmux(page,"sleep 1; printf '\\033Ptmux;\\033\\033]52;c;%s\\007\\033\\\\' \"$(printf PASSTHROUGH_TARGET | base64)\"; exec sleep 600");
    await allow(page,'PASSTHROUGH_TARGET');
  });
});
