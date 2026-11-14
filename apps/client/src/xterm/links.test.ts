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
  describe('a tap with a finger',()=>{
    const CELL={width:8,height:16};
    async function openedTerminal(output:string,beforeOpen?:(terminal:import('@xterm/xterm').Terminal)=>void) {
      const terminal=await terminalWith(40,output);
      beforeOpen?.(terminal);
      // xterm reads the pixel ratio and its changes through matchMedia, which jsdom lacks.
      window.matchMedia??=((query:string)=>({matches:false,media:query,onchange:null,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},dispatchEvent:()=>false})) as typeof window.matchMedia;
      const host=document.createElement('div');
      document.body.append(host);
      terminal.open(host);
      // jsdom has no layout: give the screen one box so a point maps to a cell.
      const screen=terminal.element!.querySelector('.xterm-screen')!;
      screen.getBoundingClientRect=()=>({left:0,top:0,right:terminal.cols*CELL.width,bottom:terminal.rows*CELL.height,width:terminal.cols*CELL.width,height:terminal.rows*CELL.height,x:0,y:0,toJSON(){}});
      return terminal;
    }
    const press=(terminal:import('@xterm/xterm').Terminal,pointerType:string,column:number,row:number)=>{
      const down=new MouseEvent('pointerdown',{bubbles:true});
      Object.defineProperty(down,'pointerType',{value:pointerType});
      terminal.element!.dispatchEvent(down);
      terminal.element!.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:column*CELL.width+3,clientY:row*CELL.height+3}));
    };
    const settled=()=>new Promise(resolve=>setTimeout(resolve,0));
    // Row 0 is "see ~/notes/todo.txt now": the path covers columns 4 to 20.
    const output='see ~/notes/todo.txt now\r\n';

    it('opens the path under it once the host confirms the file, before any hover',async()=>{
      const {installTerminalLinks}=await import('./links');
      const terminal=await openedTerminal(output);
      const opened:string[]=[];
      installTerminalLinks(terminal,()=>{},{exists:async()=>true,open:link=>opened.push(link.path)});
      press(terminal,'touch',10,0);
      await settled();
      expect(opened).toEqual(['~/notes/todo.txt']);
      terminal.dispose();
    });
    it('opens the path when the links were installed before the terminal was opened, as the pane does',async()=>{
      const {installTerminalLinks}=await import('./links');
      const opened:string[]=[];
      const terminal=await openedTerminal(output,unopened=>{installTerminalLinks(unopened,()=>{},{exists:async()=>true,open:link=>opened.push(link.path)});});
      press(terminal,'touch',10,0);
      await settled();
      expect(opened).toEqual(['~/notes/todo.txt']);
      terminal.dispose();
    });
    it('opens nothing for a tap beside the path, a path the host does not have, a mouse click or after the links are disposed',async()=>{
      const {installTerminalLinks}=await import('./links');
      const terminal=await openedTerminal(output);
      const opened:string[]=[];
      let exists=true;
      const links=installTerminalLinks(terminal,()=>{},{exists:async()=>exists,open:link=>opened.push(link.path)});
      press(terminal,'touch',1,0);
      press(terminal,'touch',30,0);
      press(terminal,'mouse',10,0);
      exists=false;
      press(terminal,'touch',10,0);
      await settled();
      expect(opened).toEqual([]);
      exists=true;
      links.dispose();
      press(terminal,'touch',10,0);
      await settled();
      expect(opened).toEqual([]);
      terminal.dispose();
    });
  });
});
