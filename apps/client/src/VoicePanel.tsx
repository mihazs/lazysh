import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MAX_VOICE_SECONDS, mono16k, validModelFile } from './voice';
import { errorMessage } from './SessionTools';

type Model = { id: string; bytes: number };
export default function VoicePanel({ sessionId }: { sessionId?: string }) {
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState('auto');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const importId = useRef('');
  async function refresh() {
    const value = await invoke<Model[]>('voice_models');
    if (!Array.isArray(value) || value.length > 3 || value.some(item => !item || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.bin$/.test(item.id) || !Number.isSafeInteger(item.bytes) || item.bytes < 1024 || item.bytes > 160 * 1024 * 1024)) throw new Error('Invalid voice model list.');
    setModels(value); setModel(previous => value.some(item => item.id === previous) ? previous : value[0]?.id || '');
  }
  function releaseMicrophone() { clearTimeout(timer.current); stream.current?.getTracks().forEach(track => track.stop()); stream.current = undefined; }
  useEffect(() => {
    void refresh().catch(e => setError(errorMessage(e)));
    return () => {
      generation.current++; if (recorder.current?.state === 'recording') recorder.current.stop(); releaseMicrophone();
      void invoke('voice_cancel').catch(() => {});
      if (importId.current) void invoke('voice_import_finish', { id: importId.current, cancel: true }).catch(() => {});
    };
  }, []);
  async function importModel(file?: File) {
    if (!file) return;
    const current = ++generation.current;
    setError(''); setBusy(true);
    let id = '';
    try {
      validModelFile(file);
      id = await invoke<string>('voice_import_begin', { name: file.name, bytes: file.size }); importId.current = id;
      for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
        if (current !== generation.current) throw new Error('Import cancelled.');
        const bytes = Array.from(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()));
        await invoke('voice_import_chunk', { id, offset, bytes });
        if (current === generation.current) setProgress(`Importing ${Math.round(Math.min(file.size, offset + bytes.length) / file.size * 100)}%`);
      }
      if (current !== generation.current) throw new Error('Import cancelled.');
      await invoke('voice_import_finish', { id, cancel: false }); id = ''; importId.current = '';
      if (current === generation.current) await refresh();
    } catch (e) { if (id) await invoke('voice_import_finish', { id, cancel: true }).catch(() => {}); if (current === generation.current) setError(errorMessage(e)); }
    finally { importId.current = ''; if (current === generation.current) { setBusy(false); setProgress(''); } }
  }
  async function transcribe(blob: Blob, current: number) {
    if (current !== generation.current) return;
    releaseMicrophone(); setRecording(false);
    setBusy(true); setProgress('Transcribing on this device…');
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      const audio = await context.decodeAudioData(await blob.arrayBuffer());
      const samples = mono16k(Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index)), audio.sampleRate);
      if (current !== generation.current) return;
      const text = await invoke<string>('voice_transcribe', { id: model, samples, language });
      if (typeof text !== 'string' || text.length > 65536) throw new Error('Invalid transcription result.');
      if (current === generation.current) { setDraft(text); if (text) setHistory(previous => [text, ...previous].slice(0,20)); }
    } catch (e) { if (current === generation.current) setError(errorMessage(e)); }
    finally { await context?.close().catch(() => {}); if (current === generation.current) { setBusy(false); setProgress(''); } }
  }
  async function start() {
    const current = ++generation.current; setError(''); setBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Microphone recording is unavailable in this WebView. Check device microphone permissions.');
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      if (current !== generation.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      const capture = new MediaRecorder(media); recorder.current = capture;
      const parts: Blob[] = []; let bytes = 0;
      capture.ondataavailable = event => { bytes += event.data.size; if (bytes > 8 * 1024 * 1024) { generation.current++; capture.stop(); releaseMicrophone(); setRecording(false); setError('Recording exceeded the audio size limit.'); } else parts.push(event.data); };
      capture.onerror = () => { generation.current++; releaseMicrophone(); setRecording(false); setError('Microphone recording failed.'); };
      capture.onstop = () => { void transcribe(new Blob(parts, {type: capture.mimeType}), current); };
      capture.start(1000); setRecording(true);
      timer.current = setTimeout(() => { if (capture.state === 'recording') capture.stop(); }, MAX_VOICE_SECONDS * 1000);
    } catch (e) { releaseMicrophone(); if (current === generation.current) setError(errorMessage(e)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function cancel() { generation.current++; if (recorder.current?.state === 'recording') recorder.current.stop(); releaseMicrophone(); setRecording(false); setBusy(false); setProgress(''); void invoke('voice_cancel').catch(e => setError(errorMessage(e))); }
  return <section className="tool-panel voice-panel" aria-label="Local dictation">
    <h3>Local dictation</h3><p>Whisper runs on this device. Import a trusted tiny/base GGML model, record up to 30 seconds, then edit the result.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <label>Import model<input type="file" accept=".bin" disabled={busy || recording} onChange={event => { void importModel(event.target.files?.[0]); event.target.value = ''; }} /></label>
    <label>Model<select value={model} disabled={busy || recording} onChange={event => setModel(event.target.value)}><option value="">Choose a model</option>{models.map(item => <option key={item.id} value={item.id}>{item.id} ({Math.round(item.bytes/1024/1024)} MiB)</option>)}</select></label>
    <button disabled={!model || busy || recording} onClick={() => { void invoke('voice_remove_model', {id:model}).then(refresh).catch(e => setError(errorMessage(e))); }}>Remove selected model</button>
    <label>Language<select disabled={busy || recording} value={language} onChange={event => setLanguage(event.target.value)}>{[['auto','Detect language'],['en','English'],['pt','Português'],['es','Español'],['fr','Français'],['de','Deutsch'],['ja','日本語'],['zh','中文'],['ko','한국어'],['hi','हिन्दी'],['ar','العربية']].map(([code,label]) => <option key={code} value={code}>{label}</option>)}</select></label>
    <div className="tool-bar"><button disabled={!model || busy} onClick={() => recording ? recorder.current?.stop() : void start()}>{recording ? 'Stop and transcribe' : 'Record speech'}</button>{(busy || recording) && <button onClick={cancel}>Cancel</button>}</div>
    {progress && <p role="status">{progress}</p>}
    <label>Dictation draft<textarea rows={7} value={draft} maxLength={65536} onChange={event => setDraft(event.target.value)} /></label>
    <div className="tool-bar"><button disabled={!draft} onClick={() => { void navigator.clipboard.writeText(draft).catch(e => setError(errorMessage(e))); }}>Copy draft</button>{sessionId && <button disabled={!draft} onClick={() => window.dispatchEvent(new CustomEvent('lazysh-prompt-draft', {detail:{sessionId,text:draft}}))}>Stage in terminal composer</button>}</div>
    {history.length > 0 && <details><summary>Session dictation history ({history.length})</summary><button onClick={() => setHistory([])}>Clear history</button>{history.map((text,index) => <button key={index} onClick={() => setDraft(text)}>{text.slice(0,100)}</button>)}</details>}
  </section>;
}
