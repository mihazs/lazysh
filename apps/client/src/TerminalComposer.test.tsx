// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import TerminalComposer from './TerminalComposer';
afterEach(cleanup);
it('keeps editing separate from explicit literal paste and close',()=>{
  const onChange=vi.fn(),onSubmit=vi.fn(),onClose=vi.fn();
  const view=render(<TerminalComposer value="retained draft" onChange={onChange} onSubmit={onSubmit} onClose={onClose} sendEnter={false} disabled/>);
  const editor=screen.getByRole('textbox',{name:'Compose text'});
  fireEvent.change(editor,{target:{value:'two\nlines'}});fireEvent.keyDown(editor,{key:'Enter'});
  expect(onChange).toHaveBeenCalledWith('two\nlines');expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Paste draft'}));expect(onSubmit).not.toHaveBeenCalled();
  view.rerender(<TerminalComposer value="retained draft" onChange={onChange} onSubmit={onSubmit} onClose={onClose} sendEnter={false} disabled={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Paste draft'}));expect(onSubmit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Close composer'}));expect(onClose).toHaveBeenCalledTimes(1);expect(editor).toHaveProperty('value','retained draft');
});
it('offers attachments only through the explicitly supplied caller action',()=>{
  const onAttach=vi.fn(),onSubmit=vi.fn();
  const view=render(<TerminalComposer value="draft" onChange={()=>{}} onSubmit={onSubmit} onClose={()=>{}} sendEnter disabled/>);
  expect(screen.queryByRole('button',{name:'Attach'})).toBeNull();
  view.rerender(<TerminalComposer value="draft" onChange={()=>{}} onSubmit={onSubmit} onClose={()=>{}} sendEnter disabled onAttach={onAttach}/>);
  fireEvent.click(screen.getByRole('button',{name:'Attach'}));
  expect(onAttach).toHaveBeenCalledOnce();expect(onSubmit).not.toHaveBeenCalled();
});
it('sends only visible drafts, by button or Ctrl+Enter, and leaves plain Enter and IME commits to the editor',()=>{
  const onSubmit=vi.fn(),onClose=vi.fn();
  const view=render(<TerminalComposer value={' \n\t'} onChange={()=>{}} onSubmit={onSubmit} onClose={onClose} sendEnter disabled={false}/>);
  const send=screen.getByRole('button',{name:'Send'});
  expect(send).toHaveProperty('disabled',true);
  expect(send.getAttribute('title')).toBe('Paste the draft, then press Enter');
  const editor=screen.getByRole('textbox',{name:'Compose text'});
  expect(screen.getByText('3 characters · 2 lines')).toBeTruthy();
  fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});expect(onSubmit).not.toHaveBeenCalled();
  view.rerender(<TerminalComposer value="ls" onChange={()=>{}} onSubmit={onSubmit} onClose={onClose} sendEnter disabled={false}/>);
  expect(send).toHaveProperty('disabled',false);
  fireEvent.keyDown(editor,{key:'Enter'});fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true,keyCode:229});
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});expect(onSubmit).toHaveBeenCalledOnce();
  fireEvent.keyDown(editor,{key:'Escape'});expect(onClose).toHaveBeenCalledOnce();
  expect(document.getElementById(editor.getAttribute('aria-describedby')!)?.textContent).toBe('Ctrl+Enter to send');
});
it('clears the draft explicitly and keeps focus in the editor',()=>{
  const onChange=vi.fn();
  const view=render(<TerminalComposer value="" onChange={onChange} onSubmit={()=>{}} onClose={()=>{}} sendEnter disabled={false}/>);
  expect(screen.getByRole('button',{name:'Clear draft'})).toHaveProperty('disabled',true);
  view.rerender(<TerminalComposer value="keep?" onChange={onChange} onSubmit={()=>{}} onClose={()=>{}} sendEnter disabled={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Clear draft'}));
  expect(onChange).toHaveBeenCalledWith('');expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'Compose text'}));
});
