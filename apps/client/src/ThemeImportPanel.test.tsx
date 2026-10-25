// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import ThemeImportPanel from './ThemeImportPanel';
import {defaults} from './preferences';
afterEach(cleanup);
it('requires preview and explicit apply; input edits invalidate the reviewed candidate',()=>{
  const apply=vi.fn().mockReturnValue(true);
  render(<ThemeImportPanel preferences={defaults} apply={apply} />);
  fireEvent.change(screen.getByLabelText('Theme JSON or share code'),{target:{value:'{"v":1,"name":"Reviewed","mode":"light","colors":{"background":"#fff","foreground":"#111"}}'}});
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));
  expect(screen.getByRole('region',{name:'Theme preview'})).toBeTruthy();expect(apply).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Theme JSON or share code'),{target:{value:'bad'}});
  expect(screen.queryByRole('button',{name:'Apply to app and terminal'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));
  expect(apply).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toContain('valid theme JSON');
  fireEvent.change(screen.getByLabelText('Theme JSON or share code'),{target:{value:'{"background":"#000","foreground":"#fff"}'}});
  fireEvent.click(screen.getByRole('button',{name:'Preview theme'}));
  fireEvent.click(screen.getByRole('button',{name:'Apply to app and terminal'}));
  expect(apply).toHaveBeenCalledExactlyOnceWith({theme:'custom',appTheme:'custom',customTheme:expect.objectContaining({background:'#000000',foreground:'#ffffff',black:'#ffffff',brightBlack:'#ffffff'}),customThemeInfo:{name:'Imported theme',mode:'dark'}});
});
it('does not read or write clipboard on mount, exports only a validated palette',()=>{
  const readText=vi.fn(),writeText=vi.fn();Object.defineProperty(navigator,'clipboard',{value:{readText,writeText},configurable:true});
  render(<ThemeImportPanel preferences={{...defaults,customTheme:{background:'#000000',foreground:'#ffffff'}}} apply={vi.fn()} />);
  expect(readText).not.toHaveBeenCalled();expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Export theme share code'}));
  expect(screen.getByLabelText<HTMLTextAreaElement>('Exported theme').value).toMatch(/^lazysh-theme:/);
  expect(writeText).not.toHaveBeenCalled();
});
it('reviews the saved name and mode and retains the candidate if persistence fails',()=>{
  const apply=vi.fn().mockReturnValue(false);
  render(<ThemeImportPanel preferences={{...defaults,theme:'custom',appTheme:'custom',customTheme:{background:'#ffffff',foreground:'#111111'},customThemeInfo:{name:'Saved daylight',mode:'light'}}} apply={apply} />);
  fireEvent.click(screen.getByRole('button',{name:'Review saved palette'}));
  expect(screen.getByRole('heading',{name:'Saved daylight'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Apply to app and terminal'}));
  expect(apply.mock.calls[0][0].customThemeInfo).toEqual({name:'Saved daylight',mode:'light'});
  expect(screen.getByRole('button',{name:'Apply to app and terminal'})).toBeTruthy();
  expect(screen.queryByText('Theme applied to app and terminal.')).toBeNull();
});
