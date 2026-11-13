// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {findUrls,type Rows} from '../terminalLinks';

const urls=(rows:Rows,cols:number,line:number)=>findUrls(rows,cols,line).map(link=>link.text);
const long='https://example.com/docs/guides/getting-started/installation?ref=terminal&lang=en#section-two';

describe('with a real xterm buffer',()=>{
  async function terminalWith(cols:number,output:string) {
    const {Terminal}=await import('@xterm/xterm');
    const terminal=new Terminal({cols,rows:12,allowProposedApi:false});
    await new Promise<void>(resolve=>terminal.write(output,resolve));
    return terminal;
  }
  it('reads rows xterm soft-wrapped itself, wide characters and the scrollback included',async()=>{
    const terminal=await terminalWith(24,`${'x\r\n'.repeat(14)}世界 ${long} done\r\n`);
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
    const first=terminal.buffer.active.length-1-Math.ceil((`世界 ${long} done`.length+2)/24);
    const hits=[...Array(8).keys()].map(offset=>urls(terminal.buffer.active,24,first+offset+1));
    expect(hits.filter(list=>list.length).every(list=>list.length===1&&list[0]===long)).toBe(true);
    expect(hits.filter(list=>list.length).length).toBeGreaterThanOrEqual(4);
    terminal.dispose();
  });
  it('asks the link provider for one logical URL and activates it with the whole text',async()=>{
    const {installTerminalLinks}=await import('./links');
    const terminal=await terminalWith(20,`go ${long}\r\n`);
    let provider!:{provideLinks:(line:number,callback:(links:{text:string;activate:(event:MouseEvent,text:string)=>void}[]|undefined)=>void)=>void};
    terminal.registerLinkProvider=candidate=>{provider=candidate as typeof provider;return {dispose(){}};};
    const opened:string[]=[];
    installTerminalLinks(terminal,url=>opened.push(url));
    const links=await new Promise<{text:string;activate:(event:MouseEvent,text:string)=>void}[]|undefined>(resolve=>provider.provideLinks(3,resolve));
    expect(links?.map(link=>link.text)).toEqual([long]);
    links![0].activate(new MouseEvent('click'),links![0].text);
    expect(opened).toEqual([long]);
    expect(typeof terminal.options.linkHandler?.activate).toBe('function');
    terminal.options.linkHandler?.activate(new MouseEvent('click'),'https://hyperlink.example/osc8',{start:{x:1,y:1},end:{x:2,y:1}});
    expect(opened.at(-1)).toBe('https://hyperlink.example/osc8');
    terminal.dispose();
  });
});
