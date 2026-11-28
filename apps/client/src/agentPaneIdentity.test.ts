import {expect,it} from 'vitest';
import {attachedPaneServer,herdrPaneOf,paneAgent,validPaneIdentity,zellijPane} from './agentPaneIdentity';
import type {AgentSession} from './AgentPanel';

it('reads the session and the pane number of a Zellij report, session names with colons included',()=>{
  expect(zellijPane('zellij:work:3')).toEqual({session:'work',pane:3});
  expect(zellijPane('zellij:my:odd name:12')).toEqual({session:'my:odd name',pane:12});
});
it.each(['%4','zellij:work','zellij::3','zellij:work:terminal_3','zellij:work:-1','zellij:work:12345678901',null,undefined,''])('does not take %s for a Zellij pane',id=>{
  expect(zellijPane(id)).toBeUndefined();
});
it.each(['%0','%7','zellij:work:3','zellij:my:odd name:12','herdr:default:w3V:p1','herdr:work-2.a_b:w2E:pF'])('names %s as a pane an approval can be bound to',id=>{
  expect(validPaneIdentity(id)).toBe(true);
});
it.each(['','%','%7;cmd','7','zellij:work','zellij:work:x','zellij:bad\u0085name:2',`zellij:${'a'.repeat(201)}:2`,'herdr:default:p1','herdr:default:w3V:p1:x','herdr::w3V:p1','herdr:..:w3V:p1','herdr:a:b:w3V:p1','herdr:default:w3v:p1',`herdr:${'a'.repeat(65)}:w1:p1`,'w3V:p1'])('does not bind an approval to %s',id=>{
  expect(validPaneIdentity(id)).toBe(false);
});

const report=(over:Partial<AgentSession>):AgentSession=>({sessionId:'s',agent:'Codex',project:'/work',state:'working',updatedAt:'2026-11-15T12:00:00.000Z',summary:'Working',paneId:'%4',eventCount:1,...over});
it('names the agent of the newest report that carries the pane, and none once that session ended',()=>{
  expect(paneAgent([report({agent:'Codex'}),report({agent:'Claude Code'})],'%4')).toBe('Codex');
  expect(paneAgent([report({summary:'Session ended'}),report({agent:'Older'})],'%4')).toBeNull();
  expect(paneAgent([report({paneId:null}),report({paneId:'zellij:work:4'}),report({paneId:'%40'})],'%4')).toBeNull();
  expect(paneAgent([],'%4')).toBeNull();
});
it('ignores the report of another server for the same pane id, and keeps one from a companion that names no server',()=>{
  const work=report({agent:'Claude Code',paneServer:'tmux:work'}),other=report({agent:'Codex',paneServer:'tmux:default'}),legacy=report({agent:'Older'});
  expect(paneAgent([other,work],'%4','tmux:work')).toBe('Claude Code');
  expect(paneAgent([other],'%4','tmux:work')).toBeNull();
  expect(paneAgent([other,legacy],'%4','tmux:work')).toBe('Older');
  expect(paneAgent([work],'%4','rmux:work')).toBeNull();
});
it('names the server a display is attached to as the companion records it',()=>{
  expect(attachedPaneServer({kind:'tmux'})).toBe('tmux:default');
  expect(attachedPaneServer({kind:'rmux',tmuxServer:'work'})).toBe('rmux:work');
  expect(attachedPaneServer({kind:'zellij'})).toBeUndefined();
  expect(attachedPaneServer(undefined)).toBeUndefined();
});
it('reads the session and pane id of a Herdr report',()=>{
  expect(herdrPaneOf('herdr:work:w3V:p1')).toEqual({session:'work',pane:'w3V:p1'});
  for(const id of ['herdr:..:w3V:p1','herdr:work:p1','%4',null])expect(herdrPaneOf(id)).toBeUndefined();
});
