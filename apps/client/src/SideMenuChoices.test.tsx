// @vitest-environment jsdom
import {createPortal} from 'react-dom';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {SideMenuChoices} from './SideMenuChoices';

afterEach(cleanup);

describe('side menu choices',()=>{
  it('ends the visit after a button inside it, including one portaled in from the terminal, and not after other taps',()=>{
    const onChoose=vi.fn();
    function Harness() {
      // The terminal renders its controls from elsewhere in the React tree, into the node the menu lends it.
      return <>
        <SideMenuChoices onChoose={onChoose}><p>Session</p><div data-testid="target"/></SideMenuChoices>
        <TerminalControls/>
      </>;
    }
    function TerminalControls() {
      const target=document.querySelector('[data-testid="target"]');
      return target?createPortal(<button type="button">Compose</button>,target):null;
    }
    const {rerender}=render(<Harness/>);
    rerender(<Harness/>);
    fireEvent.click(screen.getByText('Session'));
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Compose'}));
    expect(onChoose).toHaveBeenCalledOnce();
  });
});
