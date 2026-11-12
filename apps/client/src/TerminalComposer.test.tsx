// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import TerminalComposer from './TerminalComposer';
afterEach(cleanup);
it('keeps editing separate from explicit Insert and close',()=>{
  const onChange=vi.fn(),onSubmit=vi.fn(),onClose=vi.fn();
  const view=render(<TerminalComposer value="retained draft" onChange={onChange} onSubmit={onSubmit} onClose={onClose} sendEnter={false} disabled/>);
  const editor=screen.getByRole('textbox',{name:'Compose text'});
  fireEvent.change(editor,{target:{value:'two\nlines'}});fireEvent.keyDown(editor,{key:'Enter'});
  expect(onChange).toHaveBeenCalledWith('two\nlines');expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Insert'}));expect(onSubmit).not.toHaveBeenCalled();
  view.rerender(<TerminalComposer value="retained draft" onChange={onChange} onSubmit={onSubmit} onClose={onClose} sendEnter={false} disabled={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Insert'}));expect(onSubmit).toHaveBeenCalledExactlyOnceWith(false);
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
it('offers Send and Insert together and runs the one the click or shortcut names',()=>{
  const onSubmit=vi.fn();
  const view=render(<TerminalComposer value={' \n'} onChange={()=>{}} onSubmit={onSubmit} onClose={()=>{}} sendEnter disabled={false}/>);
  // Whitespace cannot be sent but can still be inserted.
  expect(screen.getByRole('button',{name:'Send'})).toHaveProperty('disabled',true);
  fireEvent.click(screen.getByRole('button',{name:'Insert'}));expect(onSubmit).toHaveBeenLastCalledWith(false);
  view.rerender(<TerminalComposer value="ls" onChange={()=>{}} onSubmit={onSubmit} onClose={()=>{}} sendEnter disabled={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Send'}));expect(onSubmit).toHaveBeenLastCalledWith(true);
  const editor=screen.getByRole('textbox',{name:'Compose text'});
  fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});expect(onSubmit).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true,shiftKey:true});expect(onSubmit).toHaveBeenLastCalledWith(false);
  // The preference only swaps which action the shortcut runs.
  view.rerender(<TerminalComposer value="ls" onChange={()=>{}} onSubmit={onSubmit} onClose={()=>{}} sendEnter={false} disabled={false}/>);
  fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});expect(onSubmit).toHaveBeenLastCalledWith(false);
  fireEvent.keyDown(editor,{key:'Enter',metaKey:true,shiftKey:true});expect(onSubmit).toHaveBeenLastCalledWith(true);
  expect(onSubmit).toHaveBeenCalledTimes(6);
});
it('sends only visible drafts, by button or Ctrl+Enter, and leaves plain Enter and IME commits to the editor',()=>{
  const onSubmit=vi.fn(),onClose=vi.fn();
  const view=render(<TerminalComposer value={' \n\t'} onChange={()=>{}} onSubmit={onSubmit} onClose={onClose} sendEnter disabled={false}/>);
  const send=screen.getByRole('button',{name:'Send'});
  expect(send).toHaveProperty('disabled',true);
  expect(send.getAttribute('title')).toBe('Put the draft on the input line, then press Enter');
  const editor=screen.getByRole('textbox',{name:'Compose text'});
  expect(screen.getByText('3 characters · 2 lines')).toBeTruthy();
  fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});expect(onSubmit).not.toHaveBeenCalled();
  view.rerender(<TerminalComposer value="ls" onChange={()=>{}} onSubmit={onSubmit} onClose={onClose} sendEnter disabled={false}/>);
  expect(send).toHaveProperty('disabled',false);
  fireEvent.keyDown(editor,{key:'Enter'});fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true,keyCode:229});
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});expect(onSubmit).toHaveBeenCalledExactlyOnceWith(true);
  fireEvent.keyDown(editor,{key:'Escape'});expect(onClose).toHaveBeenCalledOnce();
  expect(document.getElementById(editor.getAttribute('aria-describedby')!)?.textContent).toBe('Ctrl+Enter to send · Ctrl+Shift+Enter to insert');
});
it('clears the draft explicitly and keeps focus in the editor',()=>{
  const onChange=vi.fn();
  const view=render(<TerminalComposer value="" onChange={onChange} onSubmit={()=>{}} onClose={()=>{}} sendEnter disabled={false}/>);
  expect(screen.getByRole('button',{name:'Clear draft'})).toHaveProperty('disabled',true);
  view.rerender(<TerminalComposer value="keep?" onChange={onChange} onSubmit={()=>{}} onClose={()=>{}} sendEnter disabled={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Clear draft'}));
  expect(onChange).toHaveBeenCalledWith('');expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'Compose text'}));
});
it('shows attachment tokens as labelled chips that delete atomically with their attachment',()=>{
  const attachments=[
    {number:1,kind:'image' as const,path:'/tmp/one.png',name:'one.png'},
    {number:2,kind:'file' as const,path:'/tmp/notes.txt',name:'notes.txt'},
  ];
  function Harness() {
    const [value,setValue]=useState('[Image #1] [File #2] compare');
    return <TerminalComposer value={value} onChange={setValue} onSubmit={()=>{}} onClose={()=>{}} sendEnter disabled={false} attachments={attachments.filter(item=>value.includes(`[${item.kind==='image'?'Image':'File'} #${item.number}]`))}/>;
  }
  render(<Harness/>);
  const chips=screen.getByRole('list',{name:'Draft attachments'});
  expect(within(chips).getAllByRole('button').map(button=>button.getAttribute('aria-label'))).toEqual(['Image #1: one.png. Show preview','Remove Image #1','File #2: notes.txt. Show preview','Remove File #2']);
  fireEvent.click(screen.getByRole('button',{name:'File #2: notes.txt. Show preview'}));
  expect(screen.getByRole('figure',{name:'Preview of File #2'}).textContent).toContain("'/tmp/notes.txt'");
  const editor=screen.getByRole('textbox',{name:'Compose text'}) as HTMLTextAreaElement;
  // Backspace after the first token removes only its closing bracket in the browser.
  fireEvent.change(editor,{target:{value:'[Image #1 [File #2] compare'}});
  expect(editor.value).toBe(' [File #2] compare');
  expect(within(chips).queryByRole('button',{name:'Remove Image #1'})).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Image #1 removed from the draft');
  fireEvent.click(screen.getByRole('button',{name:'Remove File #2'}));
  expect(editor.value).toBe(' compare');
  expect(screen.queryByRole('list',{name:'Draft attachments'})).toBeNull();
  expect(screen.queryByRole('figure')).toBeNull();
});
it('removes a whole token when a committed IME composition deleted part of it',()=>{
  const attachments=[{number:1,kind:'image' as const,path:'/tmp/one.png',name:'one.png'}];
  function Harness() {
    const [value,setValue]=useState('look [Image #1] ');
    return <TerminalComposer value={value} onChange={setValue} onSubmit={()=>{}} onClose={()=>{}} sendEnter disabled={false} attachments={attachments.filter(()=>value.includes('[Image #1]'))}/>;
  }
  render(<Harness/>);
  const editor=screen.getByRole('textbox',{name:'Compose text'}) as HTMLTextAreaElement;
  // A composition that only adds text next to a token leaves the token and its chip.
  fireEvent.compositionStart(editor);
  fireEvent.change(editor,{target:{value:'look [Image #1] ok'}});
  fireEvent.compositionEnd(editor);
  expect(editor.value).toBe('look [Image #1] ok');
  expect(screen.getByRole('button',{name:'Remove Image #1'})).toBeTruthy();
  fireEvent.change(editor,{target:{value:'look [Image #1] '}});
  // Gboard reopens composition on the word before the caret, and Backspace removes the bracket mid-composition.
  fireEvent.compositionStart(editor);
  fireEvent.change(editor,{target:{value:'look [Image #1 '}});
  expect(editor.value).toBe('look [Image #1 ');
  fireEvent.compositionEnd(editor);
  expect(editor.value).toBe('look  ');
  expect(editor.selectionStart).toBe(5);
  expect(screen.queryByRole('list',{name:'Draft attachments'})).toBeNull();
});
