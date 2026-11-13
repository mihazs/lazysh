// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import AgentPasted from './AgentPasted';
import {uiI18n} from './i18n/core';

afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
const text=['one','two','three','four','five'].join('\n');

it('shows the first lines, expands and collapses, and keeps a short paste whole',()=>{
  const {container}=render(<AgentPasted text={text}/>);
  expect(container.querySelector('pre')!.textContent).toBe('one\ntwo\nthree…');
  fireEvent.click(screen.getByRole('button',{name:'Show all'}));
  expect(container.querySelector('pre')!.textContent).toBe(text);
  fireEvent.click(screen.getByRole('button',{name:'Show less'}));
  expect(container.querySelector('pre')!.textContent).toBe('one\ntwo\nthree…');
  cleanup();
  render(<AgentPasted text="short"/>);
  expect(screen.queryByRole('button',{name:'Show all'})).toBeNull();
});

it('names the block and its actions in each language',async()=>{
  for(const [language,title,copy] of [['pt-BR','Texto colado','Copiar texto colado'],['es','Texto pegado','Copiar texto pegado'],['en','Pasted text','Copy pasted text']]) {
    await act(async()=>{await uiI18n.changeLanguage(language);});
    cleanup();render(<AgentPasted text={text}/>);
    expect(screen.getByRole('region',{name:title})).toBeTruthy();
    expect(screen.getByRole('button',{name:copy})).toBeTruthy();
  }
});
