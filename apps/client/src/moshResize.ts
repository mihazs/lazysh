import type {Terminal} from '@xterm/xterm';
import {version} from '@xterm/xterm/package.json';

type Line={length:number;isWrapped:boolean;resize(cols:number,cell:unknown):boolean};
type Lines={length:number;maxLength:number;get(index:number):Line|undefined;push(line:Line):void;splice(index:number,count:number):void;trimStart(count:number):void};
type Buffer={
  lines:Lines;_cols:number;_rows:number;_hasScrollback:boolean;
  x:number;y:number;ybase:number;ydisp:number;savedX:number;savedY:number;scrollTop:number;scrollBottom:number;
  _getCorrectBufferLength(rows:number):number;getNullCell():unknown;getBlankLine(attr:unknown):Line;
};
type Buffers={normal:Buffer;alt:Buffer;active:Buffer;resize(cols:number,rows:number):void;setupTabStops(cols:number):void};
type Hook={resize:Buffers['resize'];apply(cols:number,rows:number):void;dispose():void};
const hooks=new WeakMap<Terminal,Hook>();
const unsupported=()=>new Error('This terminal cannot apply canonical Mosh resizing.');
const integer=(value:unknown,min=0,max=0xffffffff):value is number=>Number.isInteger(value)&&Number(value)>=min&&Number(value)<=max;

function validBuffer(value:Buffer,history:boolean):boolean {
  if(!value||value._hasScrollback!==history||!integer(value._cols,2)||!integer(value._rows,1)
    ||!integer(value.x,0,value._cols)||!integer(value.y,0,value._rows-1)
    ||!integer(value.ybase)||!integer(value.ydisp,0,value.ybase)||!integer(value.savedX)||!integer(value.savedY)
    ||typeof value._getCorrectBufferLength!=='function'||typeof value.getNullCell!=='function'||typeof value.getBlankLine!=='function')return false;
  const lines=value.lines;
  if(!lines||!integer(lines.maxLength,1)||!integer(lines.length,0,lines.maxLength)
    ||['get','push','splice','trimStart'].some(key=>typeof (lines as unknown as Record<string,unknown>)[key]!=='function')
    ||(lines.length!==0&&lines.length<value.ybase+value._rows))return false;
  for(let row=value.ybase;row<lines.length;row++) {
    const line=lines.get(row);
    if(!line||!integer(line.length,2)||typeof line.isWrapped!=='boolean'||typeof line.resize!=='function')return false;
  }
  return true;
}

/** xterm 5.5.0 per-instance seam for Mosh's top-anchored canonical screen.
 * History retains its original cells/row width: a narrower view can clip it until
 * widened. Reflowing or truncating that history would change previously received
 * content. Only clipped current-screen cells (and selections on them) are lost.
 */
