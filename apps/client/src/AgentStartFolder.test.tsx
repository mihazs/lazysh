// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import AgentStartFolder from './AgentStartFolder';

const staged=vi.fn(),shown=vi.fn(),invoke=vi.fn();
beforeEach(()=>{staged.mockReset();shown.mockReset();window.addEventListener('lazysh-prompt-draft',staged);});
afterEach(()=>{window.removeEventListener('lazysh-prompt-draft',staged);cleanup();});
const open=()=>{
  render(<AgentStartFolder sessionId="ssh" invoke={invoke} recent={[]} disabled={false} onStaged={shown}/>);
  fireEvent.click(screen.getByRole('button',{name:'Start in a folder'}));
  return screen.getByRole('dialog',{name:'Start in a folder'});
};
const fill=(dialog:HTMLElement,folder:string,args='')=>{
  fireEvent.change(within(dialog).getByLabelText('Herdr project directory'),{target:{value:folder}});
  fireEvent.change(within(dialog).getByLabelText('Arguments (optional)'),{target:{value:args}});
};
const review=(dialog:HTMLElement)=>fireEvent.click(within(dialog).getByRole('button',{name:'Review command'}));

it('starts with YOLO off and shows the exact command with the arguments as quoted words',()=>{
  const dialog=open();
  expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  fill(dialog,'/work/app','--model opus "two words" "$(touch x);"');
  review(dialog);
  expect(within(dialog).getByText(`cd '/work/app' && claude --model opus 'two words' '$(touch x);'`)).toBeTruthy();
  expect(within(dialog).queryByRole('note')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button',{name:'Stage in the terminal'}));
  expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'ssh',text:`cd '/work/app' && claude --model opus 'two words' '$(touch x);'`});
  expect(shown).toHaveBeenCalledTimes(1);
});

it('adds the chosen agent\'s verified flag when YOLO is ticked, says what it turns off, and resets it when the agent changes',()=>{
  const dialog=open();
  fill(dialog,'/work/app','--continue');
  fireEvent.click(within(dialog).getByRole('checkbox',{name:/YOLO: skip approval prompts \(--dangerously-skip-permissions\)/}));
  expect(within(dialog).getByRole('note').textContent).toMatch(/turns off Claude Code's approval prompts/);
  review(dialog);
  expect(within(dialog).getByText(`cd '/work/app' && claude --dangerously-skip-permissions --continue`)).toBeTruthy();
  expect(within(dialog).getByRole('note').textContent).toMatch(/runs commands and changes files without asking/);
  fireEvent.click(within(dialog).getByRole('button',{name:'Back'}));
  fireEvent.click(within(dialog).getByRole('radio',{name:'Codex'}));
  const yolo=within(dialog).getByRole('checkbox',{name:/--dangerously-bypass-approvals-and-sandbox/}) as HTMLInputElement;
  expect(yolo.checked).toBe(false);
  fireEvent.click(yolo);review(dialog);
  expect(within(dialog).getByText(`cd '/work/app' && codex --dangerously-bypass-approvals-and-sandbox --continue`)).toBeTruthy();
});

it('does not review a command until the arguments are valid',()=>{
  const dialog=open();
  fill(dialog,'/work/app','--append "open');
  review(dialog);
  expect(within(dialog).getByRole('alert').textContent).toMatch(/Close every quote/);
  expect(within(dialog).queryByRole('button',{name:'Stage in the terminal'})).toBeNull();
  fill(dialog,'/work/app',Array(33).fill('x').join(' '));
  review(dialog);
  expect(within(dialog).getByRole('alert').textContent).toMatch(/at most 32 arguments of 512 bytes/);
  expect(staged).not.toHaveBeenCalled();
  fill(dialog,'/work/app','--ok');
  review(dialog);
  expect(within(dialog).getByText(`cd '/work/app' && claude --ok`)).toBeTruthy();
});

it('forgets the choices when the dialog closes, so YOLO never carries over to the next start',()=>{
  const dialog=open();
  fireEvent.click(within(dialog).getByRole('checkbox'));
  fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));
  fireEvent.click(screen.getByRole('button',{name:'Start in a folder'}));
  expect((within(screen.getByRole('dialog')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
