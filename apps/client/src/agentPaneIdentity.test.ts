import {expect,it} from 'vitest';
import {herdrPaneIdentity,validPaneIdentity,zellijPane} from './agentPaneIdentity';

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
it('names a Herdr pane the way a hook records it, which a hook identity can be bound to',()=>{
  expect(herdrPaneIdentity('default','w3V:p1')).toBe('herdr:default:w3V:p1');
  expect(validPaneIdentity(herdrPaneIdentity('work-2.a_b','w1:p2'))).toBe(true);
});
