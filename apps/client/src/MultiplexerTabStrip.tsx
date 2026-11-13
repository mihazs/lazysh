import {ChevronDown,Plus} from 'lucide-react';
import {useEffect,useLayoutEffect,useRef,useState,type FormEvent,type PointerEvent} from 'react';
import {formatNumber,t,useUi} from './i18n/core';
import type {MuxEdit,MuxRef,MuxStrip,MuxTab} from './multiplexerTabs';
import {herdrStatusKeys} from './useHerdrNavigation';
import './MultiplexerTabStrip.css';

/** The state dot of a chip: only a state worth a glance (an idle or unknown agent leaves the chip quiet); the state is always also in the chip's accessible name. */
const Dot=({tab}:{tab:Pick<MuxTab,'state'|'attention'>})=>tab.state && tab.state!=='idle' && tab.state!=='unknown'?<span className="mux-dot" data-state={tab.state} aria-hidden="true"/>:null;
const label=(tab:MuxTab,position:number,total:number)=>[t('muxTabLabel',{name:tab.title,position:formatNumber(position),total:formatNumber(total)}),tab.state && tab.state!=='unknown'?t(herdrStatusKeys[tab.state]):''].filter(Boolean).join(', ');
const holdMs=500,holdSlop=10;
type Prompt={edit:MuxEdit;title:string;name:string;directory?:string};

/**
 * One slim row of the terminal chrome that mirrors the attached multiplexer's tabs. It is ordinary layout above the terminal, so the
 * terminal loses exactly this row's height and nothing more; the workspace list drops over the terminal and takes no layout space.
 * Chips are buttons in a labelled group rather than `role="tab"`: the session tabs are the workspace's only tabs, and tests and
 * assistive technology count them. Where the multiplexer's command layer can rename or create, a long press (or the context-menu key) on a chip
 * and a `+` at the end of the row drop a small name prompt; that prompt is the only thing here that opens the soft keyboard, on purpose.
 */
