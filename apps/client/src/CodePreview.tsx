import {t, useUi} from './i18n/core';
import { useEffect, useState, type ReactNode } from 'react';

type SyntaxNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: SyntaxNode[] };
function renderNodes(nodes: SyntaxNode[]): ReactNode {
  return nodes.map((node, index) => node.type === 'text' ? node.value : node.type === 'element' && node.tagName === 'span' ? <span key={index} className={Array.isArray(node.properties?.className) ? node.properties.className.filter(value => typeof value === 'string' && /^hljs[\w-]*$/.test(value)).join(' ') : undefined}>{renderNodes(node.children || [])}</span> : null);
}
const languages: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', rs: 'rust', py: 'python', go: 'go', sh: 'bash', bash: 'bash', json: 'json', css: 'css', html: 'xml', xml: 'xml', yml: 'yaml', yaml: 'yaml', sql: 'sql', md: 'markdown', c: 'c', h: 'c', cpp: 'cpp', java: 'java', kt: 'kotlin', swift: 'swift' };

export default function CodePreview({ path, text }: { path: string; text: string }) {
  useUi();
  const [highlight, setHighlight] = useState(false);
  const [parsed, setParsed] = useState<{text:string;language:string;nodes:SyntaxNode[]}>();
  const language = languages[path.split('.').at(-1)?.toLowerCase() || ''];
  const nodes = highlight && parsed?.text === text && parsed.language === language ? parsed.nodes : undefined;
  useEffect(() => {
    let active = true;
    setParsed(undefined);
    if (highlight && language && text.length <= 100000) void import('lowlight').then(({ createLowlight, common }) => {
      const parser = createLowlight(common);
      if (active && parser.registered(language)) setParsed({text,language,nodes:parser.highlight(language, text).children});
    }).catch(() => { /* Plain text remains available. */ });
    return () => { active = false; };
  }, [highlight, language, text]);
  return <>
    {language && text.length <= 100000 && <button onClick={() => setHighlight(!highlight)}>{highlight ? t('codePlain') : t('codeHighlight')}</button>}
    <pre tabIndex={0} className="file-content repository-code"><code>{nodes ? renderNodes(nodes) : text}</code></pre>
  </>;
}
