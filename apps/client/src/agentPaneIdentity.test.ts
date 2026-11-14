import {expect,it} from 'vitest';
import {zellijPane} from './agentPaneIdentity';

it('reads the session and the pane number of a Zellij report, session names with colons included',()=>{
  expect(zellijPane('zellij:work:3')).toEqual({session:'work',pane:3});
  expect(zellijPane('zellij:my:odd name:12')).toEqual({session:'my:odd name',pane:12});
});
it.each(['%4','zellij:work','zellij::3','zellij:work:terminal_3','zellij:work:-1','zellij:work:12345678901',null,undefined,''])('does not take %s for a Zellij pane',id=>{
  expect(zellijPane(id)).toBeUndefined();
});
