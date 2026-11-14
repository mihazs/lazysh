import {ChevronDown,Plus} from 'lucide-react';
import {useEffect,useId,useLayoutEffect,useRef,useState,type FormEvent,type PointerEvent} from 'react';
import {formatNumber,t,useUi} from './i18n/core';
import type {MuxEdit,MuxRef,MuxStrip,MuxTab} from './multiplexerTabs';
import {herdrStatusKeys} from './useHerdrNavigation';
import './MultiplexerTabStrip.css';

/** The state dot of a chip: only a state worth a glance (an idle or unknown agent leaves the chip quiet); the state is always also in the chip's accessible name. */
const Dot=({tab}:{tab:Pick<MuxTab,'state'|'attention'>})=>tab.state && tab.state!=='idle' && tab.state!=='unknown'?<span className="mux-dot" data-state={tab.state} aria-hidden="true"/>:null;
const label=(tab:MuxTab,position:number,total:number)=>[t('muxTabLabel',{name:tab.title,position:formatNumber(position),total:formatNumber(total)}),tab.state && tab.state!=='unknown'?t(herdrStatusKeys[tab.state]):''].filter(Boolean).join(', ');
const holdMs=500,holdSlop=10;
/** A press on a menu or a confirmation keeps focus where it is, like a chip does, so an open soft keyboard stays open and the terminal grid does not move. */
const keepFocus=(event:PointerEvent)=>event.preventDefault();
type Prompt={edit:MuxEdit;title:string;name:string;directory?:string;confirm?:string};
/** The chip a long press acts on: only what its multiplexer's command layer can do. */
type Target=Pick<MuxTab,'title'|'rename'|'close'>;

/**
 * One slim row of the terminal chrome that mirrors the attached multiplexer's tabs. It is ordinary layout above the terminal, so the
 * terminal loses exactly this row's height and nothing more; the workspace list, the chip menu and the prompts drop over the terminal and take no layout space.
 * Chips are buttons in a labelled group rather than `role="tab"`: the session tabs are the workspace's only tabs, and tests and
 * assistive technology count them. Where the multiplexer's command layer can rename, close or create, a long press (or the context-menu key) on a chip
 * offers Rename and Close (a lone action runs at once), Close asks first and names the tab, and a `+` at the end of the row drops a name prompt;
 * the name prompt is the only thing here that opens the soft keyboard, on purpose.
 */
