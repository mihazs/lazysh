import {expect,test,type Locator,type Page} from '@playwright/test';
import {fitsWidth} from './fixtures/dialogFit';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {Kind,mountAgentLauncher} from './fixtures/AgentLauncherHarness';
declare global {interface Window {agentLauncher:ReturnType<typeof mountAgentLauncher>}}

// The native plan is replaced by a recorded stand-in that returns the argv the Rust plan builders produce; what this
// spec holds is the screen: the request each choice sends, the plan it shows before anything runs, the single
// confirmation, and that the new agent is followed in the Agent view while the terminal stays one tap away.
// The words of the real plans are asserted against real tmux, Zellij and Herdr by `herdr_create` in the cargo tests.
const mount=async(page:Page,kind:Kind)=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async kind=>{const{mountAgentLauncher}=await import('/e2e/fixtures/AgentLauncherHarness.tsx');window.agentLauncher=mountAgentLauncher(kind);},kind);
  await expect(page.getByRole('region',{name:'Agent view'})).toBeVisible();
};
const calls=(page:Page,command:string)=>page.evaluate(command=>window.agentLauncher.calls.filter(call=>call.command===command).map(call=>call.args),command);
const commands=(dialog:Locator)=>dialog.locator('ol code').allTextContents();
/** What the plan shows for the multiplexer's own step, after the checks. */
const start={
  tmux:(label:string,directory:string,prompt='')=>`'tmux' '-u' '-L' 'default' 'new-window' '-P' '-F' '#{pane_id}' '-t' '=work:' '-n' '${label}' '-c' '${directory}' '--' 'codex'${prompt}`,
  zellij:(label:string,directory:string,prompt='')=>`'zellij' '--session=main' 'run' '--cwd=${directory}' '--name=${label}' '--' 'codex'${prompt}`,
  herdr:(label:string,directory:string)=>`'herdr' '--session' 'default' 'workspace' 'create' '--no-focus' '--label' '${label}' '--cwd' '${directory}'`,
};

