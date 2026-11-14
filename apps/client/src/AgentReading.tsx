import {useEffect, useMemo, useRef, useState, type RefObject} from 'react';
import {Check, ChevronDown, ChevronUp, Copy, X} from 'lucide-react';
import type {Components} from 'react-markdown';
import {t} from './i18n/core';
import './AgentReading.css';

/** What the Agent view's reading tools remember: Full history (tool work folded in each turn) or Conversation only, and the search. */
export type Reading = {full: boolean; search: boolean; query: string};
export const noReading: Reading = {full: true, search: false, query: ''};
type Searchable = {id: string; blocks: {text?: string}[]};

/** The original Markdown of a message: its text blocks, without tool output. */
export const messageMarkdown = (message: {blocks: {type: string; text?: string}[]}) =>
  message.blocks.filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n\n');

/** The plain text of a rendered Markdown node (a code block), for the Copy button next to it. */
export const nodeText = (node: unknown): string => {
  const {type, value, children} = node as {type: string; value?: string; children?: unknown[]};
  return type === 'text' ? value ?? '' : (children ?? []).map(nodeText).join('');
};

/** Copies `text` and says so; the label is also the accessible name, so it always states what happens. */
export function CopyButton({text, label, className}: {text: string; label: string; className?: string}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const done = (next: 'copied' | 'failed') => { setState(next); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setState('idle'), 1800); };
  const title = state === 'copied' ? t('agentCopied') : state === 'failed' ? t('agentCopyUnavailable') : label;
  return <button type="button" className={`icon-button agent-copy ${className ?? ''}`} aria-label={title} title={title} data-state={state}
    onClick={() => void (navigator.clipboard?.writeText(text).then(() => done('copied'), () => done('failed')) ?? done('failed'))}>
    {state === 'copied' ? <Check size={14} aria-hidden="true"/> : <Copy size={14} aria-hidden="true"/>}
  </button>;
}

/** A code block with a button that copies its text. */
export const codeBlockWithCopy: Components['pre'] = ({node, children}) => <div className="chat-code"><pre>{children}</pre><CopyButton text={nodeText(node).replace(/\n$/, '')} label={t('agentCopyCode')}/></div>;

const highlights = (): Map<string, unknown> | undefined => typeof CSS === 'undefined' ? undefined : (CSS as unknown as {highlights?: Map<string, unknown>}).highlights;

/** Search over the loaded conversation: finds text in tool output too, opens the folded rows that hold the current match and highlights every match. */
export function AgentSearch({messages, query, onQuery, onClose, list}: {messages: Searchable[]; query: string; onQuery: (query: string) => void; onClose: () => void; list: RefObject<HTMLElement | null>}) {
  const needle = query.trim().toLowerCase();
  const ids = useMemo(() => needle ? messages.filter(message => message.blocks.some(block => block.text?.toLowerCase().includes(needle))).map(message => message.id) : [], [messages, needle]);
  const [picked, setPicked] = useState<string>();
  // The newest match first, like a chat search; a live append keeps the match the reader is on.
  const index = picked !== undefined && ids.includes(picked) ? ids.indexOf(picked) : ids.length - 1;
  const current = ids[index];
  useEffect(() => setPicked(undefined), [needle]);
  useEffect(() => {
    const element = [...list.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []].find(node => node.dataset.messageId === current);
    if (!element) return;
    for (let node: Element | null = element; node && node !== list.current; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true;
    element.scrollIntoView({block: 'center'});
  }, [current, list]);
  useEffect(() => {
    const registry = highlights(), Highlight = (globalThis as unknown as {Highlight?: new (...ranges: Range[]) => unknown}).Highlight;
    if (!registry || !Highlight || !needle || !list.current) return;
    const ranges: Range[] = [], walker = document.createTreeWalker(list.current, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent!.toLowerCase();
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        const range = new Range(); range.setStart(node, at); range.setEnd(node, at + needle.length); ranges.push(range);
      }
    }
    registry.set('agent-search', new Highlight(...ranges));
    return () => void registry.delete('agent-search');
  }, [needle, messages, list]);
  const step = (by: number) => ids.length && setPicked(ids[(index + by + ids.length) % ids.length]);
  return <form className="agent-search" role="search" aria-label={t('agentSearch')} onSubmit={event => { event.preventDefault(); step(1); }}>
    <input type="search" autoFocus value={query} placeholder={t('agentSearch')} aria-label={t('agentSearch')} onChange={event => onQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') onClose(); }} />
    <span role="status">{needle ? ids.length ? t('agentSearchCount', {current: index + 1, total: ids.length}) : t('agentSearchNone') : ''}</span>
    <button type="button" className="icon-button" aria-label={t('agentSearchPrevious')} title={t('agentSearchPrevious')} disabled={!ids.length} onClick={() => step(-1)}><ChevronUp size={16} aria-hidden="true"/></button>
    <button type="button" className="icon-button" aria-label={t('agentSearchNext')} title={t('agentSearchNext')} disabled={!ids.length} onClick={() => step(1)}><ChevronDown size={16} aria-hidden="true"/></button>
    <button type="button" className="icon-button" aria-label={t('agentSearchClose')} title={t('agentSearchClose')} onClick={onClose}><X size={16} aria-hidden="true"/></button>
  </form>;
}
