// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import AgentToolCard,{parseAgentTool} from './AgentToolCard';
import {uiI18n} from './i18n/core';

afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
const edit={type:'tool',name:'fileChange',summary:'before.rs',status:'ok',call:{kind:'edit',path:'before.rs',movePath:'after.rs',added:2,removed:1,hunks:['@@ -1 +1,2 @@\n-old\n+new\n+extra'],created:false}};
const command={type:'tool',name:'command',summary:'command',status:'error',input:'false',result:'recorded failure',call:{kind:'execute',command:'false',exitCode:1}};

it('shows the recorded edit counts and hunks without applying them',()=>{
  const tool=parseAgentTool(edit)!;render(<AgentToolCard tool={tool}/>);
  expect(screen.getByText(/before\.rs/).textContent).toContain('+2 −1');
  expect(screen.getByText(/after\.rs/)).toBeTruthy();
  fireEvent.click(screen.getByText(/before\.rs/));
  expect(screen.getByText(/\+extra/).textContent).toContain('-old');
});

it('shows command, exit and output with distinct denial and reactive locales',async()=>{
  const tool=parseAgentTool(command)!;const view=render(<AgentToolCard tool={tool}/>);
  expect(screen.getByText(/Failed/)).toBeTruthy();
  fireEvent.click(screen.getByText(/Failed/));
  expect(screen.getByText('false')).toBeTruthy();expect(screen.getByText('Exit code: 1')).toBeTruthy();
  expect(screen.getByText('recorded failure')).toBeTruthy();
  view.rerender(<AgentToolCard tool={{...tool,status:'denied'}}/>);
  expect(screen.getByText(/Denied/)).toBeTruthy();
  expect(screen.getByText(/Denied/).closest('details')?.open).toBe(true);
  await act(async()=>{await uiI18n.changeLanguage('es');});expect(screen.getByText(/Denegado/)).toBeTruthy();
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});expect(screen.getByText(/Negado/)).toBeTruthy();
});

it('labels a successful background launch without claiming the process finished',()=>{
  const tool=parseAgentTool({...command,status:'ok',call:{kind:'execute',command:'sleep 10',background:true}})!;
  render(<AgentToolCard tool={tool}/>);
  expect(screen.getByText(/Started in the background/)).toBeTruthy();
  expect(screen.queryByText(/Completed/)).toBeNull();
});

it('keeps recorded execute and edit inputs behind a closed disclosure',()=>{
  const input=JSON.stringify({command:'false',description:'Check the fixture',timeout:5000});
  const {container,rerender}=render(<AgentToolCard key="command" tool={parseAgentTool({...command,input})!}/>);
  const receipt=container.querySelector('details')!;
  expect(receipt.open).toBe(false);
  const disclosure=screen.getByText('Recorded input').closest('details')!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(receipt.querySelector('summary')!);fireEvent.click(disclosure.querySelector('summary')!);
  expect(screen.getByText(input)).toBeTruthy();
  const editInput=JSON.stringify({file_path:'before.rs',replace_all:true});
  rerender(<AgentToolCard key="edit" tool={parseAgentTool({...edit,input:editInput})!}/>);
  const editDisclosure=screen.getByText('Recorded input').closest('details')!;
  expect(editDisclosure.open).toBe(false);
  fireEvent.click(editDisclosure.querySelector('summary')!);expect(screen.getByText(editInput)).toBeTruthy();
  rerender(<AgentToolCard tool={parseAgentTool({...command,input:'false'})!}/>);
  expect(screen.queryByText('Recorded input')).toBeNull();
});

it.each([
  ['Read',{kind:'read',path:'src/example.rs'},'src/example.rs'],
  ['Grep',{kind:'search',query:'needle in code'},'needle in code'],
  ['WebFetch',{kind:'fetch',url:'https://example.test/article'},'https://example.test/article'],
  ['Agent',{kind:'task',agent:'reviewer',agentId:'child',ongoing:false},'reviewer'],
])('shows recorded %s detail while the card is collapsed',(name,call,detail)=>{
  const tool=parseAgentTool({type:'tool',name,summary:name,status:'ok',input:'original input',result:'original result',call})!;
  const {container}=render(<AgentToolCard tool={tool}/>);
  expect(container.querySelector('summary')?.textContent).toContain(detail);
  expect(container.querySelector('details')?.open).toBe(false);
  expect(container.querySelector('a, img, script')).toBeNull();
});

it('keeps long or multiline summary details bounded without changing the recorded command',()=>{
  const text='😀'.repeat(200)+'\nlast';
  const tool=parseAgentTool({...command,call:{kind:'execute',command:text}})!;
  const {container}=render(<AgentToolCard tool={tool}/>);
  const summary=container.querySelector('summary')!;
  expect(summary.textContent).toContain('😀'.repeat(160)+'…');
  expect(summary.textContent).not.toContain('last');
  fireEvent.click(summary);
  expect(container.querySelector('pre')?.textContent).toBe(text);
});

it('rejects malformed card fields and leaves other kinds to their own parser',()=>{
  for(const bad of [
    {...command,status:'unknown'}, {...command,result:42}, {...command,call:{...command.call,exitCode:'0'}},
    {...command,call:{...command.call,exitCode:2147483648}}, {...command,call:{...command.call,background:'yes'}},
    {...edit,call:{...edit.call,added:-1}}, {...edit,call:{...edit.call,hunks:['x',{}]}},
    {...edit,call:{...edit.call,path:'bad\npath'}}, {...edit,call:{kind:'future'}},
    {...command,call:{...command.call,unexpected:true}},
  ]) expect(parseAgentTool(bad)).toBeNull();
});
