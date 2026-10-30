import {t,useUi,formatNumber} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import { readClipboardImage, useClipboardPlatform } from './deviceClipboard';
import { useMountedAccess, useProtectedApi, useProtectedCallback } from './access';
import type {AttachmentPathPaste} from './attachmentPaste';
import {useHostUpload} from './useHostUpload';
import {useHostClipboard} from './useHostClipboard';
import { useEffect, useRef, useState } from 'react';
import { api as nativeApi } from './bridge';
import { ATTACHMENT_LIMIT, checkAttachment, checkDestination, imagePoint, imageSize, shellPath, validateCrop, type Crop, type ImageSize, type Point } from './attachment';

type Selected = { file: File; bytes: Uint8Array; size: ImageSize | null };
type Stroke = { points: Point[]; color: string; width: number };

export default function AttachmentPanel({ sessionId, onAttach, onPastePath, onRestoreFileTransfer }: { sessionId: string; onAttach?: (path:string)=>void; onPastePath?:(request:AttachmentPathPaste)=>Promise<void>; onRestoreFileTransfer?:(restored:()=>void)=>void }) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const clipboardPlatform = useClipboardPlatform();
  const guard = useProtectedCallback();
  const owner=useMountedAccess();
  const originalSession=useRef(sessionId).current;
  const latestSession=useRef(sessionId);latestSession.current=sessionId;
  const completed=useRef<{path:string}|null>(null);
  const pasting=useRef<{target:{path:string};claimed:boolean}|null>(null);
  const [pasteBusy,setPasteBusy]=useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [destination, setDestination] = useState('');
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, width: 1, height: 1 });
  const [editing, setEditing] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState('#ef4444');
  const [error, setError] = useState<UiErrorCause>('');
  const [recoveryNeeded,setRecoveryNeeded]=useState(false);

  const [uploaded, setUploaded] = useState('');
  const [attachable,setAttachable]=useState(false);
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState<UiErrorCause | {key:'attachmentRestored'|'attachmentUploaded'|'attachmentCopied'|'attachmentStaged'|'attachmentHostCopied'|'attachmentHostCopyCancelled'|'attachmentPasted'}>('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLImageElement | null>(null);
  const generation = useRef(0);
  const clipboardRead = useRef<AbortController | null>(null);
  const stroke = useRef<Stroke | null>(null);
  const uploadJob=useHostUpload(api,sessionId,error=>{setRecoveryNeeded(!!error && typeof error==='object' && 'kind' in error && error.kind==='ssh_control_closed');setError(captureUiError(error));});
  const hostClipboard=useHostClipboard(api,sessionId,error=>setError(captureUiError(error)),kind=>setNotice({key:kind==='copied'?'attachmentHostCopied':'attachmentHostCopyCancelled'}));
  const busy=uploadJob.busy||hostClipboard.busy||pasteBusy;
  const renderedPasteTarget=completed.current;
  function clearCompletion(){completed.current=null;hostClipboard.clear();setAttachable(false);}
  const currentPasteOwner=()=>owner.mounted.current&&owner.access.current()&&latestSession.current===originalSession;
  async function pastePath(target:{path:string}|null){
    if(!onPastePath||!target||completed.current!==target||pasting.current||uploadJob.active()||hostClipboard.active()
      ||!currentPasteOwner()||document.visibilityState!=='visible')return;
    const job={target,claimed:false};pasting.current=job;setPasteBusy(true);setError('');setNotice('');
    const current=()=>currentPasteOwner()&&completed.current===target&&pasting.current===job;
    try{
      await onPastePath({sessionId:originalSession,path:target.path,claim:()=>{
        if(!current()||job.claimed||document.visibilityState!=='visible')return false;
        job.claimed=true;return true;
      }});
      if(current()&&document.visibilityState==='visible'){
        if(!job.claimed)throw new LocalUiError('attachmentPasteUnavailable');
        setNotice({key:'attachmentPasted'});
      }
    }catch(error){if(current()&&document.visibilityState==='visible')setError(captureUiError(error));}
    finally{if(pasting.current===job){pasting.current=null;if(currentPasteOwner())setPasteBusy(false);}}
  }
  useEffect(() => () => { generation.current++; clipboardRead.current?.abort(); source.current = null; }, [sessionId]);

  async function choose(file: File) {
    if (uploadJob.active()||hostClipboard.active()||pasting.current) return;
    clipboardRead.current?.abort();
    clearCompletion();
    const current = ++generation.current;
    setError(''); setNotice(''); setSelected(null); setUploaded(''); setStrokes([]); setEditing(false); source.current = null;
    try {
      checkAttachment(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (current !== generation.current) return;
      let size: ImageSize | null = null;
      try { size = imageSize(bytes); }
      catch (e) { setNotice(e instanceof Error ? captureUiError(e) : new LocalUiError('attachmentEditingUnavailable')); }
      if (size && file.type && file.type !== size.mime && file.type !== 'application/octet-stream') throw new LocalUiError('attachmentTypeMismatch');
      setSelected({ file, bytes, size }); setDestination(`./${file.name}`);
      if (size) setCrop({ x: 0, y: 0, width: size.width, height: size.height });
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? captureUiError(e) : String(e)); }
  }

  useEffect(() => {
    source.current = null;
    if (!selected?.size || !editing) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(selected.bytes)], { type: selected.size.mime }));
    const image = new Image();
    let active = true;
    image.onload = () => {
      if (!active) return;
      if (image.naturalWidth !== selected.size!.width || image.naturalHeight !== selected.size!.height) { setError(new LocalUiError('attachmentDecodedMismatch')); return; }
      source.current = image;
      redraw();
    };
    image.onerror = () => { if (active) setError(new LocalUiError('attachmentDecodeFailed')); };
    image.src = url;
    return () => { active = false; image.onload = null; image.onerror = null; image.src = ''; URL.revokeObjectURL(url); source.current = null; };
  }, [selected, editing]);

  function draw(context: CanvasRenderingContext2D, values: Stroke[]) {
    for (const line of values) {
      if (!line.points.length) continue;
      context.beginPath(); context.strokeStyle = line.color; context.fillStyle = line.color; context.lineWidth = line.width; context.lineCap = 'round'; context.lineJoin = 'round';
      context.moveTo(line.points[0].x, line.points[0].y);
      for (const point of line.points.slice(1)) context.lineTo(point.x, point.y);
      if (line.points.length === 1) { context.arc(line.points[0].x, line.points[0].y, line.width / 2, 0, Math.PI * 2); context.fill(); }
      else context.stroke();
    }
  }
  function redraw(extra?: Stroke) {
    const context = canvas.current?.getContext('2d');
    if (!context || !canvas.current || !source.current) return;
    context.clearRect(0, 0, canvas.current.width, canvas.current.height);
    context.drawImage(source.current, 0, 0);
    draw(context, extra ? [...strokes, extra] : strokes);
    if (selected?.size) {
      try {
        const rect = validateCrop(crop, selected.size);
        context.strokeStyle = '#22d3ee'; context.lineWidth = Math.max(2, selected.size.width / 300);
        context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      } catch { /* Keep invalid crop values editable; upload validates them. */ }
    }
  }
  useEffect(() => { redraw(); }, [strokes, selected, editing, crop]);

  async function pasteImage() {
    if (!currentPasteOwner() || clipboardRead.current) return;
    const read = new AbortController(); clipboardRead.current = read;
    const started = generation.current;
    const current = () => currentPasteOwner() && !read.signal.aborted && generation.current === started;
    setError('');
    try {
      const file = await readClipboardImage(read.signal);
      if (current()) await choose(file);
    } catch (e) { if (current()) setError(e instanceof Error ? captureUiError(e) : String(e)); }
    finally { if (clipboardRead.current === read) clipboardRead.current = null; }
  }
  async function upload() {
    if (!selected || busy) return;
    clearCompletion();
    setError(''); setNotice('');
    await uploadJob.start(async()=>{
      checkDestination(destination);
      let bytes = selected.bytes;
      if (editing && selected.size) {
        const rect = validateCrop(crop, selected.size);
        if (!source.current) throw new LocalUiError('attachmentWaitPreview');
        const output = document.createElement('canvas'); output.width = rect.width; output.height = rect.height;
        try {
          const context = output.getContext('2d');
          if (!context) throw new LocalUiError('attachmentEditingDevice');
          context.translate(-rect.x, -rect.y); context.drawImage(source.current, 0, 0); draw(context, strokes);
          const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new LocalUiError('attachmentEncodeFailed')), 'image/png'));
          if (blob.size > ATTACHMENT_LIMIT) throw new LocalUiError('attachmentEditedLimit');
          bytes = new Uint8Array(await blob.arrayBuffer());
        } finally {output.width = 0; output.height = 0;}
      }
      return {path:destination,bytes};
    },(path,uploadId)=>{
      completed.current=Object.freeze({path});
      setAttachable(true);hostClipboard.completed(uploadId);
      setRecoveryNeeded(false);setUploaded(path); setPrompt(t('attachmentPromptTemplate',{path:shellPath(path)})); setNotice({key:'attachmentUploaded'});
    });
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice({key:'attachmentCopied'}); }
    catch { setError(new LocalUiError('attachmentClipboardDenied')); }
  }
  return <section className="tool-panel attachment-panel" aria-label={t('attachmentTitle')}>
    <h3>{t('attachmentHeading')}</h3><p>{t('attachmentScope')}</p>
    <div className="button-row">
      <label>{t('attachmentChoose')}<input aria-label={t('attachmentChooseLabel')} type="file" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void choose(file); }} /></label>
      <label>{t('attachmentPhoto')}<input aria-label={t('attachmentPhotoLabel')} type="file" accept="image/*" capture="environment" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void choose(file); }} /></label>
      <button type="button" disabled={busy || clipboardPlatform.phase === "loading"} onClick={() => { if (clipboardPlatform.phase === "ready") void pasteImage(); else if (currentPasteOwner()) void clipboardPlatform.retry(); }}>{t(clipboardPlatform.phase === "ready" ? "attachmentPaste" : clipboardPlatform.phase === "loading" ? "clipboardChecking" : "clipboardRetry")}</button>
    </div>
    {uploadJob.cancelled && <p role="status">{t('uploadCancelledWarning')}</p>}
    {recoveryNeeded && onRestoreFileTransfer && <button type="button" disabled={busy} onClick={guard(()=>onRestoreFileTransfer(()=>{if(currentPasteOwner()){setError('');setRecoveryNeeded(false);setNotice({key:'attachmentRestored'});}}))}>{t('attachmentRestore')}</button>}
    {error && <p className="inline-error" role="alert">{uiErrorText(error)}</p>}{notice && <p role="status">{typeof notice==='object'&&!(notice instanceof LocalUiError)?t(notice.key):uiErrorText(notice)}</p>}
    {selected && <div className="form-stack"><p>{t('attachmentMetadata',{name:selected.file.name,bytes:formatNumber(selected.file.size)})}</p>
      <label>{t('attachmentDestination')}<input value={destination} disabled={busy} onChange={event => {clearCompletion();setDestination(event.target.value);}} /></label>
      {selected.size && <label><input type="checkbox" checked={editing} disabled={busy} onChange={event => { clearCompletion();setEditing(event.target.checked); setDestination(event.target.checked ? `./${selected.file.name.replace(/\.[^/.]+$/, '')}-edited.png` : `./${selected.file.name}`); }} />{t('attachmentEditing')}</label>}
      {editing && selected.size && <div className="attachment-editor"><p>{t('attachmentDrawingHint')}</p>
        <div className="button-row">{(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>{t(({x:'attachmentCropX',y:'attachmentCropY',width:'attachmentCropWidth',height:'attachmentCropHeight'} as const)[field])}<input type="number" min={field === 'width' || field === 'height' ? 1 : 0} max={field === 'x' || field === 'width' ? selected.size!.width : selected.size!.height} disabled={busy} value={crop[field]} onChange={event => {clearCompletion();setCrop({ ...crop, [field]: Number(event.target.value) });}} /></label>)}<label>{t('attachmentColor')}<input type="color" disabled={busy} value={color} onChange={event => {clearCompletion();setColor(event.target.value);}} /></label><button type="button" disabled={busy || !strokes.length} onClick={() => {clearCompletion();setStrokes(values => values.slice(0, -1));}}>{t('attachmentUndo')}</button></div>
        <canvas ref={canvas} width={selected.size.width} height={selected.size.height} aria-label={t('attachmentCanvas')} style={{ width: '100%', height: 'auto', maxWidth: '800px', touchAction: 'none', display: 'block' }}
          onPointerDown={event => { if (busy || event.isPrimary === false || !source.current || strokes.length >= 100) return; clearCompletion();const point = imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), selected.size!); stroke.current = { points: [point], color, width: Math.max(2, selected.size!.width / 150) }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!stroke.current || !selected.size || stroke.current.points.length >= 1000) return; stroke.current.points.push(imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), selected.size)); redraw(stroke.current); }}
          onPointerUp={() => { if (stroke.current) { const completed = stroke.current; stroke.current = null; setStrokes(values => [...values, completed]); } }} onPointerCancel={() => { stroke.current = null; redraw(); }} />
      </div>}
      <div className="button-row"><button type="button" className="primary-button" disabled={busy || !destination.trim()} onClick={() => void upload()}>{uploadJob.busy ? t('attachmentUploading') : t('attachmentUpload')}</button><button type="button" disabled={uploadJob.cancelling||pasteBusy} onClick={() => { generation.current++; clearCompletion();if(busy){uploadJob.cancel();setUploaded('');setPrompt('');}else{setSelected(null);setUploaded('');setNotice('');} }}>{uploadJob.cancelling?t('uploadCancelling'):t('attachmentCancel')}</button></div>
    </div>}
    {uploaded && <div className="form-stack"><label>{t('attachmentHostPath')}<input readOnly value={shellPath(uploaded)} /></label><button type="button" onClick={() => void copy(shellPath(uploaded))}>{t('attachmentCopyPath')}</button>{onPastePath&&!onAttach&&attachable&&<><button type="button" disabled={busy} onClick={()=>void pastePath(renderedPasteTarget)}>{t(pasteBusy?'attachmentPasting':'attachmentPastePath')}</button><small>{t('attachmentPasteHint')}</small></>}<div className="button-row"><button type="button" disabled={!hostClipboard.ready||busy} onClick={()=>{setError('');setNotice('');void hostClipboard.copy();}}>{hostClipboard.busy?t('attachmentHostCopying'):t('attachmentHostCopy')}</button>{hostClipboard.busy&&<button type="button" onClick={()=>hostClipboard.clear()}>{t('attachmentHostCancel')}</button>}</div><label>{t('attachmentPrompt')}<textarea rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} /></label><div className="button-row">{onAttach && attachable && <button type="button" disabled={busy} onClick={guard(()=>{if(!uploadJob.active()&&!hostClipboard.active())onAttach(uploaded);})}>{t('attachmentAddToChat')}</button>}<button type="button" onClick={() => void copy(prompt)}>{t('attachmentCopyPrompt')}</button><button type="button" disabled={!prompt.trim()} onClick={() => { window.dispatchEvent(new CustomEvent('lazysh-prompt-draft', { detail: { sessionId, text: prompt } })); setNotice({key:'attachmentStaged'}); }}>{t('attachmentStage')}</button></div><p>{t('attachmentReview')}</p></div>}
  </section>;
}
