import {browser, expect} from '@wdio/globals';
import {basename, join} from 'node:path';
import {connectOwnedHost} from '../../pageobjects/connect-owned-host';
import AgentLaunch from '../../pageobjects/components/agent-launch.component';
import SessionsPanel from '../../pageobjects/components/sessions-panel.component';
import SideMenu from '../../pageobjects/components/side-menu.component';
import Terminal from '../../pageobjects/terminal.page';
import {agentStarts, hostLaunchDirectory, hostRepository, hostWorktrees, isDirectory, tmuxWindows} from '../../support/agentHost';
import {resetApp} from '../../support/app';
import {readEndpoint, runNonce, type Endpoint} from '../../support/hosts';

const SERVER = 'owned-tmux';

describe('New agent from the Agent view over an owned tmux host', () => {
  let endpoint: Endpoint;
  let session: string;
  // A prompt that is hostile to a shell: it must reach the agent as one literal argument.
  const prompt = () => `fix the "tests"; echo $HOME = ${runNonce()}`;

  before(async () => {
    endpoint = await readEndpoint('tmux');
    session = `${await connectOwnedHost({kind: 'tmux', label: 'tmux'})} / ${SERVER}`;
    await SideMenu.openByEdgeSwipe();
    await SideMenu.showWorkspaces();
    await SideMenu.openSessionManager();
    await SessionsPanel.attach(SERVER);
  });
  after(resetApp);
  beforeEach(async () => {
    await SideMenu.openByEdgeSwipe();
    await SideMenu.chooseAgentView();
  });

  /** The host's own log says the stub agent has been started `count` times. */
  const startedTimes = (count: number) => browser.waitUntil(async () => (await agentStarts(endpoint)).length === count, {timeout: 30_000, timeoutMsg: `The host did not record ${count} agent start(s)`});

  /** The new tmux window is the session's current one, so the terminal shows what the stub printed in its folder. */
  async function expectStubInTerminal(folder: string) {
    await SideMenu.openByEdgeSwipe();
    await SideMenu.chooseTerminalView();
    await Terminal.in(() => expect(Terminal.screen(session)).toHaveText(expect.stringContaining(`AGENT_STUB ${basename(folder)}`)));
  }

  it('creates a new folder on the host, reviews the plan and starts the stub agent in a new tmux window there, with the prompt as its argument', async () => {
    const folder = join(hostLaunchDirectory(endpoint), `agent-${runNonce()}`);
    await AgentLaunch.open();
    await AgentLaunch.chooseAgent('codex');
    await AgentLaunch.chooseLocation('A new folder');
    // The folder browser lists what the host's SFTP server shows for the typed parent.
    await AgentLaunch.typeFolder(hostLaunchDirectory(endpoint));
    await AgentLaunch.browseFolders();
    await AgentLaunch.in(() => expect(AgentLaunch.browsed('repo')).toBeDisplayed());
    await AgentLaunch.typeFolder(folder);
    await AgentLaunch.typePrompt(prompt());
    await AgentLaunch.reviewPlan();
    await AgentLaunch.in(async () => {
      await expect(AgentLaunch.plan).toHaveText(expect.stringContaining(`'mkdir' '-p' '--' '${folder}'`));
      await expect(AgentLaunch.plan).toHaveText(expect.stringContaining("'new-window'"));
    });
    // Nothing has run on the host before the plan is confirmed.
    expect(await isDirectory(folder)).toBe(false);
    expect(await agentStarts(endpoint)).toEqual([]);

    await AgentLaunch.confirmPlan();
    await AgentLaunch.in(() => expect(AgentLaunch.root).not.toBeDisplayed());
    await startedTimes(1);
    expect(await agentStarts(endpoint)).toEqual([{argc: 1, cwd: folder, arg1: prompt()}]);
    expect(await isDirectory(folder)).toBe(true);
    expect(await tmuxWindows(endpoint)).toContainEqual(expect.objectContaining({path: folder}));
    await expectStubInTerminal(folder);
  });

  it('creates a new Git worktree of the host repository and starts the stub agent in a new tmux window in it', async () => {
    const branch = `e2e-${runNonce()}`;
    const repository = hostRepository(endpoint);
    const worktree = join(`${repository}-worktrees`, branch);
    await AgentLaunch.open();
    await AgentLaunch.chooseAgent('codex');
    await AgentLaunch.chooseLocation('A new Git worktree');
    await AgentLaunch.typeRepository(hostLaunchDirectory(endpoint));
    await AgentLaunch.browseFolders();
    await AgentLaunch.openBrowsed('repo');
    await AgentLaunch.in(() => expect(AgentLaunch.repositoryFolder).toHaveValue(repository));
    await AgentLaunch.readTheRepository();
    await AgentLaunch.typeBranch(branch);
    // The path follows the branch until it is edited.
    await AgentLaunch.in(() => expect(AgentLaunch.worktreePath).toHaveValue(worktree));
    await AgentLaunch.typePrompt(prompt());
    await AgentLaunch.reviewPlan();
    await AgentLaunch.in(() => expect(AgentLaunch.plan).toHaveText(expect.stringContaining(`'worktree' 'add' '-b' '${branch}' '--' '${worktree}'`)));
    expect(await hostWorktrees(endpoint)).toEqual([repository]);

    await AgentLaunch.confirmPlan();
    await AgentLaunch.in(() => expect(AgentLaunch.root).not.toBeDisplayed());
    await startedTimes(2);
    expect((await agentStarts(endpoint)).at(-1)).toEqual({argc: 1, cwd: worktree, arg1: prompt()});
    expect(await hostWorktrees(endpoint)).toEqual([repository, worktree]);
    expect(await tmuxWindows(endpoint)).toContainEqual(expect.objectContaining({path: worktree}));
    await expectStubInTerminal(worktree);
  });
});
