// @vitest-environment jsdom
import {act} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import MultiplexerTabStrip from './MultiplexerTabStrip';
import {herdrStrip,tmuxStrip,zellijStrip,type MuxStrip} from './multiplexerTabs';

afterEach(()=>{cleanup();vi.useRealTimers();});
const herdr=herdrStrip({
  workspaces:[{workspace_id:'w1',label:'Dev',focused:true,agent_status:'working'},{workspace_id:'w2',label:'Ops',focused:false,agent_status:'blocked'}],
  tabs:[{workspace_id:'w1',tab_id:'t1',label:'deploy',number:1,focused:true,agent_status:'working'},{workspace_id:'w1',tab_id:'t2',label:'logs',number:2,focused:false,agent_status:'blocked'},{workspace_id:'w1',tab_id:'t3',label:'notes',number:3,focused:false,agent_status:'idle'}],
  panes:[]})!;

it('names every chip by title, position and agent state, marks the active one and never claims the tab role',()=>{
  render(<MultiplexerTabStrip strip={herdr} onSelect={vi.fn()}/>);
  const group=screen.getByRole('group',{name:'herdr tabs'});
  expect(screen.queryAllByRole('tab')).toEqual([]);
  const chips=within(group).getAllByRole('button').filter(button=>button.classList.contains('mux-chip'));
  expect(chips.map(chip=>chip.getAttribute('aria-label'))).toEqual(['deploy, tab 1 of 3, Working','logs, tab 2 of 3, Needs attention','notes, tab 3 of 3, Idle']);
  expect(chips.map(chip=>chip.getAttribute('aria-current'))).toEqual(['true',null,null]);
  expect(chips[1].hasAttribute('data-attention')).toBe(true);
});
it('selects another tab on tap, keeps focus where it is, and ignores a tap on the active one',()=>{
  const select=vi.fn();
  render(<MultiplexerTabStrip strip={herdr} onSelect={select}/>);
  const logs=screen.getByRole('button',{name:/^logs/});
  // Cancelling the press default is what keeps an open soft keyboard open and a closed one closed.
  expect(fireEvent.pointerDown(logs)).toBe(false);
  fireEvent.click(logs);
  expect(select).toHaveBeenCalledExactlyOnceWith({kind:'herdr',target:{kind:'tab',workspace:'w1',tab:'t2'}});
  fireEvent.click(screen.getByRole('button',{name:/^deploy/}));
  expect(select).toHaveBeenCalledOnce();
});
it('switches workspace from the leading chip, flags another workspace that needs attention, and closes on Escape or an outside press',()=>{
  const select=vi.fn();
  render(<><MultiplexerTabStrip strip={herdr} onSelect={select}/><button>outside</button></>);
  const chip=screen.getByRole('button',{name:'Workspaces: Dev, Needs attention'});
  expect(chip.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(chip);
  const list=screen.getByRole('group',{name:'Workspaces'});
  expect(within(list).getAllByRole('button').map(button=>button.getAttribute('aria-label'))).toEqual(['Dev, tab 1 of 2, Working','Ops, tab 2 of 2, Needs attention']);
  fireEvent.keyDown(document.body,{key:'Escape'});
  expect(screen.queryByRole('group',{name:'Workspaces'})).toBeNull();
  fireEvent.click(chip);fireEvent.pointerDown(screen.getByText('outside'));
  expect(screen.queryByRole('group',{name:'Workspaces'})).toBeNull();
  fireEvent.click(chip);
  fireEvent.click(screen.getByRole('button',{name:/^Ops/}));
  expect(select).toHaveBeenCalledExactlyOnceWith({kind:'herdr',target:{kind:'workspace',workspace:'w2'}});
  expect(screen.queryByRole('group',{name:'Workspaces'})).toBeNull();
});
it('shows a Zellij session as a plain label, not a workspace switcher',()=>{
  const strip:MuxStrip=zellijStrip('build',[{position:0,name:'shell',active:true},{position:1,name:'logs',active:false}]);
  render(<MultiplexerTabStrip strip={strip} onSelect={vi.fn()}/>);
  expect(screen.getByText('build').closest('button')).toBeNull();
  expect(screen.getByRole('group',{name:'zellij tabs'})).toBeTruthy();
});
it('keeps the active chip in view when the multiplexer moves focus to a tab outside the visible row',()=>{
  const strip=zellijStrip('s',Array.from({length:12},(_,position)=>({position,name:`tab ${position}`,active:position===0})));
  const view=render(<MultiplexerTabStrip strip={strip} onSelect={vi.fn()}/>);
  const row=view.container.querySelector<HTMLElement>('.mux-tabs')!;
  // jsdom has no layout: give the chips and the row the geometry a 415 px phone would give them.
  Object.defineProperty(row,'clientWidth',{value:300,configurable:true});
  for(const chip of Array.from(row.children) as HTMLElement[]){Object.defineProperty(chip,'offsetWidth',{value:100,configurable:true});}
  Array.from(row.children).forEach((chip,index)=>Object.defineProperty(chip,'offsetLeft',{value:index*100,configurable:true}));
  view.rerender(<MultiplexerTabStrip strip={zellijStrip('s',Array.from({length:12},(_,position)=>({position,name:`tab ${position}`,active:position===9})))} onSelect={vi.fn()}/>);
  expect(row.scrollLeft).toBe(900-(300-100)/2);
});

const hold=(element:Element,ms:number,at={clientX:10,clientY:10})=>{fireEvent.pointerDown(element,{pointerType:'touch',...at});act(()=>{vi.advanceTimersByTime(ms);});};
it('offers Rename and Close after a long press, without selecting the chip it was held on, and renames from the menu',()=>{
  vi.useFakeTimers();
  const select=vi.fn(),edit=vi.fn(async()=>true);
  render(<MultiplexerTabStrip strip={herdr} onSelect={select} onEdit={edit}/>);
  const logs=screen.getByRole('button',{name:/^logs/});
  hold(logs,600);
  expect(screen.queryByRole('form')).toBeNull();
  const menu=screen.getByRole('group',{name:'logs'});
  expect(within(menu).getAllByRole('button').map(button=>button.textContent)).toEqual(['Rename','Close']);
  // The menu is pressed without taking focus, so an open soft keyboard stays open and the terminal grid does not move.
  expect(fireEvent.pointerDown(within(menu).getByRole('button',{name:'Rename'}))).toBe(false);
  fireEvent.pointerUp(logs);fireEvent.click(logs);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(within(menu).getByRole('button',{name:'Rename'}));
  expect(screen.queryByRole('group',{name:'logs'})).toBeNull();
  const form=screen.getByRole('form',{name:'Rename logs'});
  const name=within(form).getByLabelText('Name') as HTMLInputElement;
  expect(name.value).toBe('logs');
  expect(within(form).queryByLabelText('Directory')).toBeNull();
  fireEvent.change(name,{target:{value:'  api  '}});
  fireEvent.submit(form);
  expect(edit).toHaveBeenCalledExactlyOnceWith({kind:'herdr',type:'renameTab',target:'t2'},'api','.');
});
it('does not rename on a short tap, on a hold that turns into a scroll, or on a chip with nothing to rename',()=>{
  vi.useFakeTimers();
  const select=vi.fn(),edit=vi.fn(async()=>true);
  const view=render(<MultiplexerTabStrip strip={herdr} onSelect={select} onEdit={edit}/>);
  const logs=screen.getByRole('button',{name:/^logs/});
  fireEvent.pointerDown(logs,{pointerType:'touch',clientX:10,clientY:10});
  fireEvent.pointerUp(logs);act(()=>{vi.advanceTimersByTime(900);});
  fireEvent.pointerDown(logs,{pointerType:'touch',clientX:10,clientY:10});
  fireEvent.pointerMove(logs,{clientX:60,clientY:12});act(()=>{vi.advanceTimersByTime(900);});
  expect(screen.queryByRole('form')).toBeNull();
  fireEvent.click(logs);
  expect(select).toHaveBeenCalledOnce();
  view.rerender(<MultiplexerTabStrip strip={zellijStrip('s',[{position:0,name:'shell',active:false}])} onSelect={select} onEdit={edit}/>);
  hold(screen.getByRole('button',{name:/^shell/}),900);
  expect(screen.queryByRole('form')).toBeNull();
});
it('renames from the keyboard through the context menu and offers nothing without a handler',()=>{
  const edit=vi.fn(async()=>true);
  const view=render(<MultiplexerTabStrip strip={herdr} onSelect={vi.fn()} onEdit={edit}/>);
  expect(fireEvent.contextMenu(screen.getByRole('button',{name:/^notes/}))).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Rename'}));
  expect(screen.getByRole('form',{name:'Rename notes'})).toBeTruthy();
  view.unmount();
  render(<MultiplexerTabStrip strip={herdr} onSelect={vi.fn()}/>);
  fireEvent.contextMenu(screen.getByRole('button',{name:/^notes/}));
  expect(screen.queryByRole('form')).toBeNull();
  expect(screen.queryByRole('group',{name:'notes'})).toBeNull();
  expect(screen.queryByRole('button',{name:'New tab'})).toBeNull();
});
it('moves focus into the menu only for a keyboard user, never for a touch or mouse hold',()=>{
  vi.useFakeTimers();
  render(<MultiplexerTabStrip strip={herdr} onSelect={vi.fn()} onEdit={vi.fn(async()=>true)}/>);
  const logs=screen.getByRole('button',{name:/^logs/});
  hold(logs,600);
  expect(screen.getByRole('group',{name:'logs'})).toBeTruthy();
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body,{key:'Escape'});
  expect(screen.queryByRole('group',{name:'logs'})).toBeNull();
  logs.focus();
  fireEvent.contextMenu(logs);
  expect(document.activeElement).toBe(within(screen.getByRole('group',{name:'logs'})).getByRole('button',{name:'Rename'}));
});
it('dismisses the menu on Escape or a press anywhere else and keeps the chips as they were',()=>{
  vi.useFakeTimers();
  const select=vi.fn();
  render(<><MultiplexerTabStrip strip={herdr} onSelect={select} onEdit={vi.fn(async()=>true)}/><button>outside</button></>);
  hold(screen.getByRole('button',{name:/^logs/}),600);
  fireEvent.pointerDown(screen.getByText('outside'));
  expect(screen.queryByRole('group',{name:'logs'})).toBeNull();
  hold(screen.getByRole('button',{name:/^logs/}),600);
  fireEvent.pointerDown(screen.getByRole('button',{name:/^notes/}));
  expect(screen.queryByRole('group',{name:'logs'})).toBeNull();
  expect(select).not.toHaveBeenCalled();
});
it('asks before closing, names the tab, and closes only on confirmation',async()=>{
  vi.useFakeTimers();
  const edit=vi.fn(async()=>false);
  render(<MultiplexerTabStrip strip={herdr} onSelect={vi.fn()} onEdit={edit}/>);
  hold(screen.getByRole('button',{name:/^logs/}),600);
  fireEvent.click(screen.getByRole('button',{name:'Close'}));
  const dialog=screen.getByRole('alertdialog',{name:'Close logs'});
  expect(within(dialog).getByText('Close \u201clogs\u201d? Programs running in it will end.')).toBeTruthy();
  // A confirmation has no name field, so it never opens the soft keyboard, and nothing has been sent yet.
  expect(within(dialog).queryByRole('textbox')).toBeNull();
  expect(edit).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(edit).not.toHaveBeenCalled();
  hold(screen.getByRole('button',{name:/^logs/}),600);
  fireEvent.click(screen.getByRole('button',{name:'Close'}));
  await act(async()=>{fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Close'}));});
  expect(edit).toHaveBeenCalledExactlyOnceWith({kind:'herdr',type:'closeTab',target:'t2'},'','.');
  // The command failed: the confirmation stays for another try, and a success dismisses it.
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  edit.mockResolvedValue(true);
  await act(async()=>{fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Close'}));});
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('never offers to close the only tab, and a long press on it goes straight to the rename prompt',()=>{
  vi.useFakeTimers();
  const only=herdrStrip({workspaces:[{workspace_id:'w1',label:'Dev',focused:true,agent_status:'idle'}],tabs:[{workspace_id:'w1',tab_id:'t1',label:'solo',number:1,focused:true,agent_status:'idle'}],panes:[]})!;
  render(<MultiplexerTabStrip strip={only} onSelect={vi.fn()} onEdit={vi.fn(async()=>true)}/>);
  hold(screen.getByRole('button',{name:/^solo/}),600);
  expect(screen.getByRole('form',{name:'Rename solo'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Close'})).toBeNull();
});
it('offers a Zellij tab the same menu once Zellij reports its stable id',()=>{
  vi.useFakeTimers();
  const edit=vi.fn(async()=>true);
  render(<MultiplexerTabStrip strip={zellijStrip('s',[{position:0,name:'shell',active:true,id:4},{position:1,name:'logs',active:false,id:9}])} onSelect={vi.fn()} onEdit={edit}/>);
  hold(screen.getByRole('button',{name:/^logs/}),600);
  fireEvent.click(screen.getByRole('button',{name:'Rename'}));
  fireEvent.change(screen.getByLabelText('Name'),{target:{value:'api'}});
  fireEvent.submit(screen.getByRole('form',{name:'Rename logs'}));
  expect(edit).toHaveBeenCalledExactlyOnceWith({kind:'zellij',type:'renameTab',id:9},'api','.');
});
it('creates a tab from the plus with a name and a directory, and keeps the prompt open when the command fails',async()=>{
  const edit=vi.fn(async()=>false);
  render(<MultiplexerTabStrip strip={tmuxStrip({generation:'g'.repeat(36),current:{sessionId:'$1',windowId:'@1'},sessions:[{id:'$1',name:'work',restoreName:null,windows:[{id:'@1',index:0,name:'zsh'}]}]})!} onSelect={vi.fn()} onEdit={edit}/>);
  fireEvent.click(screen.getByRole('button',{name:'New tab'}));
  const form=screen.getByRole('form',{name:'New tab'});
  const save=within(form).getByRole('button',{name:'Save'}) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(within(form).getByLabelText('Name'),{target:{value:'logs'}});
  fireEvent.change(within(form).getByLabelText('Directory'),{target:{value:'/srv/app'}});
  await act(async()=>{fireEvent.submit(form);});
  expect(edit).toHaveBeenCalledExactlyOnceWith({kind:'tmux',type:'createWindow',target:'$1'},'logs','/srv/app');
  expect(screen.getByRole('form',{name:'New tab'})).toBeTruthy();
  edit.mockResolvedValue(true);
  await act(async()=>{fireEvent.submit(form);});
  expect(screen.queryByRole('form')).toBeNull();
});
it('closes the prompt on Escape or Cancel but keeps a half-typed name through an outside press',()=>{
  render(<><MultiplexerTabStrip strip={herdr} onSelect={vi.fn()} onEdit={vi.fn(async()=>true)}/><button>outside</button></>);
  fireEvent.click(screen.getByRole('button',{name:'New tab'}));
  fireEvent.pointerDown(screen.getByText('outside'));
  expect(screen.getByRole('form')).toBeTruthy();
  fireEvent.keyDown(document.body,{key:'Escape'});
  expect(screen.queryByRole('form')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'New tab'}));
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(screen.queryByRole('form')).toBeNull();
});
