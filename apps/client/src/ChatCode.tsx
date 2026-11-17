import {isValidElement, useEffect, useState, type ComponentProps, type ReactNode} from 'react';
import {CopyButton} from './AgentReading';
import {t} from './i18n/core';
import {highlight, languages, maxHighlighted, renderNodes} from './syntax';
import './ChatCode.css';

type Nodes = Awaited<ReturnType<typeof highlight>>;
const textOf = (node: ReactNode): string => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : isValidElement<{children?: ReactNode}>(node) ? textOf(node.props.children) : '';

/** A fenced code block: its language, a Copy button, syntax colours once the highlighter has loaded, and a sideways scroll
 * instead of wrapping so a line keeps its shape. The text stays the source of truth: colours only wrap it in spans. */
export default function ChatCode({children}: ComponentProps<'pre'>) {
  const code = isValidElement<{className?: string; children?: ReactNode}>(children) ? children : undefined;
  const name = /(?:^|\s)language-([\w+#-]+)/.exec(code?.props.className ?? '')?.[1]?.toLowerCase();
  const source = textOf(code?.props.children ?? children).replace(/\n$/, '');
  const language = name && languages[name];
  const [parsed, setParsed] = useState<{source: string; nodes: Nodes}>();
  useEffect(() => {
    let active = true;
    if (language && source.length <= maxHighlighted) void highlight(language, source).then(nodes => { if (active) setParsed({source, nodes}); }).catch(() => { /* Plain text stays readable. */ });
    return () => { active = false; };
  }, [language, source]);
  const nodes = parsed?.source === source ? parsed.nodes : undefined;
  return <figure className="chat-code" aria-label={name ? `${t('chatCodeBlock')}: ${name}` : t('chatCodeBlock')}>
    <figcaption>
      <span className="chat-code-language">{name}</span>
      <CopyButton text={source} label={t('agentCopyCode')} className="chat-code-copy" labelled />
    </figcaption>
    <pre className="chat-code-pre" tabIndex={0} aria-label={t('chatCodeBlock')}><code className={code?.props.className}>{nodes ? renderNodes(nodes) : source}</code></pre>
  </figure>;
}
