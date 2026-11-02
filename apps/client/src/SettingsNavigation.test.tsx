// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import SettingsNavigation from './SettingsNavigation';

afterEach(cleanup);
it('routes Back and Escape through parents, preserves mounted drafts and reading position, and restores list focus',()=>{
  const {container}=render(<div role="dialog" aria-modal="true"><div className="dialog-content"><SettingsNavigation pages={[
    {id:'input',title:'Input',content:<p>Input controls</p>},
    {id:'snippets',title:'Snippets',parent:'input',content:<label>Draft<textarea defaultValue=""/></label>},
  ]}/></div></div>);
  const scroller=container.querySelector('.dialog-content')!;
  const input=screen.getByRole('button',{name:'Input'});fireEvent.click(input);
  const snippets=screen.getByRole('button',{name:'Snippets'});fireEvent.click(snippets);
  const draft=screen.getByRole('textbox',{name:'Draft'});fireEvent.change(draft,{target:{value:'unsent'}});scroller.scrollTop=238;
  const back=new Event('lazysh-workspace-back',{cancelable:true});fireEvent(window,back);
  expect(back.defaultPrevented).toBe(true);expect(document.activeElement).toBe(snippets);expect(scroller.scrollTop).toBe(0);
  fireEvent.click(snippets);expect(scroller.scrollTop).toBe(238);expect(screen.getByRole('textbox',{name:'Draft'})).toBe(draft);expect(draft).toHaveProperty('value','unsent');
  fireEvent.keyDown(draft,{key:'Escape'});expect(document.activeElement).toBe(snippets);
  fireEvent.click(screen.getByRole('button',{name:'Back'}));expect(document.activeElement).toBe(input);
  const rootBack=new Event('lazysh-workspace-back',{cancelable:true});fireEvent(window,rootBack);expect(rootBack.defaultPrevented).toBe(false);
});
it('does not intercept Back addressed to another topmost dialog',()=>{
  render(<><div role="dialog" aria-modal="true"><SettingsNavigation pages={[{id:'input',title:'Input',content:<p>Controls</p>}]}/></div><div role="dialog" aria-modal="true" aria-label="Review"/></>);
  fireEvent.click(screen.getByRole('button',{name:'Input'}));
  const back=new Event('lazysh-workspace-back',{cancelable:true});fireEvent(window,back);
  expect(back.defaultPrevented).toBe(false);expect(screen.getByRole('heading',{name:'Input'})).toBeTruthy();
});
