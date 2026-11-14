import type {ReactNode} from 'react';

type SyntaxNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: SyntaxNode[] };
/** Highlighted source as text and `hljs-*` spans only: nothing the source says can become markup. */
export function renderNodes(nodes: SyntaxNode[]): ReactNode {
  return nodes.map((node, index) => node.type === 'text' ? node.value : node.type === 'element' && node.tagName === 'span' ? <span key={index} className={Array.isArray(node.properties?.className) ? node.properties.className.filter(value => typeof value === 'string' && /^hljs[\w-]*$/.test(value)).join(' ') : undefined}>{renderNodes(node.children || [])}</span> : null);
}
/** File extensions and fence names mapped to a highlight.js language. */
export const languages: Record<string, string> = { js: 'javascript', javascript: 'javascript', jsx: 'javascript', ts: 'typescript', typescript: 'typescript', tsx: 'typescript', rs: 'rust', rust: 'rust', py: 'python', python: 'python', go: 'go', sh: 'bash', shell: 'bash', zsh: 'bash', bash: 'bash', json: 'json', css: 'css', html: 'xml', xml: 'xml', yml: 'yaml', yaml: 'yaml', sql: 'sql', md: 'markdown', markdown: 'markdown', c: 'c', h: 'c', cpp: 'cpp', java: 'java', kt: 'kotlin', kotlin: 'kotlin', swift: 'swift', diff: 'diff', toml: 'ini', ini: 'ini' };
export const maxHighlighted = 100000;
let parser: Promise<ReturnType<typeof import('lowlight').createLowlight>> | undefined;
/** Parses `text` as `language` once the highlighter has loaded; resolves nothing for a language it does not know. */
export async function highlight(language: string, text: string): Promise<SyntaxNode[] | undefined> {
  parser ??= import('lowlight').then(({ createLowlight, common }) => createLowlight(common));
  const lowlight = await parser;
  return lowlight.registered(language) ? lowlight.highlight(language, text).children as SyntaxNode[] : undefined;
}
