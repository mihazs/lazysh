// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import TerminalComposer from './TerminalComposer';
afterEach(cleanup);
it('keeps editing separate from explicit literal paste and close',()=>{
  const onChange=vi.fn(),onPaste=vi.fn(),onClose=vi.fn();
  const view=render(<TerminalComposer value="retained draft" onChange={onChange} onPaste={onPaste} onClose={onClose} disabled/>);
  const editor=screen.getByRole('textbox',{name:'Compose text'});
  fireEvent.change(editor,{target:{value:'two\nlines'}});fireEvent.keyDown(editor,{key:'Enter'});
  expect(onChange).toHaveBeenCalledWith('two\nlines');expect(onPaste).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Paste draft'}));expect(onPaste).not.toHaveBeenCalled();
  view.rerender(<TerminalComposer value="retained draft" onChange={onChange} onPaste={onPaste} onClose={onClose} disabled={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Paste draft'}));expect(onPaste).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Close composer'}));expect(onClose).toHaveBeenCalledTimes(1);expect(editor).toHaveProperty('value','retained draft');
});
it('offers attachments only through the explicitly supplied caller action',()=>{
  const onAttach=vi.fn(),onPaste=vi.fn();
  const view=render(<TerminalComposer value="draft" onChange={()=>{}} onPaste={onPaste} onClose={()=>{}} disabled/>);
  expect(screen.queryByRole('button',{name:'Attach'})).toBeNull();
  view.rerender(<TerminalComposer value="draft" onChange={()=>{}} onPaste={onPaste} onClose={()=>{}} disabled onAttach={onAttach}/>);
  fireEvent.click(screen.getByRole('button',{name:'Attach'}));
  expect(onAttach).toHaveBeenCalledOnce();expect(onPaste).not.toHaveBeenCalled();
});
