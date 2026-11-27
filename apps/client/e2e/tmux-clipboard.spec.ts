import {expect,test,type Page} from '@playwright/test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openClipboardTerminal} from './fixtures/localTerminal';
import {allowRemoteCopy,attachPtyClient,hasScript,ownedEnv,shellQuote} from './fixtures/ptyMultiplexer';

const tmux=process.env.LAZYSH_TEST_TMUX??'tmux';
const available=spawnSync(tmux,['-V']).status===0&&hasScript;

/** A real tmux server and client in a PTY; lazysh's terminal pane renders the client's bytes. */
async function attachTmux(page:Page,command:string) {
  const root=mkdtempSync(join(tmpdir(),'lazysh-tmux-clipboard-')),socket=join(root,'socket'),config=join(root,'tmux.conf');
  // Quiet `set` keeps older tmux releases without allow-passthrough usable.
  writeFileSync(config,['set -g status off','set -g mode-keys vi','set -g set-clipboard on','set -gq allow-passthrough on',
    "set -as terminal-overrides ',xterm*:Ms=\\E]52;%p1%s;%p2%s\\007'"].join('\n'));
  const env=ownedEnv({});
  expect(spawnSync(tmux,['-S',socket,'-f',config,'new-session','-d','-x','80','-y','24',command],{env}).status).toBe(0);
  const client=await attachPtyClient(page,`${shellQuote(tmux)} -S ${shellQuote(socket)} attach`,env);
  // What tmux itself reports about its panes, so a step can wait for the server's state instead of for the keys' arrival.
  const pane=(format:string)=>spawnSync(tmux,['-S',socket,'list-panes','-a','-F',format],{env,encoding:'utf8'}).stdout.trim();
  return {pane,async dispose(){await client.stop();spawnSync(tmux,['-S',socket,'kill-server']);rmSync(root,{recursive:true,force:true});}};
}

test.describe('real tmux',()=>{
  // CI installs tmux, so a missing binary there fails the spec rather than hiding it as a skip.
  test.skip(!available&&!process.env.CI,'Requires tmux and util-linux script on PATH (LAZYSH_TEST_TMUX selects a tmux binary).');
  let session:Awaited<ReturnType<typeof attachTmux>>|undefined;
  test.afterEach(async()=>{await session?.dispose();session=undefined;});

  test('copy-mode search and copy reach the device clipboard through OSC 52 consent',async({page})=>{
    await openClipboardTerminal(page);
    session=await attachTmux(page,"printf 'alpha COPY_TARGET omega\\n'; exec sleep 600");
    await expect(page.locator('.terminal-canvas:visible .xterm-rows')).toContainText('COPY_TARGET');
    await page.locator('.terminal-canvas:visible .xterm-helper-textarea').focus();
    // The tmux "Copy mode" shortcut sends the prefix and `[`; the reader then searches and copies.
    // Each key waits for the tmux state it produces: a key that outruns the previous one starts the selection on the wrong cell.
    await page.keyboard.press('Control+b');await page.keyboard.type('[');
    await expect.poll(()=>session!.pane('#{pane_in_mode}')).toBe('1');
    // tmux opens the search prompt asynchronously: characters typed before it shows are read as copy-mode commands and drop out of the pattern ("OPY_TARGET" lands on column 7).
    await page.keyboard.type('?');
    await expect(page.locator('.terminal-canvas:visible .xterm-rows')).toContainText('(search up)');
    await page.keyboard.type('COPY_TARGET');await page.keyboard.press('Enter');
    // The search leaves the cursor on the first letter of the match, after "alpha ".
    await expect.poll(()=>session!.pane('#{copy_cursor_x}')).toBe('6');
    await page.keyboard.type(' e');
    await expect.poll(()=>session!.pane('#{copy_cursor_x}')).toBe('16');
    await page.keyboard.press('Enter');
    await allowRemoteCopy(page,'COPY_TARGET');
  });

  test('an application OSC 52 passes through tmux to the same consent prompt',async({page})=>{
    await openClipboardTerminal(page);
    session=await attachTmux(page,"sleep 1; printf '\\033Ptmux;\\033\\033]52;c;%s\\007\\033\\\\' \"$(printf PASSTHROUGH_TARGET | base64)\"; exec sleep 600");
    await allowRemoteCopy(page,'PASSTHROUGH_TARGET');
  });
});
