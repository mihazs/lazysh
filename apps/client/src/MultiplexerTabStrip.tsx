import {ChevronDown} from 'lucide-react';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {formatNumber,t,useUi} from './i18n/core';
import type {MuxRef,MuxStrip,MuxTab} from './multiplexerTabs';
import {herdrStatusKeys} from './useHerdrNavigation';
import './MultiplexerTabStrip.css';

/** The state dot of a chip: only a state worth a glance (an idle or unknown agent leaves the chip quiet); the state is always also in the chip's accessible name. */
const Dot=({tab}:{tab:Pick<MuxTab,'state'|'attention'>})=>tab.state && tab.state!=='idle' && tab.state!=='unknown'?<span className="mux-dot" data-state={tab.state} aria-hidden="true"/>:null;
const label=(tab:MuxTab,position:number,total:number)=>[t('muxTabLabel',{name:tab.title,position:formatNumber(position),total:formatNumber(total)}),tab.state && tab.state!=='unknown'?t(herdrStatusKeys[tab.state]):''].filter(Boolean).join(', ');
// A press keeps focus where it is, so a soft keyboard that is already open does not close and reopen, and a closed one never opens.
const keepFocus={onPointerDown:(event:{preventDefault:()=>void})=>event.preventDefault()};

/**
 * One slim row of the terminal chrome that mirrors the attached multiplexer's tabs. It is ordinary layout above the terminal, so the
 * terminal loses exactly this row's height and nothing more; the workspace list drops over the terminal and takes no layout space.
 * Chips are buttons in a labelled group rather than `role="tab"`: the session tabs are the workspace's only tabs, and tests and
 * assistive technology count them.
 */
export default function MultiplexerTabStrip({strip,onSelect}:{strip:MuxStrip;onSelect:(ref:MuxRef)=>void}) {
  useUi();
  const [open,setOpen]=useState(false);
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
    if(!open)return;
    const close=(event:Event)=>{if(event.type==='keydown'?(event as KeyboardEvent).key==='Escape':!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('keydown',close,true);document.addEventListener('pointerdown',close,true);
    return()=>{document.removeEventListener('keydown',close,true);document.removeEventListener('pointerdown',close,true);};
  },[open]);
  const heading=<><Dot tab={group}/><span className="mux-group-name">{group.title}</span></>;
  return <div ref={root} className="mux-strip" role="group" aria-label={t('muxStripLabel',{kind:strip.kind})} data-kind={strip.kind}>
    {choices
      ?<button type="button" className="mux-group" data-attention={group.attention||undefined} aria-expanded={open} title={t('muxWorkspaces')} aria-label={`${t('muxWorkspaces')}: ${group.title}${group.attention?`, ${t('herdrAgentBlocked')}`:''}`} {...keepFocus} onClick={()=>setOpen(!open)}>{heading}<ChevronDown size={14} aria-hidden="true"/></button>
      :<span className="mux-group" title={group.title}>{heading}</span>}
    {open && <div className="mux-choices" role="group" aria-label={t('muxWorkspaces')}>{group.choices.map((choice,index)=>
      <button type="button" key={choice.id} className="mux-choice" data-active={choice.active||undefined} data-attention={choice.attention||undefined} aria-current={choice.active?'true':undefined} aria-label={label(choice,index+1,group.choices.length)} {...keepFocus} onClick={()=>{setOpen(false);if(!choice.active)onSelect(choice.ref);}}><Dot tab={choice}/><span>{choice.title}</span></button>)}</div>}
    <div ref={scroller} className="mux-tabs">{tabs.map((tab,index)=>
      <button type="button" key={tab.id} className="mux-chip" data-active={tab.active||undefined} data-attention={tab.attention||undefined} title={tab.title} aria-current={tab.active?'true':undefined} aria-label={label(tab,index+1,tabs.length)} {...keepFocus} onClick={()=>{if(!tab.active)onSelect(tab.ref);}}><Dot tab={tab}/><span>{tab.title}</span></button>)}</div>
  </div>;
}
