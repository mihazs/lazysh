import {memo, useState, type ComponentProps, type ReactNode} from 'react';
import Markdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {useProtectedApi} from './access';
import {api as nativeApi} from './bridge';
import ChatCode from './ChatCode';
import {hasHtml, htmlPlugins, isDataImage, maxHtmlLength, urlTransform} from './chatHtml';
import {t} from './i18n/core';
import {openWebPage, webUrl} from './webPage';
import './ChatRich.css';

/** Asks before an address leaves the app, then opens it in the system browser (a new tab on the web). */
function LinkConsent({url,onClose}:{url:string;onClose:()=>void}) {
  const api=useProtectedApi(nativeApi);
  const [failed,setFailed]=useState(false);
  const [opening,setOpening]=useState(false);
  const open=()=>{
    setOpening(true);
    openWebPage(page=>api.openWebUrl(page),url).then(onClose,()=>{setFailed(true);setOpening(false);});
  };
  return <span className="chat-link-consent" role="region" aria-label={t('chatHtmlLinkConfirm')}>
    <code>{url}</code>
    {failed && <span role="alert">{t('terminalBrowserUnavailable')}</span>}
    <button type="button" disabled={opening} onClick={open}>{opening?t('terminalOpening'):t('terminalOpenBrowser')}</button>
    <button type="button" onClick={onClose}>{t('terminalDismissLink')}</button>
  </span>;
}

/** Wraps what is tapped and, once it is, asks about `url` right after it. */
function Consent({url,children}:{url:string;children:(ask:()=>void)=>ReactNode}) {
  const [asking,setAsking]=useState(false);
  return <>{children(()=>setAsking(true))}{asking && <LinkConsent url={url} onClose={()=>setAsking(false)}/>}</>;
}

const components:Components={
  a({href,children}:ComponentProps<'a'>) {
    const url=href ? webUrl(href) : undefined;
    return url ? <Consent url={url}>{ask=> <a href={url} rel="noopener noreferrer" onClick={event=>{event.preventDefault();ask();}}>{children}</a>}</Consent> : <span>{children}</span>;
  },
  img({src,alt}:ComponentProps<'img'>) {
    if(typeof src!=='string')return <span>{t('chatImagePlaceholder')}</span>;
    if(isDataImage(src))return <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer"/>;
    const url=webUrl(src);
    // A remote picture is never requested by the app: it would tell its host that, and when, the message was read.
    return url ? <Consent url={url}>{ask=> <span className="chat-remote-image">
      <span>{t('chatImagePlaceholder')}</span>{alt && <q>{alt}</q>}
      <button type="button" onClick={ask}>{t('chatHtmlOpenImage')}</button>
    </span>}</Consent> : <span>{t('chatImagePlaceholder')}</span>;
  },
  table:({children})=> <div className="chat-table-scroll" role="region" tabIndex={0} aria-label={t('chatHtmlTable')}><table>{children}</table></div>,
};

/** In the Agent view's timeline a code block is a block of its own: language, Copy code and syntax colours. */
const withCopy:Components={...components,pre:ChatCode};

/** Markdown with the HTML an agent or a person put in it, rendered through the allow-list of `chatHtml`. Links ask before they
 * open, a remote image is not requested, and the original text is one tap away. */
export const ChatRich=memo(function ChatRich({text,copy=false}:{text:string;copy?:boolean}) {
  const [source,setSource]=useState(false);
  const html=text.length<=maxHtmlLength && hasHtml(text);
  return <>
    {source ? <pre className="chat-html-source">{text}</pre>
      : <Markdown remarkPlugins={[remarkGfm]} components={copy ? withCopy : components} urlTransform={urlTransform} rehypePlugins={html ? htmlPlugins : undefined}>{text}</Markdown>}
    {html && <button type="button" className="chat-html-toggle" aria-pressed={source} onClick={()=>setSource(value=>!value)}>{t(source?'chatHtmlShowRendered':'chatHtmlShowSource')}</button>}
  </>;
});
