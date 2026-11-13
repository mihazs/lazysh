import {t, useUi} from './i18n/core';
import { useEffect, useState } from 'react';
import { highlight as highlightSource, languages, maxHighlighted, renderNodes } from './syntax';

export default function CodePreview({ path, text }: { path: string; text: string }) {
  useUi();
  const [highlight, setHighlight] = useState(false);
  const [parsed, setParsed] = useState<{text:string;language:string;nodes:NonNullable<Awaited<ReturnType<typeof highlightSource>>>}>();
  const language = languages[path.split('.').at(-1)?.toLowerCase() || ''];
  const nodes = highlight && parsed?.text === text && parsed.language === language ? parsed.nodes : undefined;
  useEffect(() => {
    let active = true;
    setParsed(undefined);
    if (highlight && language && text.length <= maxHighlighted) void highlightSource(language, text).then(nodes => {
      if (active && nodes) setParsed({text,language,nodes});
    }).catch(() => { /* Plain text remains available. */ });
    return () => { active = false; };
  }, [highlight, language, text]);
  return <>
    {language && text.length <= maxHighlighted && <button onClick={() => setHighlight(!highlight)}>{highlight ? t('codePlain') : t('codeHighlight')}</button>}
    <pre tabIndex={0} className="file-content repository-code"><code>{nodes ? renderNodes(nodes) : text}</code></pre>
  </>;
}
