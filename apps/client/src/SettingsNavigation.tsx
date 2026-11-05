import {Bell,ChevronLeft,ChevronRight,Globe,Hand,Keyboard,KeyRound,MessageSquareText,Palette,RotateCcw,Server,ShieldCheck,SquareTerminal,type LucideIcon} from 'lucide-react';
import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {t,useUi} from './i18n/core';
import './SettingsNavigation.css';

export type SettingsPage={id:string;title:string;parent?:string;content:ReactNode};
/** Leading tiles follow platform settings lists; unknown pages simply omit one. */
const icons:Record<string,[LucideIcon,number]>={connections:[Server,0],language:[Globe,1],appearance:[Palette,2],terminal:[SquareTerminal,3],input:[Keyboard,4],reset:[RotateCcw,5],security:[ShieldCheck,0],notifications:[Bell,5],
  preferencesTerminalTouchGestures:[Hand,2],preferencesToolbarKeysAndOrder:[Keyboard,1],preferencesTextSnippets:[MessageSquareText,3],preferencesKeyboardChords:[KeyRound,4]};
/** Navigation state is local; every editor remains mounted while its page is hidden. */
export default function SettingsNavigation({pages}:{pages:SettingsPage[]}) {
  useUi();
  const [selected,setSelected]=useState<string>();
  const root=useRef<HTMLDivElement>(null);
  const restore=useRef<string|undefined>(undefined);
  const positions=useRef(new Map<string|undefined,number>());
  const current=pages.find(page=>page.id===selected);
  const back=useRef<()=>boolean>(()=>false);
  function go(id?:string,returning?:string) {
    const scroller=root.current?.closest('.dialog-content');
    positions.current.set(selected,scroller?.scrollTop??0);
    restore.current=returning;setSelected(id);
  }
  back.current=()=>{
    if(!current)return false;
    go(current.parent,current.id);return true;
  };
  useLayoutEffect(()=>{
    const node=root.current;if(!node)return;
    const scroller=node.closest('.dialog-content');
    if(scroller)scroller.scrollTop=positions.current.get(selected)??0;
    const target=restore.current
      ?Array.from(node.querySelectorAll<HTMLButtonElement>('[data-settings-target]')).find(button=>button.dataset.settingsTarget===restore.current && !button.closest('[hidden]'))
      :node.querySelector<HTMLElement>('[data-settings-page]:not([hidden]) h2');
    target?.focus({preventScroll:true});
  },[selected]);
  useLayoutEffect(()=>{
    const nativeBack=(event:Event)=>{
      if(Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).at(-1)!==root.current?.closest('[role="dialog"]'))return;
      if(back.current()){event.preventDefault();event.stopImmediatePropagation();}
    };
    const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape')nativeBack(event);};
    window.addEventListener('lazysh-workspace-back',nativeBack,true);
    window.addEventListener('keydown',keydown,true);
    return()=>{window.removeEventListener('lazysh-workspace-back',nativeBack,true);window.removeEventListener('keydown',keydown,true);};
  },[]);
  function icon(id:string) {
    const entry=icons[id];if(!entry)return null;
    const [Icon,tone]=entry;
    return <span className="settings-icon" data-tone={tone} aria-hidden="true"><Icon size={17}/></span>;
  }
  function links(parent?:string) {
    return <nav className="settings-category-list" aria-label={parent?pages.find(page=>page.id===parent)?.title:t('appPreferences')}>
      {pages.filter(page=>page.parent===parent).map(page=><button type="button" key={page.id} data-settings-target={page.id} aria-current={selected===page.id || current?.parent===page.id?'page':undefined} onClick={()=>go(page.id)}>{icon(page.id)}<span>{page.title}</span><ChevronRight size={17} aria-hidden="true"/></button>)}
    </nav>;
  }
  return <div className="settings-navigation" ref={root} data-selected={!!current}>
    <aside className="settings-index">{links()}</aside>
    <div className="settings-detail">
      {current && <header className="settings-detail-header"><button type="button" className="settings-back" onClick={()=>back.current()}><ChevronLeft size={22} aria-hidden="true"/>{t('navigationBack')}</button></header>}
      {pages.map(page=><section key={page.id} data-settings-page={page.id} hidden={selected!==page.id} aria-label={page.title}>
        {selected===page.id && <h2 tabIndex={-1}>{page.title}</h2>}{page.content}{links(page.id)}
      </section>)}
    </div>
  </div>;
}
