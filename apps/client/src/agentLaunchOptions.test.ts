import {execFileSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {agentCommand,argumentLimits,splitArguments,yoloFlags} from './agentLaunchOptions';

describe('agent launch arguments',()=>{
  it('splits like a shell without expanding anything',()=>{
    expect(splitArguments('')).toEqual({args:[]});
    expect(splitArguments('   ')).toEqual({args:[]});
    expect(splitArguments('--model opus  --continue')).toEqual({args:['--model','opus','--continue']});
    expect(splitArguments(`--append "two words" 'it''s' a\\ b ""`)).toEqual({args:['--append','two words','its','a b','']});
    expect(splitArguments('"say \\"hi\\" \\\\ \\n"')).toEqual({args:['say "hi" \\ \\n']});
    expect(splitArguments('$(touch x); echo $HOME && *')).toEqual({args:['$(touch','x);','echo','$HOME','&&','*']});
  });
  it('refuses unbalanced quotes, a trailing backslash, control characters and anything past the limits',()=>{
    for(const text of ['"open',"'open",'trailing\\'])expect(splitArguments(text),text).toEqual({problem:'quote'});
    for(const text of ['a\nb','a\tb','a\u0000b','a\u0085b'])expect(splitArguments(text),JSON.stringify(text)).toEqual({problem:'limit'});
    expect(splitArguments(Array(argumentLimits.count).fill('x').join(' '))).toHaveProperty('args');
    expect(splitArguments(Array(argumentLimits.count+1).fill('x').join(' '))).toEqual({problem:'limit'});
    expect(splitArguments('x'.repeat(argumentLimits.bytes))).toHaveProperty('args');
    expect(splitArguments('x'.repeat(argumentLimits.bytes+1))).toEqual({problem:'limit'});
    expect(splitArguments('é'.repeat(argumentLimits.bytes/2+1))).toEqual({problem:'limit'});
  });
});

describe('agent command line',()=>{
  it('is the bare executable without options, as before',()=>{
    expect(agentCommand('claude',false,[])).toBe('claude');
    expect(agentCommand('codex',false,[])).toBe('codex');
  });
  it('puts the verified YOLO flag first, then the arguments, and only for an agent that has one',()=>{
    expect(agentCommand('claude',true,['--model','opus'])).toBe('claude --dangerously-skip-permissions --model opus');
    expect(agentCommand('codex',true,[])).toBe('codex --dangerously-bypass-approvals-and-sandbox');
    expect(agentCommand('gemini',true,['-m','x'])).toBe('gemini -m x');
    expect(Object.keys(yoloFlags).sort()).toEqual(['claude','codex']);
  });
  it('quotes every word a shell would read, so metacharacters stay text',()=>{
    expect(agentCommand('claude',false,['two words','it\'s','$(touch x)',';','&&','*','','~/a','--k=v']))
      .toBe(`claude 'two words' 'it'\\''s' '$(touch x)' ';' '&&' '*' '' '~/a' --k=v`);
  });
  it('reaches a real POSIX shell as the same words, whatever the person typed',()=>{
    const typed=String.raw`--model "a b" 'it'\''s' "$(touch /nonexistent/x)" ';' '&&' '*' '~' \$HOME '' "\"q\"" é`;
    const split=splitArguments(typed);
    if(!('args' in split))throw new Error('unexpected problem');
    expect(split.args).toEqual(['--model','a b',"it's",'$(touch /nonexistent/x)',';','&&','*','~','$HOME','','"q"','é']);
    const printed=execFileSync('sh',['-c',`set -- ${agentCommand('claude',true,split.args)}; shift; printf '%s\\0' "$@"`],{encoding:'utf8'});
    expect(printed.split('\0').slice(0,-1)).toEqual([yoloFlags.claude,...split.args]);
  });
});
