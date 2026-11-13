// @vitest-environment jsdom
import {useState} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import BottomMenu from './BottomMenu';
import {defaults,savePreferences} from './preferences';

beforeEach(()=>savePreferences({...defaults}));
afterEach(cleanup);
function Harness({keyboard,onComposer=vi.fn(),onToolbar=vi.fn(),start=true}:{keyboard?:{open:boolean;onToggle:()=>void};onComposer?:()=>void;onToolbar?:()=>void;start?:boolean}) {
  const [open,setOpen]=useState(start);
  return <><output>{open?'open':'closed'}</output><BottomMenu open={open} onOpenChange={setOpen} composing={false} onToggleComposer={onComposer} toolbarVisible onToggleToolbar={onToolbar} keyboard={keyboard} /></>;
}
const state=()=>screen.getByRole('status',{hidden:true}).textContent;

describe('bottom menu',()=>{
  it('names the composer and toolbar actions from their current state and closes after each',()=>{
    const onComposer=vi.fn(),onToolbar=vi.fn();
    render(<Harness onComposer={onComposer} onToolbar={onToolbar} />);
    expect(screen.queryByRole('button',{name:'Show keyboard'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Show composer'}));
    expect(onComposer).toHaveBeenCalledOnce();expect(state()).toBe('closed');
    cleanup();
    render(<Harness onToolbar={onToolbar} />);
    fireEvent.click(screen.getByRole('button',{name:'Hide toolbar'}));
    expect(onToolbar).toHaveBeenCalledOnce();expect(state()).toBe('closed');
  });
  it('shows the keyboard button only when the platform has one, with its current state',()=>{
    const onToggle=vi.fn();
    const {rerender}=render(<Harness keyboard={{open:false,onToggle}} />);
    fireEvent.click(screen.getByRole('button',{name:'Show keyboard'}));
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(<Harness keyboard={{open:true,onToggle}} />);
    expect(screen.getByRole('button',{name:'Hide keyboard',hidden:true})).toBeTruthy();
  });
  it('closes on Escape, the grip and a press outside, and a closed menu is inert',()=>{
    const {container}=render(<Harness />);
    fireEvent.keyDown(window,{key:'Escape'});expect(state()).toBe('closed');
    expect(container.querySelector('.bottom-menu')!.hasAttribute('inert')).toBe(true);
    cleanup();
    render(<Harness />);fireEvent.click(screen.getByRole('button',{name:'Close bottom menu'}));expect(state()).toBe('closed');
    cleanup();
    const view=render(<Harness />);const scrim=view.container.querySelector('.bottom-menu-scrim')!;
    // A touch the system takes (the Back gesture starts on the scrim) must leave the menu open, so Back can still close it.
    fireEvent.pointerDown(scrim);fireEvent.pointerCancel(scrim);expect(state()).toBe('open');
    fireEvent.click(scrim);expect(state()).toBe('closed');
  });
  it('shows the handle where the swipe starts, and a visible button instead when the swipe is switched off',()=>{
    const view=render(<Harness start={false} />);
    expect(document.querySelector('.gesture-handle')).not.toBeNull();
    expect(screen.queryByRole('button',{name:'Open bottom menu'})).toBeNull();
    view.unmount();
    savePreferences({...defaults,edgeGestures:{leftMenu:true,bottomMenu:false,viewSwitch:true,zoneWidth:24}});
    const off=render(<Harness start={false} />);
    expect(document.querySelector('.gesture-handle')).toBeNull();
  });
});