export default function MultiplexerTabStrip({strip,onSelect,onEdit}:{strip:MuxStrip;onSelect:(ref:MuxRef)=>void;onEdit?:(edit:MuxEdit,name:string,directory:string)=>Promise<boolean>}) {
  useUi();
  const [open,setOpen]=useState(false);
  const [prompt,setPrompt]=useState<Prompt>();
  const [menu,setMenu]=useState<Target>();
  const keyboard=useRef(false);
  const confirmId=useId();
  const [saving,setSaving]=useState(false);
  const alive=useRef(true);
  const hold=useRef<{timer:number;x:number;y:number;fired:boolean}|undefined>(undefined);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(hold.current)window.clearTimeout(hold.current.timer);};},[]);
  const scroller=useRef<HTMLDivElement>(null);
  const root=useRef<HTMLDivElement>(null);
  const menuRoot=useRef<HTMLDivElement>(null);
  const {group,tabs}=strip;
  const choices=group.choices.length>1;
  const active=tabs.find(tab=>tab.active)?.id;
  // The active chip follows the multiplexer's focus into view, centered, so a switch from elsewhere is never off screen.
  useLayoutEffect(()=>{
    const row=scroller.current,chip=row?.querySelector<HTMLElement>('[data-active]');
    if(row && chip)row.scrollLeft=chip.offsetLeft-(row.clientWidth-chip.offsetWidth)/2;
  },[active,tabs.length]);
  useEffect(()=>{
    if(!open && !prompt && !menu)return;
    // An outside press closes the workspace list and a press away from the menu closes it; a half-typed name survives one and ends only with Escape, Cancel or Save.
    const close=(event:Event)=>{
      if(event.type==='keydown'){if((event as KeyboardEvent).key==='Escape'){setOpen(false);setMenu(undefined);setPrompt(undefined);}return;}
      if(!menuRoot.current?.contains(event.target as Node))setMenu(undefined);
      if(!prompt && !root.current?.contains(event.target as Node))setOpen(false);
    };
    document.addEventListener('keydown',close,true);document.addEventListener('pointerdown',close,true);
    return()=>{document.removeEventListener('keydown',close,true);document.removeEventListener('pointerdown',close,true);};
  },[open,prompt,menu]);
  // Only a keyboard user moves focus into the menu or the confirmation: a press never focuses a chip, so a touch or mouse hold leaves an open soft keyboard open.
  useEffect(()=>{if(keyboard.current && (menu || prompt?.confirm!==undefined))root.current?.querySelector<HTMLElement>('.mux-menu button, .mux-prompt button')?.focus();},[menu,prompt?.confirm]);
  const ask=(edit:MuxEdit,title:string,name:string,directory?:string,confirm?:string)=>{setOpen(false);setMenu(undefined);setPrompt({edit,title,name,directory,confirm});};
  const askRename=(tab:Target)=>ask(tab.rename!,t('muxRenameTab',{name:tab.title}),tab.title);
  const askClose=(tab:Target)=>ask(tab.close!,t('muxCloseTab',{name:tab.title}),'',undefined,t('muxCloseConfirm',{name:tab.title}));
  // Rename and Close are a menu; with only one of them the long press goes straight to it.
  const actions=(tab:Target,event:{currentTarget:Element})=>{
    const rename=onEdit && tab.rename,close=onEdit && tab.close;
    keyboard.current=document.activeElement===event.currentTarget;
    if(rename && close){setOpen(false);setPrompt(undefined);setMenu(tab);}
    else if(rename)askRename(tab);
    else if(close)askClose(tab);
  };
  const clear=()=>{if(hold.current)window.clearTimeout(hold.current.timer);};
  // A press keeps focus where it is, so a soft keyboard that is already open does not close and reopen, and a closed one never opens.
  // On a chip with something to do, holding still for half a second (or the context-menu key or a right click) offers it instead of selecting.
  const press=(tab?:Target)=>{
    const actionable=onEdit && (tab?.rename || tab?.close);
    return {
      onPointerDown:(event:PointerEvent)=>{
        event.preventDefault();clear();hold.current=undefined;
        if(!actionable || (event.pointerType==='mouse' && event.button!==0))return;
        const state={timer:0,x:event.clientX,y:event.clientY,fired:false};
        const chip=event.currentTarget;
        state.timer=window.setTimeout(()=>{state.fired=true;actions(tab!,{currentTarget:chip});},holdMs);
        hold.current=state;
      },
      onPointerMove:(event:PointerEvent)=>{if(hold.current && Math.hypot(event.clientX-hold.current.x,event.clientY-hold.current.y)>holdSlop)clear();},
      onPointerUp:clear,onPointerCancel:clear,
      // The tap that ends a long press must not also select.
      onClickCapture:(event:{preventDefault:()=>void;stopPropagation:()=>void})=>{if(hold.current?.fired){event.preventDefault();event.stopPropagation();hold.current=undefined;}},
      ...(actionable?{onContextMenu:(event:{preventDefault:()=>void;currentTarget:Element})=>{event.preventDefault();actions(tab!,event);}}:{}),
    };
  };
  // Resolves once the command ran; a failed one leaves the prompt open, its host error reported by the caller.
  async function commit(name:string,directory:string) {
    if(!prompt || !onEdit || saving)return;
    setSaving(true);
    const done=await onEdit(prompt.edit,name,directory);
    if(!alive.current)return;
    setSaving(false);
    if(done)setPrompt(undefined);
  }
  function save(event:FormEvent) {
    event.preventDefault();
    const name=prompt?.name.trim();
    if(name)void commit(name,prompt?.directory??'.');
  }
  const heading=<><Dot tab={group}/><span className="mux-group-name">{group.title}</span></>;
  return <div ref={root} className="mux-strip" role="group" aria-label={t('muxStripLabel',{kind:strip.kind})} data-kind={strip.kind}>
    {choices
      ?<button type="button" className="mux-group" data-attention={group.attention||undefined} aria-expanded={open} title={t('muxWorkspaces')} aria-label={`${t('muxWorkspaces')}: ${group.title}${group.attention?`, ${t('herdrAgentBlocked')}`:''}`} {...press()} onClick={()=>{setPrompt(undefined);setOpen(!open);}}>{heading}<ChevronDown size={14} aria-hidden="true"/></button>
      :<span className="mux-group" title={group.title}>{heading}</span>}
    {open && <div className="mux-choices" role="group" aria-label={t('muxWorkspaces')}>{group.choices.map((choice,index)=>
      <button type="button" key={choice.id} className="mux-choice" data-active={choice.active||undefined} data-attention={choice.attention||undefined} aria-current={choice.active?'true':undefined} aria-label={label(choice,index+1,group.choices.length)} {...press(choice)} onClick={()=>{setOpen(false);if(!choice.active)onSelect(choice.ref);}}><Dot tab={choice}/><span>{choice.title}</span></button>)}</div>}
    <div ref={scroller} className="mux-tabs">{tabs.map((tab,index)=>
      <button type="button" key={tab.id} className="mux-chip" data-active={tab.active||undefined} data-attention={tab.attention||undefined} title={tab.title} aria-current={tab.active?'true':undefined} aria-label={label(tab,index+1,tabs.length)} {...press(tab)} onClick={()=>{if(!tab.active)onSelect(tab.ref);}}><Dot tab={tab}/><span>{tab.title}</span></button>)}</div>
    {strip.create && onEdit && <button type="button" className="mux-add" title={t('muxNewTab')} aria-label={t('muxNewTab')} {...press()}
      onClick={()=>{const {edit,directory}=strip.create!;ask(edit,t('muxNewTab'),'',directory);}}><Plus size={17} aria-hidden="true"/></button>}
    {menu && <div ref={menuRoot} className="mux-menu" role="group" aria-label={menu.title} onPointerDown={keepFocus}>
      <button type="button" className="mux-menu-item" onClick={()=>askRename(menu)}>{t('muxMenuRename')}</button>
      <button type="button" className="mux-menu-item" data-danger onClick={()=>askClose(menu)}>{t('muxMenuClose')}</button>
    </div>}
    {prompt?.confirm!==undefined && <div className="mux-prompt" role="alertdialog" aria-label={prompt.title} aria-describedby={confirmId} onPointerDown={keepFocus}>
      <p id={confirmId}>{prompt.confirm}</p>
      <div><button type="button" className="subtle-button" disabled={saving} onClick={()=>setPrompt(undefined)}>{t('appCancel')}</button><button type="button" className="danger-button" disabled={saving} onClick={()=>void commit('','.')}>{t('muxMenuClose')}</button></div>
    </div>}
    {prompt && prompt.confirm===undefined && <form className="mux-prompt" aria-label={prompt.title} onSubmit={save}>
      <label>{t('muxPromptName')}<input autoFocus required maxLength={200} value={prompt.name} disabled={saving} onFocus={event=>event.currentTarget.select()} onChange={event=>setPrompt({...prompt,name:event.target.value})}/></label>
      {prompt.directory!==undefined && <label>{t('muxPromptDirectory')}<input required maxLength={4096} value={prompt.directory} disabled={saving} onChange={event=>setPrompt({...prompt,directory:event.target.value})}/></label>}
      <div><button type="button" className="subtle-button" disabled={saving} onClick={()=>setPrompt(undefined)}>{t('appCancel')}</button><button type="submit" className="primary-button" disabled={saving || !prompt.name.trim()}>{t('muxPromptSave')}</button></div>
    </form>}
  </div>;
}
