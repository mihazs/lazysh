// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import MultiplexerTabStrip from './MultiplexerTabStrip';
import {herdrStrip,zellijStrip,type MuxStrip} from './multiplexerTabs';

afterEach(cleanup);
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
