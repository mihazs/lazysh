import {useEffect,useState,type ReactNode} from 'react';
import {languages,type SyntaxNode} from './CodePreview';
import {t} from './i18n/core';
import type {Line} from './RepositoryPanel';

type Highlighted={left:ReactNode[][];right:ReactNode[][]};

/** Split highlighted hunk text into table lines while keeping only safe syntax classes. */
function splitNodes(nodes:SyntaxNode[]):{lines:ReactNode[][];text:string} {
  const lines:ReactNode[][]=[[]];let text='';
  function visit(items:SyntaxNode[],classes:string[]) {
    for(const node of items) {
      if(node.type==='text') {
        text+=node.value??'';
        const pieces=(node.value??'').split('\n');
        pieces.forEach((piece,index)=>{if(index)lines.push([]);if(piece)lines.at(-1)!.push(classes.length?<span key={lines.at(-1)!.length} className={classes.join(' ')}>{piece}</span>:piece);});
      } else if(node.type==='element' && node.tagName==='span') {
        const own=Array.isArray(node.properties?.className)?node.properties.className.filter((value):value is string=>typeof value==='string' && /^hljs[\w-]*$/.test(value)):[];
        visit(node.children??[],[...classes,...own]);
      }
    }
  }
  visit(nodes,[]);return {lines,text};
}

export default function DiffSyntax({path,rows,children}:{path:string;rows:Line[];children:(nodes:Highlighted|undefined)=>ReactNode}) {
  const [enabled,setEnabled]=useState(false);
  const [result,setResult]=useState<{path:string;rows:Line[];nodes:Highlighted}>();
  const language=languages[path.split('.').at(-1)?.toLowerCase()??''];
  const size=rows.reduce((sum,row)=>sum+(row.left?.length??0)+(row.right?.length??0),0);
  const available=!!language && size<=100000 && rows.length<=2000;
  useEffect(()=>{
    let active=true;
    if(enabled && available)void import('lowlight').then(({createLowlight,common})=>{
      const parser=createLowlight(common);if(!parser.registered(language))return;
      const nodes:Highlighted={left:[],right:[]};
      for(const side of ['left','right'] as const) {
        let group:number[]=[];
        // shortcut: syntax context starts at each hunk, use whole-file snapshots when available.
        const flush=()=>{
          if(!group.length)return;
          const text=group.map(index=>rows[index][side]!).join('\n');
          const parsed=splitNodes(parser.highlight(language,text).children);
          if(parsed.text===text && parsed.lines.length===group.length)group.forEach((index,position)=>{nodes[side][index]=parsed.lines[position];});
          group=[];
        };
        rows.forEach((row,index)=>{if(row.kind==='hunk')flush();else if(row[side]!==undefined)group.push(index);});flush();
      }
      if(active)setResult({path,rows,nodes});
    }).catch(()=>{ /* Plain text remains available. */ });
    return ()=>{active=false;};
  },[enabled,available,language,path,rows]);
  return <>{available && <button type="button" onClick={()=>setEnabled(!enabled)}>{t(enabled?'codePlain':'codeHighlight')}</button>}{children(enabled && result?.path===path && result.rows===rows?result.nodes:undefined)}</>;
}
