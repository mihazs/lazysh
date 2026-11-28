// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {captureAccess} from './access';
import {AgentLaunch} from './HerdrWorkspaceCreateDialog';
import {chatFollowAccess as access} from './test/chatFollowAccess';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

const kinds=[
  {kind:'codex',label:'Codex',executable:'codex',prompt:true,installed:true},
  {kind:'claude',label:'Claude Code',executable:'claude',prompt:true,installed:false},
  {kind:'opencode',label:'OpenCode',executable:'opencode',prompt:false,installed:true},
];
const repository={root:'/srv/app',main:'/srv/app',head:'main',detached:false,worktrees:['/srv/app','/srv/app-worktrees/old']};
const plan={steps:[{stage:'agentCheck',argv:['command'],command:"'command' '-v' '--' 'codex'"},{stage:'window',argv:['tmux'],command:"'tmux' 'new-window'"}]};
let outcome:Record<string,unknown>;
const calls=(name:string)=>vi.mocked(invoke).mock.calls.filter(([command])=>command===name).map(([,args])=>args);
const typing=(element:HTMLElement,value:string)=>fireEvent.change(element,{target:{value}});
const created=vi.fn();
type Multiplexer=Parameters<typeof AgentLaunch>[0]['multiplexer'];
async function open(multiplexer:Multiplexer={kind:'tmux',name:'work'}) {
  render(<AgentLaunch sessionId="ssh" lease={captureAccess()} multiplexer={multiplexer} disabled={false} label="New agent" onCreated={created}/>);
  fireEvent.click(screen.getByRole('button',{name:'New agent'}));
  const dialog=await screen.findByRole('dialog',{name:'New agent'});
  await within(dialog).findByRole('combobox',{name:'Agent'});
  return dialog;
}
const choose=(dialog:HTMLElement,kind='codex')=>fireEvent.change(within(dialog).getByRole('combobox',{name:'Agent'}),{target:{value:kind}});
const where=(dialog:HTMLElement,name:string)=>fireEvent.click(within(dialog).getByRole('radio',{name}));
const folder=(dialog:HTMLElement,value:string,field='Host folder')=>typing(within(dialog).getByRole('textbox',{name:field}),value);
const inRepository=(dialog:HTMLElement,value:string)=>folder(dialog,value,'A folder inside the Git repository');
const review=async(dialog:HTMLElement)=>{fireEvent.click(within(dialog).getByRole('button',{name:'Review commands'}));await within(dialog).findByText(/Only these exact commands/);};
const name=expect.stringMatching(/^[a-z]+-[0-9a-f]{8}$/);

beforeEach(()=>{
  localStorage.clear();created.mockReset();vi.mocked(invoke).mockReset();access();
  outcome={paneId:'%7'};
  vi.mocked(invoke).mockImplementation(async(command)=>{
    switch(command) {
      case 'herdr_agent_kinds':return kinds;
      case 'herdr_repository':return repository;
      case 'multiplexer_launch_plan':case 'herdr_workspace_plan':return plan;
      case 'multiplexer_launch':case 'herdr_workspace_create':return outcome;
      default:throw new Error(`Unexpected ${command}`);
    }
  });
});
afterEach(cleanup);

