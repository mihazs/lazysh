import {useEffect, useState, type ReactNode} from 'react';
import {renderNodes, syntaxLanguage, type SyntaxNode} from './CodePreview';

type Row = {kind: string; left?: string; right?: string};
type Parsed = {rows: Row[]; before: string; after: string; left: ReactNode[]; right: ReactNode[]};

// Preserve syntax spans when a token crosses a line boundary.
function splitNodes(nodes: SyntaxNode[]): SyntaxNode[][] {
  const lines: SyntaxNode[][] = [[]];
  for (const node of nodes) {
    const parts = node.type === 'text'
      ? (node.value || '').split('\n').map(value => [{type: 'text', value}])
      : splitNodes(node.children || []).map(children => [{...node, children}]);
    parts.forEach((part, i) => { if (i) lines.push([]); lines[lines.length - 1].push(...part); });
  }
  return lines;
}

export function useDiffHighlight(rows: Row[], before: string, after: string) {
  const [parsed, setParsed] = useState<Parsed>();
  useEffect(() => {
    let active = true;
    setParsed(undefined);
    if (rows.length > 10000 || rows.reduce((size, row) => size + (row.left?.length || 0) + (row.right?.length || 0), 0) > 100000) return;
    void import('lowlight').then(({createLowlight, common}) => {
      const parser = createLowlight(common);
      const left: ReactNode[] = [], right: ReactNode[] = [];
      for (const [side, path, output] of [['left', before, left], ['right', after, right]] as const) {
        const language = syntaxLanguage(path);
        if (!language || !parser.registered(language)) continue;
        let indices: number[] = [];
        const flush = () => {
          if (!indices.length) return;
          const text = indices.map(i => rows[i][side]).join('\n');
          const lines = splitNodes(parser.highlight(language, text).children);
          indices.forEach((index, i) => { output[index] = renderNodes(lines[i] || []); });
          indices = [];
        };
        rows.forEach((row, i) => { if (row.kind === 'hunk') flush(); else if (row[side] !== undefined) indices.push(i); });
        flush();
      }
      if (active) setParsed({rows, before, after, left, right});
    }).catch(() => { /* Plain text remains available. */ });
    return () => { active = false; };
  }, [rows, before, after]);
  return parsed?.rows === rows && parsed.before === before && parsed.after === after ? parsed : undefined;
}
