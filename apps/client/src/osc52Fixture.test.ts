import {expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {decodeClipboardRequest} from './preferences';

/** The fixture the Rust core replays (`packages/terminal-runtime/tests/clipboard.rs`): the text after `ESC ] 52 ;` and what `decodeClipboardRequest` makes of it. */
const path=new URL('../../../packages/terminal-runtime/fixtures/osc52.json',import.meta.url);
type Case={id:string;data:string;text:string|null};

it('records what the OSC 52 consent flow is offered for each request (UPDATE_OSC52=1 rewrites them)',()=>{
  const data=JSON.parse(readFileSync(path,'utf8')) as {cases:Case[]};
  for(const c of data.cases) {
    const text=decodeClipboardRequest(c.data)??null;
    if(process.env.UPDATE_OSC52)c.text=text;
    expect(text,c.id).toBe(c.text);
  }
  if(process.env.UPDATE_OSC52)writeFileSync(path,JSON.stringify(data,null,1)+'\n');
});
