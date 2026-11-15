import {t, useUi} from './i18n/core';
import {useEffect, useState} from 'react';
import CodePreview from './CodePreview';
import {ChatMarkdown} from './ChatInteraction';
import MediaFrame from './MediaFrame';
import {previewKind, type MediaClip} from './mediaPreview';
import './FilePreview.css';

export type FileContent = Readonly<{path: string; text: string} | {path: string; image: string} | {path: string; clip: MediaClip} | {path: string; pdf: true}>;

/** An SVG document becomes an image resource: no inline markup, scripts or external loads. */
function SvgImage({text, alt}: {text: string; alt: string}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([text], {type: 'image/svg+xml'}));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [text]);
  return url ? <img className="file-media" src={url} alt={alt}/> : null;
}

/** Read-only viewer for one host file: raster or SVG images, isolated video or audio, rendered Markdown, or source. */
export default function FilePreview({content}: {content: FileContent}) {
  useUi();
  const [rendered, setRendered] = useState(true);
  const alt = t('repoPreview', {file: content.path});
  if ('image' in content) return <img className="file-media" src={content.image} alt={alt}/>;
  if ('clip' in content) return <MediaFrame clip={content.clip} label={alt}/>;
  if ('pdf' in content) return <p className="file-note">{t('filesPdfExternal')}</p>;
  const kind = previewKind(content.path);
  if (kind !== 'svg' && kind !== 'markdown') return <CodePreview path={content.path} text={content.text}/>;
  return <>
    <button type="button" className="file-preview-toggle" onClick={() => setRendered(!rendered)}>
      {rendered ? t('repoSource') : t(kind === 'svg' ? 'filesShowImage' : 'repoMarkdown')}
    </button>
    {!rendered ? <CodePreview path={content.path} text={content.text}/>
      : kind === 'svg' ? <SvgImage text={content.text} alt={alt}/>
      : <div className="file-markdown"><ChatMarkdown text={content.text} image={t('repoRemoteImage')}/></div>}
  </>;
}
