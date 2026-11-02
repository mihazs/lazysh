// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import type {ComponentProps} from 'react';
import WorkspaceSessions from './WorkspaceSessions';

afterEach(cleanup);
const sessions=[
  {id:'review',name:'Review terminal',destination:'review.invalid',connected:true},
  {id:'build',name:'Build terminal',destination:'build.invalid',connected:true},
  {id:'closed',name:'Closed terminal',destination:'closed.invalid',connected:false},
];
function props(patch:Partial<ComponentProps<typeof WorkspaceSessions>>={}) {
  return {sessions,activeId:'build',compact:true,visible:true,busy:false,onChoose:vi.fn(),...patch};
}
it('discloses only connected choices and respects a pending session operation',()=>{
  const state=props(),view=render(<WorkspaceSessions {...state}/>);
  const trigger=screen.getByRole('button',{name:/Live app sessions · 2.*Build terminal/});
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('group')).toBeNull();fireEvent.click(trigger);
  const target=screen.getByRole('button',{name:'Review terminal review.invalid'});
  expect(screen.queryByRole('button',{name:/Closed terminal/})).toBeNull();
  view.rerender(<WorkspaceSessions {...state} busy/>);fireEvent.click(target);expect(state.onChoose).not.toHaveBeenCalled();
  view.rerender(<WorkspaceSessions {...state}/>);fireEvent.click(target);expect(state.onChoose).toHaveBeenCalledExactlyOnceWith('review');
});
it('preserves disclosure and row identity across navigation and same-session metadata updates',()=>{
  const state=props(),view=render(<WorkspaceSessions {...state}/>);
  fireEvent.click(screen.getByRole('button',{name:/Live app sessions · 2/}));
  const row=screen.getByRole('button',{name:'Build terminal build.invalid'});
  view.rerender(<WorkspaceSessions {...state} visible={false}/>);expect(row.isConnected).toBe(true);
  view.rerender(<WorkspaceSessions {...state} sessions={sessions.map(session=>session.id==='build'?{...session,name:'Build renamed'}:session)}/>);
  expect(screen.getByRole('button',{name:'Build renamed build.invalid'})).toBe(row);
  expect(screen.getByRole('button',{name:/Live app sessions · 2.*Build renamed/}).getAttribute('aria-expanded')).toBe('true');
});
it('keeps desktop choices expanded and restores focus when a compact layout hides the focused row',()=>{
  const state=props({compact:false}),view=render(<WorkspaceSessions {...state}/>);
  const row=screen.getByRole('button',{name:'Review terminal review.invalid'});row.focus();
  view.rerender(<WorkspaceSessions {...state} compact visible={false}/>);expect(document.activeElement).toBe(row);
  view.rerender(<WorkspaceSessions {...state}/>);row.focus();
  view.rerender(<WorkspaceSessions {...state} compact/>);
  expect(document.activeElement).toBe(screen.getByRole('button',{name:/Live app sessions · 2/}));
  view.rerender(<WorkspaceSessions {...state} sessions={[]}/>);
  expect(screen.getByRole('group').textContent).toContain('Connect to a host');
  expect(screen.queryByRole('button')).toBeNull();
});
