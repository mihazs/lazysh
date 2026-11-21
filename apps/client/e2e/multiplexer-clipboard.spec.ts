import {expect,test,type Page} from '@playwright/test';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openClipboardTerminal} from './fixtures/localTerminal';
import {allowRemoteCopy,attachPtyClient,hasScript,ownedEnv,ownedPane,selectWithMouse,shellQuote,stop} from './fixtures/ptyMultiplexer';

// Real Zellij and Herdr clients in a PTY, like tmux-clipboard.spec.ts does for tmux. The specs run where
// LAZYSH_TEST_ZELLIJ and LAZYSH_TEST_HERDR name the binaries (the native-linux-runtimes CI job sets both)
// and skip elsewhere, so the `client` job, which installs only tmux, does not need them.
type Pane=(go:string)=>string;
type Session={client:Awaited<ReturnType<typeof attachPtyClient>>;release:()=>void;dispose:()=>Promise<void>};

/** Zellij needs no clipboard option: with no `copy_command` it copies through OSC 52, and `copy_on_select` is on by default. */
async function attachZellij(page:Page,zellij:string,body:Pane):Promise<Session> {
  const pane=ownedPane('lazysh-zellij-clipboard-',body),sockets=join(pane.root,'sockets'),config=join(pane.root,'config.kdl');
  mkdirSync(sockets);
  writeFileSync(config,['show_startup_tips false','show_release_notes false',`layout_dir ${JSON.stringify(pane.root)}`,'default_layout "plain"'].join('\n'));
  writeFileSync(join(pane.root,'plain.kdl'),`layout {\n  pane command=${JSON.stringify(pane.script)}\n}\n`);
  const env=ownedEnv({HOME:pane.root,XDG_RUNTIME_DIR:pane.root,ZELLIJ_SOCKET_DIR:sockets});
  const client=await attachPtyClient(page,`${shellQuote(zellij)} --config ${shellQuote(config)} --session lazysh-osc52`,env);
  return {client,release:pane.release,async dispose(){await client.stop();spawnSync(zellij,['--config',config,'kill-all-sessions','--yes'],{env});pane.remove();}};
}

/** Herdr needs no clipboard option either: over SSH (`SSH_CONNECTION`, which sshd sets) it writes OSC 52, and `ui.copy_on_select` is on by default. */
async function attachHerdr(page:Page,herdr:string,body:Pane):Promise<Session> {
  const pane=ownedPane('lazysh-herdr-clipboard-',body),config=join(pane.root,'config.toml');
  writeFileSync(config,'onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n');
  const env=ownedEnv({HOME:pane.root,ZDOTDIR:pane.root,XDG_CONFIG_HOME:pane.root,HERDR_CONFIG_PATH:config,SHELL:pane.script,SSH_CONNECTION:'127.0.0.1 1 127.0.0.1 22'});
  const server=spawn(herdr,['server'],{env,cwd:pane.root,stdio:'ignore'});
  await expect.poll(()=>spawnSync(herdr,['api','snapshot'],{env,cwd:pane.root}).status,{message:'the owned Herdr server answers',timeout:20_000}).toBe(0);
  const client=await attachPtyClient(page,shellQuote(herdr),env);
  return {client,release:pane.release,async dispose(){await client.stop();await stop(server);pane.remove();}};
}

const copyPane:Pane=()=>"printf 'alpha %s omega\\n' COPY_TARGET";
// The program starts before lazysh renders the client, so it waits for the test's release before writing.
const passthroughPane:Pane=go=>`printf 'READY\\n'; until [ -e ${go} ]; do sleep 0.1; done; printf '\\033]52;c;%s\\007' "$(printf PASSTHROUGH_TARGET | base64)"`;

const multiplexers=[
  // Zellij leaves the cell of the release out of the selection; Herdr includes it.
  {name:'Zellij',binary:process.env.LAZYSH_TEST_ZELLIJ,attach:attachZellij,endsInclusive:false},
  {name:'Herdr',binary:process.env.LAZYSH_TEST_HERDR,attach:attachHerdr,endsInclusive:true},
];
for(const {name,binary,attach,endsInclusive} of multiplexers)test.describe(`real ${name}`,()=>{
  test.skip(!binary||!hasScript,`Set LAZYSH_TEST_${name.toUpperCase()} to a ${name} binary and have util-linux script on PATH.`);
  // The client draws 80 columns; a phone-width terminal wraps them, so cell coordinates would not match.
  test.skip(({isMobile})=>isMobile,'The 80-column client screen needs a desktop-width terminal.');
  let session:Session|undefined;
  test.afterEach(async()=>{await session?.dispose();session=undefined;});
  test.describe.configure({timeout:60_000});
  const rows=(page:Page)=>page.locator('.terminal-canvas:visible .xterm-rows');

  test('a mouse selection copies to the device clipboard through OSC 52 consent',async({page})=>{
    await openClipboardTerminal(page);
    session=await attach(page,binary!,copyPane);
    await expect(rows(page)).toContainText('alpha COPY_TARGET omega',{timeout:20_000});
    await selectWithMouse(page,session.client,'COPY_TARGET',endsInclusive);
    await allowRemoteCopy(page,'COPY_TARGET');
  });

  test('an application OSC 52 passes through to the same consent prompt',async({page})=>{
    await openClipboardTerminal(page);
    session=await attach(page,binary!,passthroughPane);
    await expect(rows(page)).toContainText('READY',{timeout:20_000});
    session.release();
    await allowRemoteCopy(page,'PASSTHROUGH_TARGET');
  });
});
