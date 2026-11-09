// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
import {readSessionViews,saveSessionView,sessionViewKey} from './sessionView';

beforeEach(()=>localStorage.clear());
const work=sessionViewKey({hostId:'host',attached:{kind:'tmux',name:'work'}});

it('remembers each multiplexer target on this device and keeps Terminal as the unstored default',()=>{
  expect(readSessionViews()).toEqual({});
  let views=saveSessionView(readSessionViews(),work,'agent');
  views=saveSessionView(views,sessionViewKey({hostId:'host',attached:{kind:'tmux',name:'other'}}),'both');
  expect(readSessionViews()[work]).toBe('agent');
  expect(readSessionViews()[sessionViewKey({hostId:'host',attached:{kind:'tmux',name:'work',restoreName:'work'}})]).toBe('agent');
  expect(readSessionViews()[sessionViewKey({hostId:'other-host',attached:{kind:'tmux',name:'work'}})]).toBeUndefined();
  saveSessionView(views,work,'terminal');
  expect(readSessionViews()[work]).toBeUndefined();
  expect(Object.keys(readSessionViews())).toHaveLength(1);
});

it('keeps working for this run when device storage is unavailable or damaged',()=>{
  localStorage.setItem('lazysh-session-views','{"a":"agent","b":"unexpected"');
  expect(readSessionViews()).toEqual({});
  localStorage.setItem('lazysh-session-views',JSON.stringify({a:'agent',b:'unexpected'}));
  expect(readSessionViews()).toEqual({a:'agent'});
  const failing=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});
  try {expect(saveSessionView({},work,'both')).toEqual({[work]:'both'});}
  finally {failing.mockRestore();}
});
