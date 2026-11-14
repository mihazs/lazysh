import {expect,it} from 'vitest';
import {projectMessages} from './chatInjected';

const user=(text:string,id='m')=>({id,role:'user',blocks:[{type:'text',text}]});
const project=(text:string)=>projectMessages([user(text)]);

it('shows a background-task notification as one event with the harness event as its text, not as a user message',()=>{
  const [message]=project('<task-notification>\n<task-id>abc</task-id>\n<summary>Monitor event: "Version PRs"</summary>\n<event>version PR #624 checks green</event>\n</task-notification>');
  expect(message.event).toEqual({kind:'task',text:'version PR #624 checks green',detail:'Monitor event: "Version PRs"'});
});

it('shows a finished task with its status and result in the details',()=>{
  const [message]=project('<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n<summary>Agent "review" completed</summary>\n<result>No findings.</result>\n<usage><tool_uses>3</tool_uses></usage>\n</task-notification>');
  expect(message.event).toEqual({kind:'task',text:'Agent "review" completed',detail:'completed\nNo findings.'});
});

it('keeps typed slash commands and shell input as the words the person typed',()=>{
  expect(project('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>')[0].blocks[0].text).toBe('/model opus');
  expect(project('<command-message>ponytail:ponytail</command-message> <command-name>/ponytail:ponytail</command-name> <command-args></command-args>')[0].blocks[0].text).toBe('/ponytail:ponytail');
  expect(project('<bash-input>git pull origin main</bash-input>')[0].blocks[0].text).toBe('! git pull origin main');
});

it('shows command output as one line with the rest in the details and drops empty output',()=>{
  expect(project('<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>')[0].event).toEqual({kind:'output',text:'Set model to `Sonnet 5.5`',detail:undefined});
  expect(project('<bash-stdout>one &lt;two&gt;\nthree</bash-stdout><bash-stderr></bash-stderr>')[0].event).toEqual({kind:'output',text:'one <two>',detail:'one <two>\nthree'});
  expect(project('<local-command-stdout></local-command-stdout>')).toEqual([]);
});

it('drops context written for the model and keeps what the person typed around it',()=>{
  for(const text of ['<system-reminder>Use the tools.</system-reminder>','<local-command-caveat>Not a request.</local-command-caveat>','<environment_context>\n<cwd>/work</cwd>\n</environment_context>',
    '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>x</INSTRUCTIONS>','[Image: original 1080x2340, displayed at 923x2000. Multiply coordinates by 1.17 to map to original image.]'])
    expect(project(text)).toEqual([]);
  expect(project('Fix the build\n<system-reminder>Use the tools.</system-reminder>')[0].blocks[0].text).toBe('Fix the build');
});

it('marks interruptions, compactions and answered questions as events',()=>{
  expect(project('[Request interrupted by user for tool use]')[0].event).toEqual({kind:'interrupted',text:''});
  const summary='This session is being continued from a previous conversation that ran out of context.\n\nSummary: ...';
  expect(project(summary)[0].event).toEqual({kind:'compacted',text:'',detail:summary});
  expect(project('<send_user_message_question_reply>\n[{"answer":"All workers","question":"Which?"}]\n</send_user_message_question_reply>')[0].event).toEqual({kind:'answer',text:'All workers'});
});

it('leaves ordinary messages, tool results, images and assistant text untouched and drops only redacted thinking',()=>{
  const prompt=user('Explain the build <b>now</b>');
  const result={id:'r',role:'user',blocks:[{type:'tool_result',id:'a',text:'<task-notification> in a file'}]};
  const image={id:'i',role:'user',blocks:[{type:'image',text:'Attachment'},{type:'text',text:'[Image: original 1x1, displayed at 1x1.]'}]};
  const answer={id:'a',role:'assistant',blocks:[{type:'text',text:'<task-notification> quoted by the answer'}]};
  const redacted={id:'t',role:'assistant',blocks:[{type:'thinking',text:''}]};
  const mixed={id:'x',role:'assistant',blocks:[{type:'thinking',text:' '},{type:'thinking',text:'Plan'},{type:'text',text:'Done'}]};
  const out=projectMessages([prompt,result,image,answer,redacted,mixed]);
  expect(out.map(message=>message.id)).toEqual(['m','r','i','a','x']);
  expect([out[0],out[1],out[3]]).toEqual([prompt,result,answer]);
  expect(out[2].blocks).toEqual([{type:'image',text:'Attachment'}]);
  expect(out[4].blocks.map(block=>block.text)).toEqual(['Plan','Done']);
});

it('never turns a message that carries other content into an event',()=>{
  const out=projectMessages([{id:'m',role:'user',blocks:[{type:'text',text:'<task-notification><event>done</event></task-notification>'},{type:'text',text:'And my own words'}]}]);
  expect(out[0].event).toBeUndefined();expect(out[0].blocks.map(block=>block.text)).toContain('And my own words');
});

it('turns a pasted_content wrapper of any id into a pasted block and keeps the words typed around it',()=>{
  const [message]=project('Fix this: <pasted_content id="05cc">\nline one\nline two\n</pasted_content id="05cc"> then ship it');
  expect(message.blocks.map(block=>[block.text,'pasted' in block])).toEqual([['Fix this:',false],['line one\nline two',true],['then ship it',false]]);
  const [bare,unclosed]=[project('<pasted_content>a</pasted_content>')[0],project('<pasted_content id=x9>cut off')[0]];
  expect(bare.blocks).toEqual([{type:'text',text:'a',pasted:true}]);
  expect(unclosed.blocks).toEqual([{type:'text',text:'cut off',pasted:true}]);
  expect(project('<pasted_content id="1">a</pasted_content id="1"><pasted_content id="2">b</pasted_content id="2">')[0].blocks.map(block=>block.text)).toEqual(['a','b']);
});
