import {Bell,Bot,ChevronLeft,ChevronRight,CloudUpload,Globe,Hand,Inbox,Info,Keyboard,KeyRound,MessageSquareText,Mic,Palette,RefreshCw,RotateCcw,Search,Server,ShieldCheck,SquareTerminal,type LucideIcon} from 'lucide-react';
import {useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {t,useUi} from './i18n/core';
import './SettingsNavigation.css';

/**
 * A settings destination. An entry with `content` opens as a sub-page; one with `onSelect` is an
 * action row that hands off to another surface. Root entries are grouped by their `section`.
 */
export type SettingsPage={id:string;title:string;parent?:string;section?:string;value?:string;tone?:'danger';disabled?:boolean}
  &({content:ReactNode;onSelect?:never}|{content?:never;onSelect:()=>void});
export type SettingsSection={id:string;title?:string;footer?:string};
type SearchResult={page:SettingsPage;label:string;match?:string};

/** Leading tiles follow platform settings lists; unknown pages simply omit one. */
const icons:Record<string,[LucideIcon,number]>={connections:[Server,0],language:[Globe,1],appearance:[Palette,2],terminal:[SquareTerminal,3],input:[Keyboard,4],reset:[RotateCcw,5],security:[ShieldCheck,0],notifications:[Bell,5],
  preferencesTerminalTouchGestures:[Hand,2],preferencesToolbarKeysAndOrder:[Keyboard,1],preferencesTextSnippets:[MessageSquareText,3],preferencesKeyboardChords:[KeyRound,4],
  agents:[Bot,2],voice:[Mic,4],inbox:[Inbox,5],sync:[RefreshCw,1],sharing:[CloudUpload,0],about:[Info,3]};
/** Setting names inside a page. Prose, chosen values and nested editors' keys are not names. */
const names='label, summary, legend, h3, :scope > button';
const notNames='select, textarea, input, option, ul, .sr-only, [aria-hidden="true"]';

function fold(text:string) { return text.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase().replace(/\s+/g,' ').trim(); }
/** The visible name of a row without the text of the value control it wraps. */
function ownText(node:Element):string {
  let text='';
  for(const child of Array.from(node.childNodes)) {
    if(child.nodeType===Node.TEXT_NODE)text+=child.textContent;
    else if(child instanceof Element && !child.matches(notNames))text+=` ${ownText(child)} `;
  }
  return text.replace(/\s+/g,' ').trim();
}
function settingNames(page:Element) {
  return Array.from(page.querySelectorAll(names)).filter(element=>!element.closest('.settings-category-list'));
}

/** Navigation state is local; every editor remains mounted while its page is hidden. */
export default function SettingsNavigation({pages,sections=[],footer}:{pages:SettingsPage[];sections?:SettingsSection[];footer?:ReactNode}) {
  useUi();
  const ids=useId();
  const [selected,setSelected]=useState<string>();
  const [query,setQuery]=useState('');
  const root=useRef<HTMLDivElement>(null);
  const field=useRef<HTMLInputElement>(null);
  const restore=useRef<string|undefined>(undefined);
  const reveal=useRef<string|undefined>(undefined);
  const positions=useRef(new Map<string|undefined,number>());
  const current=pages.find(page=>page.id===selected && page.content!==undefined);
  const back=useRef<()=>boolean>(()=>false);
  function go(id?:string,returning?:string) {
    const scroller=root.current?.closest('.dialog-content');
    positions.current.set(selected,scroller?.scrollTop??0);
    restore.current=returning;setSelected(id);
  }
  function open(page:SettingsPage,match?:string) {
    if(page.onSelect){page.onSelect();return;}
    reveal.current=match;go(page.id);
  }
  back.current=()=>{
    if(!current)return false;
    go(current.parent,current.id);return true;
  };
  useLayoutEffect(()=>{
    const node=root.current;if(!node)return;
    const scroller=node.closest('.dialog-content');
    if(scroller)scroller.scrollTop=positions.current.get(selected)??0;
    const page=node.querySelector<HTMLElement>('[data-settings-page]:not([hidden])');
    const match=reveal.current;reveal.current=undefined;
    const found=match && page ? settingNames(page).find(element=>ownText(element)===match) : undefined;
    if(found) {
      for(let owner=found.parentElement?.closest('details');owner;owner=owner.parentElement?.closest('details'))owner.open=true;
      const control=found.matches('label') ? found.querySelector<HTMLElement>('input, select, textarea') : found.matches('summary, button') ? found as HTMLElement : null;
      (control??page?.querySelector<HTMLElement>('h2'))?.focus({preventScroll:true});
      found.scrollIntoView?.({block:'center'});
      return;
    }
    const target=restore.current
      ?Array.from(node.querySelectorAll<HTMLButtonElement>('[data-settings-target]')).find(button=>button.dataset.settingsTarget===restore.current && !button.closest('[hidden]'))
      :page?.querySelector<HTMLElement>('h2');
    target?.focus({preventScroll:true});
  },[selected]);
  useLayoutEffect(()=>{
    const nativeBack=(event:Event)=>{
      if(Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).at(-1)!==root.current?.closest('[role="dialog"]'))return;
      if(back.current()){event.preventDefault();event.stopImmediatePropagation();}
    };
    const keydown=(event:KeyboardEvent)=>{
      if(event.key!=='Escape')return;
      // Escape first clears a search, before it leaves a page or closes Preferences.
      if(event.target===field.current && field.current?.value){event.preventDefault();event.stopImmediatePropagation();setQuery('');return;}
      nativeBack(event);
    };
    window.addEventListener('lazysh-workspace-back',nativeBack,true);
    window.addEventListener('keydown',keydown,true);
    return()=>{window.removeEventListener('lazysh-workspace-back',nativeBack,true);window.removeEventListener('keydown',keydown,true);};
  },[]);
  function icon(id:string) {
    const entry=icons[id];if(!entry)return null;
    const [Icon,tone]=entry;
    return <span className="settings-icon" data-tone={tone} aria-hidden="true"><Icon size={17}/></span>;
  }
  /** The accessible name stays the setting's title; its value preview is the description. */
  function row(page:SettingsPage,key:string,label=page.title,detail=page.value,match?:string) {
    const name=`${ids}${key}-name`,value=`${ids}${key}-value`;
    return <button type="button" key={key} data-settings-target={page.id} data-tone={page.tone} disabled={page.disabled} aria-labelledby={name} aria-describedby={detail?value:undefined}
      aria-current={selected===page.id || current?.parent===page.id?'page':undefined} onClick={()=>open(page,match)}>
      {icon(page.id)}
      <span className="settings-row-text"><span id={name}>{label}</span>{detail && <span className="settings-row-value" id={value}>{detail}</span>}</span>
      {!page.tone && <ChevronRight size={17} aria-hidden="true"/>}
    </button>;
  }
  function links(parent:string|undefined,entries:SettingsPage[],label=parent?pages.find(page=>page.id===parent)?.title:t('appPreferences')) {
    return <nav className="settings-category-list" aria-label={label}>{entries.map(page=>row(page,page.id))}</nav>;
  }
  function grouped() {
    const top=pages.filter(page=>!page.parent);
    const known=new Set(sections.map(section=>section.id));
    const rest=top.filter(page=>!known.has(page.section??''));
    return [...sections.map(section=>({section,entries:top.filter(page=>page.section===section.id)})),{section:{id:''} as SettingsSection,entries:rest}]
      .filter(({entries})=>entries.length).map(({section,entries})=>{
        const heading=section.title?`${ids}section-${section.id}`:undefined;
        return <section className="settings-section" key={section.id||'other'} aria-labelledby={heading}>
          {heading && <h3 className="settings-section-title" id={heading}>{section.title}</h3>}
          {links(undefined,entries,section.title)}
          {section.footer && <p className="settings-section-footer">{section.footer}</p>}
        </section>;
      });
  }
  /** Page titles, values and every setting name rendered inside the mounted pages. */
  function search():SearchResult[] {
    const wanted=fold(query);
    const results:SearchResult[]=[];
    const bodies=new Map(Array.from(root.current?.querySelectorAll<HTMLElement>('[data-settings-page]')??[]).map(body=>[body.dataset.settingsPage,body]));
    for(const page of pages) {
      if([page.title,page.value??''].some(text=>fold(text).includes(wanted)))results.push({page,label:page.title});
      const body=bodies.get(page.id);
      const seen=new Set([page.title]);
      for(const text of body?settingNames(body).map(ownText):[]) {
        if(text && !seen.has(text) && fold(text).includes(wanted)){seen.add(text);results.push({page,label:text,match:text});}
      }
    }
    return results.slice(0,40);
  }
  const path=(page:SettingsPage)=>[pages.find(owner=>owner.id===page.parent)?.title,page.title].filter(Boolean).join(' › ');
  const results=query.trim()?search():undefined;
  return <div className="settings-navigation" ref={root} data-selected={!!current}>
    <aside className="settings-index">
      <label className="settings-search"><Search size={16} aria-hidden="true"/><span className="sr-only">{t('settingsSearch')}</span>
        <input ref={field} type="search" value={query} placeholder={t('settingsSearch')} autoComplete="off" enterKeyHint="search" data-initial-focus="skip"
          onChange={event=>setQuery(event.target.value)}/></label>
      {results
        ?<section className="settings-section" aria-label={t('settingsSearchResults')}>
          {results.length
            ?<nav className="settings-category-list settings-results" aria-label={t('settingsSearchResults')}>
              {results.map((result,index)=>row(result.page,`result-${index}`,result.label,result.match || result.page.parent ? path(result.page) : result.page.value,result.match))}
            </nav>
            :<p className="settings-section-footer" role="status">{t('settingsNoResults',{query:query.trim()})}</p>}
        </section>
        :grouped()}
      {!results && footer && <p className="settings-footer">{footer}</p>}
    </aside>
    <div className="settings-detail">
      {current && <header className="settings-detail-header"><button type="button" className="settings-back" onClick={()=>back.current()}><ChevronLeft size={22} aria-hidden="true"/>{t('navigationBack')}</button></header>}
      {pages.flatMap(page=>page.content===undefined?[]:[<section key={page.id} data-settings-page={page.id} hidden={selected!==page.id} aria-label={page.title}>
        {selected===page.id && <h2 tabIndex={-1}>{page.title}</h2>}{page.content}{links(page.id,pages.filter(child=>child.parent===page.id))}
      </section>])}
    </div>
  </div>;
}