describe('the New agent launcher',()=>{
  it('lists every supported agent and offers only the installed ones',async()=>{
    const dialog=await open();
    const options=within(dialog).getAllByRole('option').map(option=>[option.textContent,(option as HTMLOptionElement).disabled]);
    expect(options).toEqual([['Choose an agent',false],['Codex (codex)',false],['Claude Code (claude) · not installed',true],['OpenCode (opencode)',false]]);
  });

  it('starts an agent in an existing folder of the tmux session only after the reviewed commands are confirmed',async()=>{
    const dialog=await open();
    choose(dialog);
    folder(dialog,'/srv/api');
    typing(within(dialog).getByRole('textbox',{name:'Initial prompt (optional)'}),"review 'this'\nthen $(id);");
    await review(dialog);
    const request={target:{type:'directory',label:'api',directory:'/srv/api'},agent:{kind:'codex',name,prompt:"review 'this'\nthen $(id);"}};
    expect(calls('multiplexer_launch_plan')).toEqual([{multiplexer:{kind:'tmux',name:'work'},request}]);
    expect(within(dialog).getAllByRole('code').map(code=>code.textContent)).toEqual(plan.steps.map(step=>step.command));
    expect(within(dialog).getByText(/becomes the current one/)).toBeTruthy();
    expect(calls('multiplexer_launch')).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button',{name:'Create and start agent'}));
    await waitFor(()=>expect(created).toHaveBeenCalledWith('%7'));
    expect(calls('multiplexer_launch')).toEqual([{sessionId:'ssh',multiplexer:{kind:'tmux',name:'work'},request}]);
    expect(calls('herdr_workspace_plan')).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for a new folder to be created and takes its label from the typed one',async()=>{
    const dialog=await open();
    choose(dialog);where(dialog,'A new folder');
    folder(dialog,'/srv/new project');
    typing(within(dialog).getByRole('textbox',{name:'Label (optional)'}),'scratch');
    await review(dialog);
    expect(calls('multiplexer_launch_plan')).toEqual([{multiplexer:{kind:'tmux',name:'work'},request:{target:{type:'directory',label:'scratch',directory:'/srv/new project',create:true},agent:{kind:'codex',name}}}]);
  });

  it('reads the repository of a folder, suggests a branch and a path and asks for a new worktree',async()=>{
    const dialog=await open({kind:'zellij',name:'main'});
    choose(dialog);where(dialog,'A new Git worktree');
    expect((within(dialog).getByRole('button',{name:'Review commands'}) as HTMLButtonElement).disabled).toBe(true);
    inRepository(dialog,'/srv/app/src');
    fireEvent.click(within(dialog).getByRole('button',{name:'Read the repository'}));
    const branch=await within(dialog).findByRole('textbox',{name:'New branch'});
    expect(calls('herdr_repository')).toEqual([{sessionId:'ssh',directory:'/srv/app/src'}]);
    expect((branch as HTMLInputElement).value).toBe('src');
    expect((within(dialog).getByRole('textbox',{name:'Base revision'}) as HTMLInputElement).value).toBe('main');
    typing(branch,'feat/launcher');
    expect((within(dialog).getByRole('textbox',{name:'Worktree path'}) as HTMLInputElement).value).toBe('/srv/app-worktrees/feat-launcher');
    await review(dialog);
    expect(calls('multiplexer_launch_plan')).toEqual([{multiplexer:{kind:'zellij',name:'main'},request:{target:{type:'worktree',repository:'/srv/app',branch:'feat/launcher',base:'main',path:'/srv/app-worktrees/feat-launcher'},agent:{kind:'codex',name}}}]);
    expect(within(dialog).getByText(/new Zellij pane/)).toBeTruthy();
    outcome={paneId:'terminal_4',worktree:'/srv/app-worktrees/feat-launcher'};
    fireEvent.click(within(dialog).getByRole('button',{name:'Create and start agent'}));
    await waitFor(()=>expect(created).toHaveBeenCalledWith('terminal_4'));
  });

  it('forgets a repository read for another folder',async()=>{
    const dialog=await open();
    choose(dialog);where(dialog,'A new Git worktree');
    inRepository(dialog,'/srv/app');
    fireEvent.click(within(dialog).getByRole('button',{name:'Read the repository'}));
    await within(dialog).findByRole('textbox',{name:'New branch'});
    inRepository(dialog,'/srv/other');
    expect(within(dialog).queryByRole('textbox',{name:'New branch'})).toBeNull();
    expect((within(dialog).getByRole('button',{name:'Review commands'}) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses what the host would refuse before any plan is asked for',async()=>{
    const dialog=await open();
    fireEvent.click(within(dialog).getByRole('button',{name:'Review commands'}));
    expect(within(dialog).getByRole('alert').textContent).toBe('Choose which agent to start.');
    choose(dialog);
    fireEvent.click(within(dialog).getByRole('button',{name:'Review commands'}));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/absolute path/);
    folder(dialog,'/srv/api');
    typing(within(dialog).getByRole('textbox',{name:'Initial prompt (optional)'}),'-p');
    fireEvent.click(within(dialog).getByRole('button',{name:'Review commands'}));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/does not start with -/);
    typing(within(dialog).getByRole('textbox',{name:'Initial prompt (optional)'}),'back\\slash');
    fireEvent.click(within(dialog).getByRole('button',{name:'Review commands'}));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/backslashes/);
    expect(calls('multiplexer_launch_plan')).toEqual([]);
    // An agent without an initial prompt offers no prompt field.
    choose(dialog,'opencode');
    expect(within(dialog).queryByRole('textbox',{name:'Initial prompt (optional)'})).toBeNull();
  });

  it('keeps a created folder and the failure when the window does not open',async()=>{
    const dialog=await open();
    choose(dialog);where(dialog,'A new folder');folder(dialog,'/srv/fresh');
    await review(dialog);
    outcome={folder:'/srv/fresh',failure:{stage:'window',message:"can't find session: work"}};
    fireEvent.click(within(dialog).getByRole('button',{name:'Create and start agent'}));
    const alert=await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The folder /srv/fresh exists on the host.');
    expect(alert.textContent).toContain("Open a tmux window running the agent");
    expect(alert.textContent).toContain("can't find session: work");
    expect(created).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('button',{name:'Open workspace'})).toBeNull();
  });

  it('uses the Herdr commands for a Herdr server and a single-line prompt',async()=>{
    const dialog=await open({kind:'herdr',name:'default'});
    choose(dialog);folder(dialog,'/srv/api');
    expect(within(dialog).getByRole('textbox',{name:'Initial prompt (optional)'}).tagName).toBe('INPUT');
    await review(dialog);
    const request={target:{type:'directory',label:'api',directory:'/srv/api'},agent:{kind:'codex',name}};
    expect(calls('herdr_workspace_plan')).toEqual([{name:'default',request}]);
    expect(calls('multiplexer_launch_plan')).toEqual([]);
    expect(within(dialog).getByText(/becomes the first pane of the new workspace/)).toBeTruthy();
    outcome={workspaceId:'w9',paneId:'w9:p1'};
    fireEvent.click(within(dialog).getByRole('button',{name:'Create and start agent'}));
    await waitFor(()=>expect(created).toHaveBeenCalledWith('w9'));
    expect(calls('herdr_workspace_create')).toEqual([{sessionId:'ssh',name:'default',request}]);
  });
});