for(const kind of ['tmux','zellij','herdr'] as const) {
  test(`${kind}: new agent in an existing folder, a new folder and a new worktree, reviewed before anything runs`,async({page})=>{
    await mount(page,kind);
    await page.getByRole('button',{name:'New agent',exact:true}).first().click();
    const dialog=page.getByRole('dialog',{name:'New agent'});
    const agent=dialog.getByRole('combobox',{name:'Agent'});
    // Missing agents show as unavailable; the ones found on the host can be picked.
    await expect(agent.locator('option')).toHaveText(['Choose an agent','Codex (codex)','Claude Code (claude) · not installed','OpenCode (opencode)']);
    await expect(agent.locator('option:disabled')).toHaveText(['Claude Code (claude) · not installed']);
    await dialog.getByRole('button',{name:'Review commands'}).click();
    await expect(dialog.getByRole('alert')).toHaveText('Choose which agent to start.');
    await agent.selectOption('codex');
    await fitsWidth(page);
    const prompt=dialog.getByRole('textbox',{name:'Initial prompt (optional)'});
    // tmux and Zellij take a prompt with line breaks as one argument; Herdr's agent start takes one line.
    expect(await prompt.evaluate(node=>node.tagName)).toBe(kind==='herdr'?'INPUT':'TEXTAREA');
    const text=kind==='herdr'?"review 'this'":"review 'this'\nthen go";
    const shown=kind==='herdr'?"'--' 'review '\\''this'\\'''":"'review '\\''this'\\''\nthen go'";
    const argument=kind==='herdr'?'':` ${shown}`;
    const review=async(request:Record<string,unknown>)=>{
      await dialog.getByRole('button',{name:'Review commands'}).click();
      await expect(dialog.locator('ol code').first()).toBeVisible();
      const plans=await calls(page,kind==='herdr'?'herdr_workspace_plan':'multiplexer_launch_plan');
      expect(plans.at(-1)).toEqual(kind==='herdr'?{name:'default',request}:{multiplexer:{kind,name:kind==='tmux'?'work':'main'},request});
      await fitsWidth(page);
    };
    const agentRequest={kind:'codex',name:expect.stringMatching(/^codex-[0-9a-f]{8}$/) as unknown as string,prompt:text};
    // Herdr names the agent it starts, and starts it as a last step in the new workspace's first pane.
    const finish=async(plan:string[])=>{
      if(kind!=='herdr')return plan;
      const {agent:{name}}=(await calls(page,'herdr_workspace_plan')).at(-1)!.request as {agent:{name:string}};
      return [...plan,`'herdr' '--session' 'default' 'agent' 'start' '${name}' '--kind' 'codex' '--pane' '<new-workspace-pane>' '--timeout' '60000' ${shown}`];
    };

    // An existing folder.
    await prompt.fill(text);
    await dialog.getByRole('textbox',{name:'Host folder'}).fill('/srv/api');
    await review({target:{type:'directory',label:'api',directory:'/srv/api'},agent:agentRequest});
    expect(await commands(dialog)).toEqual(await finish([
      "'command' '-v' '--' 'codex'",
      ...(kind==='herdr'?[]:["'test' '-d' '/srv/api'"]),
      kind==='herdr'?start.herdr('api','/srv/api'):start[kind]('api','/srv/api',argument),
    ]));
    await dialog.getByRole('button',{name:'Back'}).click();

    // A new folder: the host creates it, with its parents, before the agent starts in it.
    await dialog.getByRole('radio',{name:'A new folder'}).check();
    await dialog.getByRole('textbox',{name:'Host folder'}).fill('/srv/new project');
    await dialog.getByRole('textbox',{name:'Label (optional)'}).fill('scratch');
    await review({target:{type:'directory',label:'scratch',directory:'/srv/new project',create:true},agent:agentRequest});
    expect(await commands(dialog)).toEqual(await finish([
      "'command' '-v' '--' 'codex'",
      "'mkdir' '-p' '--' '/srv/new project'",
      kind==='herdr'?start.herdr('scratch','/srv/new project'):start[kind]('scratch','/srv/new project',argument),
    ]));
    await dialog.getByRole('button',{name:'Back'}).click();

    // A new worktree of the repository that holds a folder.
    await dialog.getByRole('radio',{name:'A new Git worktree'}).check();
    await expect(dialog.getByRole('button',{name:'Review commands'})).toBeDisabled();
    await dialog.getByRole('textbox',{name:'A folder inside the Git repository'}).fill('/srv/app/src');
    await dialog.getByRole('button',{name:'Read the repository'}).click();
    await dialog.getByRole('textbox',{name:'New branch'}).fill('feat/launcher');
    await expect(dialog.getByRole('textbox',{name:'Worktree path'})).toHaveValue('/srv/app-worktrees/feat-launcher');
    expect(await calls(page,'herdr_repository')).toEqual([{sessionId:'launcher-host',directory:'/srv/app/src'}]);
    await review({target:{type:'worktree',repository:'/srv/app',branch:'feat/launcher',base:'main',path:'/srv/app-worktrees/feat-launcher'},agent:agentRequest});
    expect(await commands(dialog)).toEqual(await finish([
      "'command' '-v' '--' 'codex'",
      "'git' '-C' '/srv/app' 'worktree' 'add' '-b' 'feat/launcher' '--' '/srv/app-worktrees/feat-launcher' 'main'",
      kind==='herdr'?start.herdr('feat/launcher','/srv/app-worktrees/feat-launcher'):start[kind]('feat/launcher','/srv/app-worktrees/feat-launcher',argument),
    ]));

    // Nothing ran while the commands were being reviewed; confirming runs exactly the reviewed request.
    expect(await calls(page,kind==='herdr'?'herdr_workspace_create':'multiplexer_launch')).toEqual([]);
    const reviewed=(await calls(page,kind==='herdr'?'herdr_workspace_plan':'multiplexer_launch_plan')).at(-1)!.request;
    await dialog.getByRole('button',{name:'Create and start agent'}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await calls(page,kind==='herdr'?'herdr_workspace_create':'multiplexer_launch')).toEqual([
      {sessionId:'launcher-host',...(kind==='herdr'?{name:'default'}:{multiplexer:{kind,name:kind==='tmux'?'work':'main'}}),request:reviewed},
    ]);

    // The Agent view follows the new agent without the terminal, which stays one tap away.
    await expect(page.getByText('Hello from the new agent')).toBeVisible({timeout:15_000});
    if(kind==='herdr')expect(await calls(page,'herdr_action')).toEqual([{sessionId:'launcher-host',name:'default',action:{type:'focusWorkspace',target:'wNEW'}}]);
    else expect((await calls(page,'tmux_chat')).filter(args=>(args.action as {kind:string}).kind==='input')).toEqual([]);
    expect(await page.evaluate(()=>window.agentLauncher.terminal.shown)).toBe(0);
    await page.getByRole('button',{name:'Terminal',exact:true}).click();
    expect(await page.evaluate(()=>window.agentLauncher.terminal.shown)).toBe(1);
  });
}
