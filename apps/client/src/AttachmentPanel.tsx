import { useProtectedApi } from './access';
import { useEffect, useRef, useState } from 'react';
import { api as nativeApi } from './bridge';
import { ATTACHMENT_LIMIT, checkAttachment, checkDestination, imagePoint, imageSize, shellPath, validateCrop, type Crop, type ImageSize, type Point } from './attachment';

type Selected = { file: File; bytes: Uint8Array; size: ImageSize | null };
type Stroke = { points: Point[]; color: string; width: number };

export default function AttachmentPanel({ sessionId }: { sessionId: string }) {
  const api = useProtectedApi(nativeApi);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [destination, setDestination] = useState('');
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, width: 1, height: 1 });
  const [editing, setEditing] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState('#ef4444');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState('');
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLImageElement | null>(null);
  const generation = useRef(0);
  const stroke = useRef<Stroke | null>(null);
  const uploading = useRef(false);
  useEffect(() => () => { generation.current++; source.current = null; }, [sessionId]);

  async function choose(file: File) {
    if (uploading.current) return;
    const current = ++generation.current;
    setError(''); setNotice(''); setSelected(null); setUploaded(''); setStrokes([]); setEditing(false); source.current = null;
    try {
      checkAttachment(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (current !== generation.current) return;
      let size: ImageSize | null = null;
      try { size = imageSize(bytes); }
      catch (e) { setNotice(e instanceof Error ? e.message : 'Image editing is unavailable; the original can be uploaded.'); }
      if (size && file.type && file.type !== size.mime && file.type !== 'application/octet-stream') throw new Error('The image content does not match its declared type.');
      setSelected({ file, bytes, size }); setDestination(`./${file.name}`);
      if (size) setCrop({ x: 0, y: 0, width: size.width, height: size.height });
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : String(e)); }
  }

  useEffect(() => {
    source.current = null;
    if (!selected?.size || !editing) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(selected.bytes)], { type: selected.size.mime }));
    const image = new Image();
    let active = true;
    image.onload = () => {
      if (!active) return;
      if (image.naturalWidth !== selected.size!.width || image.naturalHeight !== selected.size!.height) { setError('Decoded dimensions do not match the image header.'); return; }
      source.current = image;
      redraw();
    };
    image.onerror = () => { if (active) setError('This image could not be decoded. Disable image editing to upload the original.'); };
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
    setError('');
    try {
      if (!navigator.clipboard?.read) throw new Error('Clipboard images are unavailable on this device. Choose a file or photo instead.');
      const items = await navigator.clipboard.read();
      const item = items.find(value => value.types.includes('image/png') || value.types.includes('image/jpeg'));
      if (!item) throw new Error('No PNG or JPEG image is available on the clipboard.');
      const type = item.types.includes('image/png') ? 'image/png' : 'image/jpeg';
      const blob = await item.getType(type);
      await choose(new File([blob], `clipboard-${Date.now()}.${type === 'image/png' ? 'png' : 'jpg'}`, { type }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function upload() {
    if (!selected || uploading.current) return;
    uploading.current = true; setBusy(true); setError(''); setNotice('');
    const current = generation.current;
    try {
      checkDestination(destination);
      let bytes = selected.bytes;
      if (editing && selected.size) {
        const rect = validateCrop(crop, selected.size);
        if (!source.current) throw new Error('Wait for the image preview to load, or upload the original.');
        const output = document.createElement('canvas'); output.width = rect.width; output.height = rect.height;
        const context = output.getContext('2d');
        if (!context) throw new Error('Image editing is unavailable on this device.');
        context.translate(-rect.x, -rect.y); context.drawImage(source.current, 0, 0); draw(context, strokes);
        const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode the edited image.')), 'image/png'));
        output.width = 0; output.height = 0;
        if (blob.size > ATTACHMENT_LIMIT) throw new Error('Edited PNG exceeds 10 MiB. Reduce the crop or upload the original.');
        bytes = new Uint8Array(await blob.arrayBuffer());
      }
      if (current !== generation.current) return;
      await api.uploadFile(sessionId, destination, Array.from(bytes));
      if (current !== generation.current) return;
      setUploaded(destination); setPrompt(`Please review the attached file ${shellPath(destination)}.`); setNotice('Uploaded to this host. Copy its path or edit the prompt below.');
    } catch (e) { if (current === generation.current) setError(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)); }
    finally { uploading.current = false; if (current === generation.current) setBusy(false); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('Copied.'); }
    catch { setError('Clipboard access was denied. Select and copy the text manually.'); }
  }
  return <section className="tool-panel attachment-panel" aria-label="Host attachments">
    <h3>Attach to this host</h3><p>Files travel over this SSH connection. New files only; existing host files are never replaced. Maximum 10 MiB.</p>
    <div className="button-row">
      <label>Choose file<input aria-label="Choose attachment" type="file" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void choose(file); }} /></label>
      <label>Photo or camera<input aria-label="Take or choose photo" type="file" accept="image/*" capture="environment" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void choose(file); }} /></label>
      <button type="button" disabled={busy} onClick={() => void pasteImage()}>Paste clipboard image</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {selected && <div className="form-stack"><p>{selected.file.name} · {selected.file.size.toLocaleString()} bytes</p>
      <label>Destination path<input value={destination} disabled={busy} onChange={event => setDestination(event.target.value)} /></label>
      {selected.size && <label><input type="checkbox" checked={editing} disabled={busy} onChange={event => { setEditing(event.target.checked); setDestination(event.target.checked ? `./${selected.file.name.replace(/\.[^/.]+$/, '')}-edited.png` : `./${selected.file.name}`); }} />Crop or annotate PNG/JPEG</label>}
      {editing && selected.size && <div className="attachment-editor"><p>Draw on the image. The cyan border shows the crop and is excluded from the upload. Coordinates are in original pixels; edits upload as PNG.</p>
        <div className="button-row">{(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>Crop {field}<input type="number" min={field === 'width' || field === 'height' ? 1 : 0} max={field === 'x' || field === 'width' ? selected.size!.width : selected.size!.height} disabled={busy} value={crop[field]} onChange={event => setCrop({ ...crop, [field]: Number(event.target.value) })} /></label>)}<label>Annotation color<input type="color" disabled={busy} value={color} onChange={event => setColor(event.target.value)} /></label><button type="button" disabled={busy || !strokes.length} onClick={() => setStrokes(values => values.slice(0, -1))}>Undo annotation</button></div>
        <canvas ref={canvas} width={selected.size.width} height={selected.size.height} aria-label="Draw image annotations" style={{ width: '100%', height: 'auto', maxWidth: '800px', touchAction: 'none', display: 'block' }}
          onPointerDown={event => { if (busy || event.isPrimary === false || !source.current || strokes.length >= 100) return; const point = imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), selected.size!); stroke.current = { points: [point], color, width: Math.max(2, selected.size!.width / 150) }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!stroke.current || !selected.size || stroke.current.points.length >= 1000) return; stroke.current.points.push(imagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), selected.size)); redraw(stroke.current); }}
          onPointerUp={() => { if (stroke.current) { const completed = stroke.current; stroke.current = null; setStrokes(values => [...values, completed]); } }} onPointerCancel={() => { stroke.current = null; redraw(); }} />
      </div>}
      <div className="button-row"><button type="button" className="primary-button" disabled={busy || !destination.trim()} onClick={() => void upload()}>{busy ? 'Uploading…' : 'Upload attachment'}</button><button type="button" disabled={busy} onClick={() => { generation.current++; setSelected(null); setUploaded(''); setNotice(''); }}>Cancel attachment</button></div>
    </div>}
    {uploaded && <div className="form-stack"><label>Host path<input readOnly value={shellPath(uploaded)} /></label><button type="button" onClick={() => void copy(shellPath(uploaded))}>Copy host path</button><label>Editable prompt<textarea rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} /></label><div className="button-row"><button type="button" onClick={() => void copy(prompt)}>Copy prompt</button><button type="button" disabled={!prompt.trim()} onClick={() => { window.dispatchEvent(new CustomEvent('lazysh-prompt-draft', { detail: { sessionId, text: prompt } })); setNotice('Staged in the terminal composer. Review and send it there.'); }}>Stage in terminal</button></div><p>Review the draft in the intended agent terminal when ready.</p></div>}
  </section>;
}
