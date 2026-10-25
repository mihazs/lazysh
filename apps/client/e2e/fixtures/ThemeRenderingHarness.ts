import {createTerminal, applyTerminalTheme} from '../../src/terminal';
import {defaults, parsePreferences} from '../../src/preferences';
import {importedTheme} from '../../src/themeImport';
import '@xterm/xterm/css/xterm.css';

export function mountThemeRenderingHarness() {
  const host = document.createElement('section');
  host.dataset.testid = 'theme-renderer';
  Object.assign(host.style, {position:'fixed',inset:'0',zIndex:'100',padding:'12px',background:'#101010'});
  document.body.append(host);
  const terminal = createTerminal();
  terminal.resize(36,12);
  terminal.open(host);
  let preferences = defaults;
  let joinedRequests = 0;
  const colors = {background:'#101010',foreground:'#dddddd',red:'#aa2222',brightRed:'#ff5555',white:'#aaaaaa',brightWhite:'#eeeeee',selectionBackground:'#445566',selectionForeground:'#ffeecc'};
  function theme(bold?: string, mode:'dark'|'light'='dark') {
    const imported = importedTheme({v:1,name:'Renderer fixture',mode,colors:{...colors,...(mode==='light'?{background:'#fafafa',foreground:'#111111'}:{}),...(bold===undefined?{}:{bold})}});
    host.style.background=imported.colors.background!;
    preferences = parsePreferences({...defaults,theme:'custom',customTheme:imported.colors,customThemeInfo:{name:imported.name,mode:imported.mode}});
    applyTerminalTheme(terminal,preferences);
  }
  theme();
  terminal.focus();
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return {
    async write(data: string) {await new Promise<void>(resolve => terminal.write(data,resolve));await frame();},
    async theme(bold?:string) {theme(bold);await frame();},
    async light(bold?:string) {theme(bold,'light');await frame();},
    async bundled() {applyTerminalTheme(terminal,defaults);await frame();},
    async paper() {applyTerminalTheme(terminal,{...defaults,theme:'paper'});await frame();},
    async legacy() {applyTerminalTheme(terminal,parsePreferences({...defaults,theme:'custom',customTheme:colors}));await frame();},
    async contrast() {terminal.options.minimumContrastRatio=4.5;await frame();},
    async select(column:number,row:number,length:number,focus=true) {if(focus)terminal.focus();else terminal.blur();terminal.select(column,row,length);await frame();},
    async clearSelection() {terminal.clearSelection();await frame();},
    async decorate(column:number,row:number,foregroundColor?:string,backgroundColor?:string) {
      terminal.options.allowProposedApi=true;
      const marker=terminal.registerMarker(row-terminal.buffer.active.cursorY);
      if(!marker || !terminal.registerDecoration({marker,x:column,width:1,layer:'top',foregroundColor,backgroundColor}))throw new Error('Decoration fixture was not registered');
      await frame();
    },
    async scrollTop() {terminal.scrollToTop();await frame();},
    async resize() {terminal.resize(38,14);await frame();},
    async join() {terminal.options.allowProposedApi=true;terminal.registerCharacterJoiner(text=>{if(text.startsWith('fi')){joinedRequests++;return [[0,2]];}return [];});await frame();},
    joinedRequests() {return joinedRequests;},
    spans() {return Array.from(host.querySelectorAll<HTMLElement>('.xterm-rows span'),span=>({text:span.textContent,foreground:getComputedStyle(span).color}));},
    buffer() {
      const buffer=terminal.buffer.active;
      return Array.from({length:Math.min(buffer.length,terminal.rows)},(_,y)=>Array.from({length:terminal.cols},(_,x)=>{
        const cell=buffer.getLine(buffer.viewportY+y)?.getCell(x);
        return cell?{chars:cell.getChars(),width:cell.getWidth(),fg:cell.getFgColor(),fgMode:cell.getFgColorMode(),bg:cell.getBgColor(),bgMode:cell.getBgColorMode(),bold:cell.isBold(),inverse:cell.isInverse()}:null;
      }));
    },
    sample(text:string) {
      const spans=Array.from(host.querySelectorAll<HTMLElement>('.xterm-rows span'));
      const span=spans.find(element=>element.textContent===text) ?? spans.find(element=>element.textContent?.includes(text));
      if(!span)throw new Error(`Missing rendered fixture ${text}`);
      const style=getComputedStyle(span);
      return {foreground:style.color,background:style.backgroundColor,weight:style.fontWeight,text:span.textContent,classes:span.className};
    },
    rows() {return Array.from(host.querySelectorAll('.xterm-rows>div'),row=>row.textContent);},
    dispose() {terminal.dispose();terminal.dispose();host.remove();},
  };
}