export default function MultiplexerTabStrip({strip,onSelect,onEdit}:{strip:MuxStrip;onSelect:(ref:MuxRef)=>void;onEdit?:(edit:MuxEdit,name:string,directory:string)=>Promise<boolean>}) {
  useUi();
  const [open,setOpen]=useState(false);
  const [prompt,setPrompt]=useState<Prompt>();
  const [saving,setSaving]=useState(false);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const hold=useRef<{timer:number;x:number;y:number;fired:boolean}|undefined>(undefined);
  const scroller=useRef<HTMLDivElement>(null);
  const root=useRef<HTMLDivElement>(null);
  const {group,tabs}=strip;
  const choices=group.choices.length>1;
  const active=tabs.find(tab=>tab.active)?.id;
  // The active chip follows the multiplexer's focus into view, centered, so a switch from elsewhere is never off screen.
  useLayoutEffect(()=>{
    const row=scroller.current,chip=row?.querySelector<HTMLElement>('[data-active]');
    if(row && chip)row.scrollLeft=chip.offsetLeft-(row.clientWidth-chip.offsetWidth)/2;
  },[active,tabs.length]);
  useEffect(()=>{
    if(!open && !prompt)return;
    // An outside press closes the workspace list; a half-typed name survives one and ends only with Escape, Cancel or Save.
    const close=(event:Event)=>{if(event.type==='keydown'?(event as KeyboardEvent).key==='Escape':!prompt && !root.current?.contains(event.target as Node)){setOpen(false);setPrompt(undefined);}};
    document.addEventListener('keydown',close,true);document.addEventListener('pointerdown',close,true);
    return()=>{document.removeEventListener('keydown',close,true);document.removeEventListener('pointerdown',close,true);};
  },[open,prompt]);
  const ask=(edit:MuxEdit,title:string,name:string,directory?:string)=>{setOpen(false);setPrompt({edit,title,name,directory});};
  const clear=()=>{if(hold.current)window.clearTimeout(hold.current.timer);};
  // A press keeps focus where it is, so a soft keyboard that is already open does not close and reopen, and a closed one never opens.
  // On a chip that can be renamed, holding still for half a second (or the context-menu key or a right click) asks for the new name instead of selecting.
  const press=(rename?:MuxEdit,title='')=>{
    const renamable=rename && onEdit;
    return {
      onPointerDown:(event:PointerEvent)=>{
        event.preventDefault();clear();hold.current=undefined;
        if(!renamable || (event.pointerType==='mouse' && event.button!==0))return;
        const state={timer:0,x:event.clientX,y:event.clientY,fired:false};
        state.timer=window.setTimeout(()=>{state.fired=true;ask(rename,t('muxRenameTab',{name:title}),title);},holdMs);
        hold.current=state;
      },
      onPointerMove:(event:PointerEvent)=>{if(hold.current && Math.hypot(event.clientX-hold.current.x,event.clientY-hold.current.y)>holdSlop)clear();},
      onPointerUp:clear,onPointerCancel:clear,
      // The tap that ends a long press must not also select.
      onClickCapture:(event:{preventDefault:()=>void;stopPropagation:()=>void})=>{if(hold.current?.fired){event.preventDefault();event.stopPropagation();hold.current=undefined;}},
      ...(renamable?{onContextMenu:(event:{preventDefault:()=>void})=>{event.preventDefault();ask(rename,t('muxRenameTab',{name:title}),title);}}:{}),
    };
  };
  async function save(event:FormEvent) {
    event.preventDefault();
    const name=prompt?.name.trim();
    if(!prompt || !name || !onEdit || saving)return;
    setSaving(true);
    const done=await onEdit(prompt.edit,name,prompt.directory??'.');
    if(!alive.current)return;
    setSaving(false);
    if(done)setPrompt(undefined);
  }
  const heading=<><Dot tab={group}/><span className="mux-group-name">{group.title}</span></>;
  return <div ref={root} className="mux-strip" role="group" aria-label={t('muxStripLabel',{kind:strip.kind})} data-kind={strip.kind}>
    {choices
      ?<button type="button" className="mux-group" data-attention={group.attention||undefined} aria-expanded={open} title={t('muxWorkspaces')} aria-label={`${t('muxWorkspaces')}: ${group.title}${group.attention?`, ${t('herdrAgentBlocked')}`:''}`} {...press()} onClick={()=>{setPrompt(undefined);setOpen(!open);}}>{heading}<ChevronDown size={14} aria-hidden="true"/></button>
      :<span className="mux-group" title={group.title}>{heading}</span>}
    {open && <div className="mux-choices" role="group" aria-label={t('muxWorkspaces')}>{group.choices.map((choice,index)=>
      <button type="button" key={choice.id} className="mux-choice" data-active={choice.active||undefined} data-attention={choice.attention||undefined} aria-current={choice.active?'true':undefined} aria-label={label(choice,index+1,group.choices.length)} {...press(choice.rename,choice.title)} onClick={()=>{setOpen(false);if(!choice.active)onSelect(choice.ref);}}><Dot tab={choice}/><span>{choice.title}</span></button>)}</div>}
    <div ref={scroller} className="mux-tabs">{tabs.map((tab,index)=>
      <button type="button" key={tab.id} className="mux-chip" data-active={tab.active||undefined} data-attention={tab.attention||undefined} title={tab.title} aria-current={tab.active?'true':undefined} aria-label={label(tab,index+1,tabs.length)} {...press(tab.rename,tab.title)} onClick={()=>{if(!tab.active)onSelect(tab.ref);}}><Dot tab={tab}/><span>{tab.title}</span></button>)}</div>
    {strip.create && onEdit && <button type="button" className="mux-add" title={t('muxNewTab')} aria-label={t('muxNewTab')} {...press()}
      onClick={()=>{const {edit,directory}=strip.create!;ask(edit,t('muxNewTab'),'',directory);}}><Plus size={17} aria-hidden="true"/></button>}
    {prompt && <form className="mux-prompt" aria-label={prompt.title} onSubmit={save}>
      <label>{t('muxPromptName')}<input autoFocus required maxLength={200} value={prompt.name} disabled={saving} onFocus={event=>event.currentTarget.select()} onChange={event=>setPrompt({...prompt,name:event.target.value})}/></label>
      {prompt.directory!==undefined && <label>{t('muxPromptDirectory')}<input required maxLength={4096} value={prompt.directory} disabled={saving} onChange={event=>setPrompt({...prompt,directory:event.target.value})}/></label>}
      <div><button type="button" className="subtle-button" disabled={saving} onClick={()=>setPrompt(undefined)}>{t('appCancel')}</button><button type="submit" className="primary-button" disabled={saving || !prompt.name.trim()}>{t('muxPromptSave')}</button></div>
    </form>}
  </div>;
}
