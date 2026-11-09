// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
import {readSessionViews,saveSessionView,sessionViewKey} from './sessionView';

beforeEach(()=>localStorage.clear());
const work=sessionViewKey({id:'ssh-1',hostId:'host',attached:{kind:'tmux',name:'work'}});

it('remembers each multiplexer target on this device and keeps Terminal as the unstored default',()=>{
  expect(readSessionViews()).toEqual({});
  let views=saveSessionView(readSessionViews(),work,'agent');
  views=saveSessionView(views,sessionViewKey({id:'ssh-2',hostId:'host',attached:{kind:'tmux',name:'other'}}),'both');
  expect(readSessionViews()[work]).toBe('agent');
  expect(readSessionViews()[sessionViewKey({id:'ssh-3',hostId:'host',attached:{kind:'tmux',name:'work',restoreName:'work'}})]).toBe('agent');
  expect(readSessionViews()[sessionViewKey({id:'ssh-1',hostId:'other-host',attached:{kind:'tmux',name:'work'}})]).toBeUndefined();
  saveSessionView(views,work,'terminal');
  expect(readSessionViews()[work]).toBeUndefined();
  expect(Object.keys(readSessionViews())).toHaveLength(1);
});

it('keeps a plain shell choice to that session for this run, so other and new plain shells on the host open in Terminal',()=>{
  const first=sessionViewKey({id:'ssh-1',hostId:'host'}),second=sessionViewKey({id:'ssh-2',hostId:'host'});
  const views=saveSessionView(readSessionViews(),first,'agent');
  expect(views[first]).toBe('agent');
  expect(views[second]).toBeUndefined();
  // A newly opened plain shell on the same host, also after a restart, finds nothing stored.
  expect(readSessionViews()).toEqual({});
  expect(readSessionViews()[sessionViewKey({id:'ssh-3',hostId:'host'})]).toBeUndefined();
});

it('keeps working for this run when device storage is unavailable or damaged',()=>{
  localStorage.setItem('lazysh-session-views',`{${JSON.stringify(work)}:"agent"`);
  expect(readSessionViews()).toEqual({});
  localStorage.setItem('lazysh-session-views',JSON.stringify({[work]:'agent',b:'unexpected','session:ssh-1':'agent'}));
  expect(readSessionViews()).toEqual({[work]:'agent'});
  const failing=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});
  try {expect(saveSessionView({},work,'both')).toEqual({[work]:'both'});}
  finally {failing.mockRestore();}
});
