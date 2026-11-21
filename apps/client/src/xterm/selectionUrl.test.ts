// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {fixtureAdapter} from './fixtureAdapter';

const oauth='https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference';
async function copyWordAt(cols:number,write:string,cell:{x:number;y:number}) {
  const adapter=await fixtureAdapter({id:'url',cols,rows:14,scrollback:100,write},true);
  adapter.select(adapter.selectWordAt(cell));
  return adapter.selectedText();
}
describe('copying a URL by long-press',()=>{
  it('copies a soft-wrapped URL whole, from a word on any row',async()=>{
    for(const y of [0,1,2])expect(await copyWordAt(80,`${oauth}\r\n`,{x:3,y})).toBe(oauth);
  });
  it('copies a URL hard-wrapped inside a box without borders, indentation or line breaks',async()=>{
    const rows=oauth.match(/.{1,60}/g)!;
    const box=rows.map(row=>`│ ${row.padEnd(60)} │`).join('\r\n');
    expect(await copyWordAt(66,`Browser didn't open? Use the url below\r\n${box}\r\n`,{x:10,y:2})).toBe(oauth);
  });
});