function installCanonicalResize(terminal:Terminal):Hook {
  const buffers=(terminal as unknown as {_core?:{_bufferService?:{buffers?:Buffers}}})._core?._bufferService?.buffers;
  if(version!=='5.5.0'||!buffers||typeof buffers.resize!=='function'||typeof buffers.setupTabStops!=='function'
    ||!validBuffer(buffers.normal,true)||!validBuffer(buffers.alt,false)
    ||![buffers.normal,buffers.alt].includes(buffers.active))throw unsupported();
  const prior=hooks.get(terminal);
  if(prior) {if(buffers.resize!==prior.resize)throw unsupported();return prior;}
  const descriptor=Object.getOwnPropertyDescriptor(buffers,'resize');
  if(!Object.isExtensible(buffers)||(descriptor&&(!descriptor.configurable||!('value' in descriptor)||!descriptor.writable)))throw unsupported();
  let selectionBefore:ReturnType<Terminal['getSelectionPosition']>|undefined;
  let surviving:ReturnType<Terminal['getSelectionPosition']>;
  const stockResize=terminal.resize;
  const resize:Buffers['resize']=function(cols,rows) {
    if(!integer(cols,2,512)||!integer(rows,1,256)||cols*rows>32768
      ||!validBuffer(buffers.normal,true)||!validBuffer(buffers.alt,false))throw unsupported();
    // Validate both capacities before changing either buffer.
    const pair=[buffers.normal,buffers.alt].map(buffer=>({buffer,capacity:buffer._getCorrectBufferLength(rows)}));
    if(pair.some(({capacity})=>!integer(capacity,rows)))throw unsupported();
    const selection=selectionBefore===undefined?terminal.getSelectionPosition():selectionBefore;
    for(const {buffer,capacity} of pair) {
      const lines=buffer.lines,base=buffer.ybase,cut=base+rows;
      const trim=Math.max(0,cut-capacity);
      if(selection&&buffers.active===buffer) {
        const {start,end}=selection;
        const touchesViewport=end.y>base||(end.y===base&&end.x>0);
        const clippedRows=rows<buffer._rows&&(start.y>=cut||end.y>cut||(end.y===cut&&end.x>0));
        // History cells survive, but a selection endpoint outside the visible
        // columns would wrap when the public selection API uses the new width.
        const clippedColumns=cols<buffer._cols&&(start.x>=cols||end.x>cols
          ||(touchesViewport&&Math.max(start.y,base)<end.y));
        if(clippedRows||clippedColumns||start.y<trim){terminal.clearSelection();surviving=undefined;}
        else if(surviving&&trim)surviving={start:{x:start.x,y:start.y-trim},end:{x:end.x,y:end.y-trim}};
      }
      if(lines.length) {
        // Delete only the canonical viewport tail; real list events retire its markers.
        if(lines.length>cut)lines.splice(cut,lines.length-cut);
        if(trim)lines.trimStart(trim);
        buffer.ybase=Math.max(0,base-trim);buffer.ydisp=Math.max(0,buffer.ydisp-trim);
        buffer.savedY=Math.max(0,buffer.savedY-trim);
        lines.maxLength=capacity;
        while(lines.length<buffer.ybase+rows)lines.push(buffer.getBlankLine(buffer.getNullCell()));
        if(cols!==buffer._cols)for(let row=buffer.ybase;row<lines.length;row++) {
          const line=lines.get(row)!;line.resize(cols,buffer.getNullCell());line.isWrapped=false;
        }
      } else lines.maxLength=capacity;
      buffer.x=Math.min(buffer.x,cols-1);buffer.y=Math.min(buffer.y,rows-1);
      buffer.savedX=Math.min(buffer.savedX,cols-1);
      buffer._cols=cols;buffer._rows=rows;buffer.scrollTop=0;buffer.scrollBottom=rows-1;
    }
    // BufferService still owns its ordinary resize/core/render events.
    buffers.setupTabStops(cols);
  };
  let disposed=false;
  const hook:Hook={resize,apply(cols,rows){
    // BufferService changes cols BEFORE invoking BufferSet.resize; capture public
    // selection positions first, or select(start,length) is reinterpreted early.
    selectionBefore=terminal.getSelectionPosition();surviving=selectionBefore;
    try {stockResize.call(terminal,cols,rows);
      if(surviving){const {start,end}=surviving;terminal.select(start.x,start.y,(end.y-start.y)*cols+end.x-start.x);}
    } finally {selectionBefore=undefined;surviving=undefined;}
  },dispose() {
    if(disposed)return;disposed=true;
    if(buffers.resize===resize) {
      if(descriptor)Object.defineProperty(buffers,'resize',descriptor);
      else Reflect.deleteProperty(buffers,'resize');
    }
    hooks.delete(terminal);
  }};
  Object.defineProperty(buffers,'resize',{configurable:true,writable:true,value:resize});
  hooks.set(terminal,hook);
  return hook;
}

export type MoshResizeController={
  requestSize(cols:number,rows:number):void;
  onResizeIntent(listener:(size:{cols:number;rows:number})=>void):{dispose():void};
  close():Promise<void>;dispose():void;
  readonly failure:'invalid-frame'|'partial-frame'|null;
};
const controllers=new WeakMap<Terminal,MoshResizeController>();

/** Only a child known to be Mosh may install this before its first output.
 * User geometry is intent, not a resize of an in-flight canonical framebuffer.
 * The parser's synchronous START callback runs in xterm's ordered write queue.
 */
