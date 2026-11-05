// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
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
it('groups root rows under section headers with value previews, action rows and a destructive row',()=>{
  const opened:string[]=[];
  render(<div role="dialog" aria-modal="true"><SettingsNavigation footer="lazysh 1.0.0" sections={[{id:'terminal',title:'Terminal'},{id:'help',title:'Help'},{id:'reset',footer:'Restores defaults.'}]} pages={[
    {id:'appearance',section:'terminal',title:'Appearance',value:'forest · 14 px',content:<p>Appearance controls</p>},
    {id:'about',section:'help',title:'About',onSelect:()=>opened.push('about')},
    {id:'voice',section:'help',title:'Voice',disabled:true,value:'Open a session first',onSelect:()=>opened.push('voice')},
    {id:'reset',section:'reset',tone:'danger',title:'Reset',content:<button type="button">Reset everything</button>},
  ]}/></div>);
  const terminal=screen.getByRole('region',{name:'Terminal'});
  const appearance=within(terminal).getByRole('button',{name:'Appearance'});
  expect(appearance.getAttribute('aria-describedby')&&document.getElementById(appearance.getAttribute('aria-describedby')!)?.textContent).toBe('forest · 14 px');
  expect(within(screen.getByRole('region',{name:'Help'})).getAllByRole('button').map(button=>button.textContent)).toEqual(['About','VoiceOpen a session first']);
  fireEvent.click(screen.getByRole('button',{name:'About'}));
  fireEvent.click(screen.getByRole('button',{name:'Voice'}));
  expect(opened).toEqual(['about']);
  expect(screen.queryByRole('heading',{name:'About'})).toBeNull();
  expect(screen.getByText('Restores defaults.')).toBeTruthy();expect(screen.getByText('lazysh 1.0.0')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Reset'}));
  expect(screen.getByRole('heading',{name:'Reset'})).toBeTruthy();
});
it('searches setting names inside hidden pages, opens the match and clears with Escape before leaving',()=>{
  render(<div role="dialog" aria-modal="true"><div className="dialog-content"><SettingsNavigation sections={[{id:'input',title:'Input'}]} pages={[
    {id:'terminal',section:'input',title:'Terminal',content:<><label>Cursor<select defaultValue="bar"><option value="bar">Bar cursor shape</option></select></label><details><summary>Imported fonts</summary><label>Import font file<input type="file"/></label></details></>},
    {id:'input',section:'input',title:'Keyboard',content:<label><input type="checkbox"/>Use Option as Meta</label>},
    {id:'snippets',parent:'input',title:'Text snippets',content:<label>Snippet name<input/></label>},
  ]}/></div></div>);
  const field=screen.getByRole('searchbox',{name:'Search settings'});
  fireEvent.change(field,{target:{value:'shape'}});
  expect(screen.getByRole('status').textContent).toBe('No settings match “shape”.');
  fireEvent.change(field,{target:{value:'FONT'}});
  const results=screen.getByRole('navigation',{name:'Search results'});
  expect(within(results).getAllByRole('button').map(button=>button.getAttribute('aria-labelledby')&&document.getElementById(button.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['Imported fonts','Import font file']);
  fireEvent.click(within(results).getByRole('button',{name:'Import font file'}));
  const details=screen.getByText('Imported fonts',{selector:'summary'}).closest('details')!;
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(details.querySelector('input'));
  fireEvent.change(field,{target:{value:'snippet'}});
  const snippet=within(screen.getByRole('navigation',{name:'Search results'})).getByRole('button',{name:'Text snippets'});
  expect(document.getElementById(snippet.getAttribute('aria-describedby')!)?.textContent).toBe('Keyboard › Text snippets');
  fireEvent.click(snippet);
  expect(screen.getByRole('heading',{name:'Text snippets'})).toBeTruthy();
  field.focus();
  const clearing=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});act(()=>{field.dispatchEvent(clearing);});
  expect(clearing.defaultPrevented).toBe(true);expect(field).toHaveProperty('value','');
  expect(screen.getByRole('heading',{name:'Text snippets'})).toBeTruthy();
  fireEvent.keyDown(field,{key:'Escape'});
  expect(screen.queryByRole('heading',{name:'Text snippets'})).toBeNull();
  expect(screen.getByRole('heading',{name:'Keyboard'})).toBeTruthy();
});
