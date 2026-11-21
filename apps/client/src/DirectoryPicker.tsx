import {CornerLeftUp,FolderOpen} from 'lucide-react';
import {useState} from 'react';
import type {bindProtectedInvoke} from './access';
import {validAbsolutePath} from './herdrCreate';
import {t,useUi} from './i18n/core';
import {captureUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import './HerdrWorkspaceCreateDialog.css';

export type Load<T>={state:'loading'}|{state:'ready';value:T}|{state:'failed';cause:UiErrorCause};
const child=(parent:string,name:string)=>`${parent==='/'?'':parent}/${name}`;
const up=(value:string)=>value.slice(0,Math.max(1,value.lastIndexOf('/')));

/** A host folder field: typed, chosen from known folders, or browsed through the host's directory listing. */
export default function DirectoryPicker({sessionId,invoke,owns,value,onChange,recent}:{sessionId:string;invoke:ReturnType<typeof bindProtectedInvoke>;owns:()=>boolean;value:string;onChange:(directory:string)=>void;recent:readonly string[]}) {
  useUi();
  const [browse,setBrowse]=useState<{path:string;entries:Load<string[]>}>();
  function openDirectory(target:string) {
    setBrowse({path:target,entries:{state:'loading'}});
    void invoke<{name:string;isDir:boolean}[]>('list_directory',{sessionId,path:target}).then(rows=>{
      if(owns())setBrowse(current=>current?.path===target?{path:target,entries:{state:'ready',value:rows.filter(row=>row.isDir && !row.name.startsWith('.')).map(row=>row.name).sort((a,b)=>a.localeCompare(b))}}:current);
    },error=>{if(owns())setBrowse(current=>current?.path===target?{path:target,entries:{state:'failed',cause:captureUiError(error)}}:current);});
  }
  return <>
    <label>{t('herdrDirectory')}<input value={value} maxLength={4096} placeholder="/home/user/project" onChange={event=>onChange(event.target.value)}/></label>
    <div className="herdr-create-row">
      <button type="button" className="subtle-button" onClick={()=>openDirectory(validAbsolutePath(value)?value:'/')}><FolderOpen size={15} aria-hidden="true"/>{t('herdrCreateBrowse')}</button>
      {recent.length>0 && <label>{t('herdrCreateRecent')}<select value={recent.includes(value)?value:''} onChange={event=>onChange(event.target.value)}><option value="" disabled>{t('muxChooseProject')}</option>{recent.map(item=><option key={item} value={item}>{item}</option>)}</select></label>}
    </div>
    {browse && <section className="herdr-create-browser" aria-label={t('herdrCreateBrowse')}>
      <div className="herdr-create-row"><code>{browse.path}</code><button type="button" className="icon-button" disabled={browse.path==='/'} title={t('herdrCreateUp')} aria-label={t('herdrCreateUp')} onClick={()=>{const parent=up(browse.path);onChange(parent);openDirectory(parent);}}><CornerLeftUp size={16} aria-hidden="true"/></button></div>
      {browse.entries.state==='loading' && <p role="status">{t('herdrReading')}</p>}
      {browse.entries.state==='failed' && <p className="inline-error" role="alert">{uiErrorText(browse.entries.cause)}</p>}
      {browse.entries.state==='ready' && (browse.entries.value.length===0?<p>{t('herdrCreateNoFolders')}</p>:<ul>{browse.entries.value.map(name=><li key={name}><button type="button" className="subtle-button" onClick={()=>{const next=child(browse.path,name);onChange(next);openDirectory(next);}}>{name}</button></li>)}</ul>)}
    </section>}
  </>;
}