export function installMoshResize(terminal:Terminal):MoshResizeController {
  const existing=controllers.get(terminal);if(existing)return existing;
  const original=terminal.resize,descriptor=Object.getOwnPropertyDescriptor(terminal,'resize');
  if(version!=='5.5.0'||typeof original!=='function'||!Object.isExtensible(terminal)
    ||(descriptor&&(!descriptor.configurable||!('value' in descriptor)||!descriptor.writable))
    ||typeof terminal.parser?.registerOscHandler!=='function')throw unsupported();
  const canonical=installCanonicalResize(terminal);
  let desired:{cols:number;rows:number}|undefined,active:number|undefined,last=0;
  let accepting=true,disposed=false,retired=false,failure:MoshResizeController['failure']=null;
  let closed:Promise<void>|undefined,finishClose:(()=>void)|undefined;
  const intents=new Map<(size:{cols:number;rows:number})=>void,{cols:number;rows:number}|undefined>();
  const validSize=(cols:number,rows:number)=>integer(cols,2,512)&&integer(rows,1,256)&&cols*rows<=32768;
  const request=(cols:number,rows:number)=>{
    if(!accepting||disposed)return;
    if(!validSize(cols,rows))throw unsupported();
    desired={cols,rows};
    for(const [listener,measured] of intents) {
      if(measured?.cols===cols&&measured.rows===rows)continue;
      intents.set(listener,{...desired});listener({...desired});
    }
  };
  const invalid=()=>{failure='invalid-frame';accepting=false;intents.clear();};
  let parser:{dispose():void}|undefined;
  try {
    parser=terminal.parser.registerOscHandler(7777,data=>{
      if(!data.startsWith('lazysh-mosh;'))return false;
      if(disposed||retired||failure)return true;
      if(data.length>128){invalid();return true;}
      const begin=/^lazysh-mosh;1;begin;([1-9][0-9]{0,15});([1-9][0-9]{0,2});([1-9][0-9]{0,2})$/.exec(data);
      const end=/^lazysh-mosh;1;end;([1-9][0-9]{0,15})$/.exec(data);
      if(begin) {
        const id=Number(begin[1]),cols=Number(begin[2]),rows=Number(begin[3]);
        if(!Number.isSafeInteger(id)||id<=last||active!==undefined||!validSize(cols,rows)){invalid();return true;}
        active=id;last=id;canonical.apply(cols,rows);
      } else if(end) {
        const id=Number(end[1]);if(id!==active){invalid();return true;}active=undefined;
      } else invalid();
      return true;
    });
    if(!parser||typeof parser.dispose!=='function')throw unsupported();
    Object.defineProperty(terminal,'resize',{configurable:true,writable:true,value:request});
  } catch(error) {parser?.dispose();canonical.dispose();throw error;}
  const retire=()=>{
    if(retired)return false;retired=true;parser?.dispose();canonical.dispose();
    if(terminal.resize!==request)return false;
    if(descriptor)Object.defineProperty(terminal,'resize',descriptor);else Reflect.deleteProperty(terminal,'resize');
    return true;
  };
  const controller:MoshResizeController={requestSize:request,onResizeIntent(listener){
    if(accepting&&!disposed)intents.set(listener,undefined);return {dispose(){intents.delete(listener);}};
  },get failure(){return failure;},close(){
    if(closed)return closed;
    accepting=false;intents.clear();
    closed=new Promise(resolve=>{
      finishClose=resolve;
      if(disposed){resolve();return;}
      // The empty write is a FIFO callback barrier, not injected terminal data.
      terminal.write('',()=>{
        if(disposed){resolve();return;}
        if(active!==undefined&&!failure)failure='partial-frame';active=undefined;
        // Keep the final canonical geometry: stock shrinking can discard its
        // bottom rows when the final cursor sits above them. No desired restore.
        retire();
        resolve();
      });
    });
    return closed;
  },dispose(){
    if(disposed)return;disposed=true;accepting=false;intents.clear();active=undefined;retire();finishClose?.();controllers.delete(terminal);
  }};
  controllers.set(terminal,controller);return controller;
}
