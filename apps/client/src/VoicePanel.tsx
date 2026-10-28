import {t, useUi, formatNumber} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import { captureAccess, useProtectedCallback, useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { MAX_VOICE_SECONDS, mono16k, validModelFile } from "./voice";
import { useDictationHistory } from './voiceHistory';
import VoiceHistoryPanel from './VoiceHistoryPanel';
import type { DirectDictation } from './voiceDelivery';
import CloudVoiceSettingsPanel from './CloudVoiceSettingsPanel';
import { CLOUD_LANGUAGES, validateCloudQuota, type CloudSnapshot, type CloudQuota } from './cloudVoice';

type Model = { id: string; bytes: number };
type CatalogModel = {id:string;file:string;label:string;bytes:number;sha256:string;revision:string};
type DownloadProgress = {requestId:string;received:number;total:number;stage:'downloading'|'verifying'|'installed'};
type ParakeetStatus = {
  available: boolean; reason: string; installed: boolean; ready: boolean; busy: boolean;
  stage: 'idle'|'downloading'|'preparing'|'loading'|'transcribing'|'removing'|'finishing';
  requestId: string|null; received: number; total: number;
};
const PARAKEET_BYTES = 487170055;
function parakeetStatus(value: unknown): ParakeetStatus {
  const status = value as ParakeetStatus;
  if (!status || typeof status.available !== 'boolean' || typeof status.reason !== 'string' || status.reason.length > 1024
    || ['installed','ready','busy'].some(key => typeof status[key as 'installed'|'ready'|'busy'] !== 'boolean')
    || !['idle','downloading','preparing','loading','transcribing','removing','finishing'].includes(status.stage)
    || (status.requestId !== null && (typeof status.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(status.requestId)))
    || !Number.isSafeInteger(status.received) || status.received < 0 || status.total !== PARAKEET_BYTES || status.received > status.total)
    throw new LocalUiError('voiceInvalidParakeet');
  return status;
}
type AppleCapability = {
  available: boolean;
  reason: string;
  supportedLanguages: string[];
  installedLanguages: string[];
  reservedLanguages: string[];
};
type VoiceProgress = {key: 'voiceConnectingPublisher' | 'voiceVerifyingModel' | 'voiceModelInstalled' | 'voiceTranscribingCloud' | 'voiceTranscribingLocal' | 'voiceCancellingModel' | 'voiceAlreadyInstalled' | 'voiceReleasingApple' | 'voiceDownloadingApple'} | {key: 'voiceDownloadProgress' | 'voiceImportProgress'; percent:number};
function progressText(value: VoiceProgress): string {
  return 'percent' in value ? t(value.key,{percent:formatNumber(value.percent)}) : t(value.key);
}
export default function VoicePanel({ sessionId, onDirectDictation }: {
  sessionId?: string;
  onDirectDictation?: (request: DirectDictation) => Promise<void>;
}) {
  useUi();
  const appleReceived = useRef(false);
  const parakeetReceived = useRef(false);
  const invoke = useProtectedInvoke();
  const guardCallback = useProtectedCallback();
  const access = useRef(captureAccess()).current;
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogId, setCatalogId] = useState('tiny.en');
  const [downloading, setDownloading] = useState(false);
  const [cancellingDownload, setCancellingDownload] = useState(false);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const [language, setLanguage] = useState("auto");
  const [engine, setEngine] = useState<"whisper" | "apple" | "cloud" | "parakeet">("whisper");
  const [parakeet, setParakeet] = useState<ParakeetStatus>({available:false, reason:'', installed:false, ready:false, busy:false, stage:'idle', requestId:null, received:0, total:PARAKEET_BYTES});
  const [cloudSnapshot, setCloudSnapshot] = useState<CloudSnapshot>();
  const [cloudLanguage, setCloudLanguage] = useState('auto');
  const [cloudConfigBusy, setCloudConfigBusy] = useState(false);
  const [apple, setApple] = useState<AppleCapability>({
    available: false,
    reason: '',
    supportedLanguages: [],
    installedLanguages: [],
    reservedLanguages: [],
  });
  const [appleLanguage, setAppleLanguage] = useState("en-US");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraftValue] = useState("");
  // Include edits already queued by the composer, not an inference-start snapshot.
  const latestDraft = useRef("");
  function setDraft(value:string) {latestDraft.current=value;setDraftValue(value);}
  const [direct, setDirect] = useState(false);
  const [autoSend, setAutoSend] = useState(false);
  const [deliveryStatus, setDeliveryStatus] = useState<'' | 'voiceQueuedEnter' | 'voiceQueuedNoEnter'>('');
  const history = useDictationHistory();
  const [errors, updateErrors] = useState<UiErrorCause[]>([]);
  function setError(error:unknown) {const cause=captureUiError(error);updateErrors(cause===''?[]:[cause]);}
  const [progress, setProgress] = useState<VoiceProgress | null>(null);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const importId = useRef("");
  const appleRequest = useRef("");
  const downloadRequest = useRef("");
  const cloudRequest = useRef("");
  const parakeetRequest = useRef('');
  const parakeetState = useRef(parakeet);
  const parakeetRevision = useRef(0);
  const mounted = useRef(true);
  const working = busy || parakeet.busy;
  const previousSession = useRef(sessionId);
  const canPublish = () => mounted.current && access.current();
  function applyParakeet(value: ParakeetStatus, received=false) {
    if (!canPublish()) return;
    if(received)parakeetReceived.current=true;
    parakeetState.current = value;
    setParakeet(value);
  }
  async function refreshParakeet() {
    if (!canPublish()) return;
    const revision = ++parakeetRevision.current;
    try {
      const value = await invoke<unknown>('voice_parakeet_status');
      if (canPublish() && revision === parakeetRevision.current) applyParakeet(parakeetStatus(value),true);
    } catch (e) { if (canPublish() && revision === parakeetRevision.current) throw e; }
  }
  function beginParakeet(requestId: string, stage: ParakeetStatus['stage']) {
    parakeetRevision.current++;
    parakeetRequest.current = requestId;
    setProgress(null);
    applyParakeet({...parakeetState.current, busy:true, requestId, stage, received:0});
  }
  async function cancelParakeet(requestId: string) {
    if (!canPublish()) return;
    const current = generation.current;
    parakeetRevision.current++;
    setProgress(null);
    applyParakeet({...parakeetState.current, busy:true, requestId, stage:'finishing'});
    try {
      await invoke('voice_parakeet_cancel', {requestId});
      await refreshParakeet();
    } catch (e) { if (canPublish() && current === generation.current) setError(e); }
  }
  useEffect(() => {
    if (!parakeet.busy && !parakeetRequest.current) return;
    let stopped = false;
    let poll: ReturnType<typeof setTimeout>;
    const update = async () => {
      try { await refreshParakeet(); }
      catch (e) { if (!stopped && canPublish()) setError(e); }
      if (!stopped && canPublish() && (parakeetState.current.busy || parakeetRequest.current)) poll = setTimeout(() => void update(), 1000);
    };
    poll = setTimeout(() => void update(), 1000);
    return () => { stopped = true; clearTimeout(poll); };
  }, [parakeet.busy, busy]);
  async function cancelCloud(requestId: string, current = generation.current) {
    try {
      const result = await invoke<{cancelled: boolean; cleanup: string}>('voice_cloud_cancel', { requestId });
      if (current === generation.current && result?.cleanup === 'unconfirmed')
        updateErrors(previous => [...previous,new LocalUiError('voiceCloudCleanup')]);
    } catch (e) { if (current === generation.current) setError(e); }
  }
  useEffect(() => {
    if (previousSession.current !== sessionId) { previousSession.current = sessionId; cancel(); setDirect(false); setAutoSend(false); }
  }, [sessionId]);
  useEffect(() => {
    if (cloudSnapshot) setCloudLanguage(previous => cloudSnapshot.capabilities.languages.includes(previous) ? previous
      : cloudSnapshot.capabilities.languages.includes('auto') ? 'auto' : cloudSnapshot.capabilities.languages[0]);
  }, [cloudSnapshot]);
  async function refreshCatalog() {
    const entries = await invoke<CatalogModel[]>('voice_model_catalog');
    if(!Array.isArray(entries) || entries.length>4 || entries.some(entry=>!entry || !['tiny','tiny.en','base','base.en'].includes(entry.id)
      || entry.file!==`ggml-${entry.id}.bin` || typeof entry.label!=='string' || entry.label.length>80
      || !Number.isSafeInteger(entry.bytes) || entry.bytes<1024 || entry.bytes>160*1024*1024
      || !/^[0-9a-f]{64}$/.test(entry.sha256) || !/^[0-9a-f]{40}$/.test(entry.revision))
      || new Set(entries.map(entry=>entry.id)).size!==entries.length)throw new LocalUiError('voiceInvalidCatalog');
    setCatalog(entries);
    setCatalogId(previous=>entries.some(entry=>entry.id===previous)?previous:entries[0]?.id ?? '');
  }
  async function refreshApple() {
    const value = await invoke<AppleCapability>("apple_speech_capability");
    if (
      !value ||
      typeof value.available !== "boolean" ||
      typeof value.reason !== "string" ||
      value.reason.length > 1024 ||
      !Array.isArray(value.supportedLanguages) ||
      !Array.isArray(value.installedLanguages) ||
      !Array.isArray(value.reservedLanguages) ||
      value.supportedLanguages.length > 300 ||
      value.installedLanguages.length > 300 ||
      value.reservedLanguages.length > 300 ||
      [
        ...value.supportedLanguages,
        ...value.installedLanguages,
        ...value.reservedLanguages,
      ].some(
        (code) =>
          typeof code !== "string" ||
          code.length > 64 ||
          !/^[a-zA-Z0-9-]+$/.test(code),
      )
    )
      throw new LocalUiError('voiceInvalidApple');
    appleReceived.current=true;
    setApple(value);
    setAppleLanguage((previous) =>
      value.supportedLanguages.includes(previous)
        ? previous
        : value.supportedLanguages[0] || "en-US",
    );
  }
  async function refresh() {
    const value = await invoke<Model[]>("voice_models");
    if (
      !Array.isArray(value) ||
      value.length > 3 ||
      value.some(
        (item) =>
          !item ||
          typeof item.id !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.bin$/.test(item.id) ||
          !Number.isSafeInteger(item.bytes) ||
          item.bytes < 1024 ||
          item.bytes > 160 * 1024 * 1024,
      )
    )
      throw new LocalUiError('voiceInvalidModels');
    setModels(value);
    setModel((previous) =>
      value.some((item) => item.id === previous)
        ? previous
        : value[0]?.id || "",
    );
  }
  function releaseMicrophone() {
    clearTimeout(timer.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = undefined;
  }
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((e) => { if (canPublish()) setError(e); });
    void refreshApple().catch(() => {});
    void refreshCatalog().catch(() => {});
    void refreshParakeet().catch(() => {});
    const hidden = () => {
      if (document.visibilityState !== "visible") cancel();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", cancel);
    return () => {
      mounted.current = false;
      generation.current++;
      const parakeetId = parakeetRequest.current || parakeetState.current.requestId;
      parakeetRequest.current = '';
      if (parakeetId) void invoke('voice_parakeet_cancel', {requestId:parakeetId}).catch(() => {});
      const cloudId = cloudRequest.current; cloudRequest.current = '';
      if (cloudId) void cancelCloud(cloudId);
      if (recorder.current?.state === "recording") recorder.current.stop();
      releaseMicrophone();
      void invoke("voice_cancel").catch(() => {});
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", cancel);
      if (appleRequest.current)
        void invoke("apple_speech_cancel", {
          requestId: appleRequest.current,
        }).catch(() => {});
      if (importId.current)
        void invoke("voice_import_finish", {
          id: importId.current,
          cancel: true,
        }).catch(() => {});
      const requestId=downloadRequest.current;downloadRequest.current='';
      if(requestId)void invoke('voice_download_cancel',{requestId}).catch(()=>{});
    };
  }, []);
  async function parakeetAsset(remove: boolean) {
    if (!canPublish() || working || recording || !parakeet.available) return;
    const current = ++generation.current;
    const requestId = crypto.randomUUID();
    beginParakeet(requestId, remove ? 'removing' : 'downloading');
    setBusy(true); setError(''); setProgress(null);
    try {
      const events = new Channel<ParakeetStatus>();
      events.onmessage = guardCallback(event => {
        if (!canPublish() || current !== generation.current || parakeetRequest.current !== requestId || event?.requestId !== requestId) return;
        try { applyParakeet(parakeetStatus(event),true); } catch (e) { setError(e); }
      });
      await invoke(remove ? 'voice_parakeet_remove' : 'voice_parakeet_install', remove ? {requestId} : {requestId, events});
    } catch (e) { if (canPublish() && current === generation.current) setError(e); }
    finally {
      if (canPublish() && parakeetRequest.current === requestId) {
        parakeetRequest.current = ''; setBusy(false);
        await refreshParakeet().catch(e => { if (canPublish()) setError(e); });
      }
    }
  }
  async function downloadModel() {
    const selected=catalog.find(entry=>entry.id===catalogId);if(!selected || downloadRequest.current || busy || recording)return;
    const requestId=crypto.randomUUID();const current=++generation.current;
    downloadRequest.current=requestId;setBusy(true);setDownloading(true);setCancellingDownload(false);setDownloadBytes(0);setError('');setProgress({key:'voiceConnectingPublisher'});
    try {
      const events=new Channel<DownloadProgress>();
      events.onmessage=guardCallback((event: DownloadProgress)=>{
      if(current!==generation.current || downloadRequest.current!==requestId || event?.requestId!==requestId || event.total!==selected.bytes
        || !Number.isSafeInteger(event.received) || event.received<0 || event.received>event.total
        || !['downloading','verifying','installed'].includes(event.stage))return;
      setDownloadBytes(event.received);
      setProgress(event.stage==='verifying'?{key:'voiceVerifyingModel'}:event.stage==='installed'?{key:'voiceModelInstalled'}:{key:'voiceDownloadProgress',percent:Math.floor(event.received/event.total*100)});
      });
      await invoke('voice_download_model',{id:selected.id,requestId,events});
      if(downloadRequest.current===requestId) {
        await refresh();
        if(current===generation.current)setModel(selected.file);
      }
    }catch(e){if(current===generation.current && downloadRequest.current===requestId)setError(e);}
    finally {
      if(downloadRequest.current===requestId){downloadRequest.current='';setDownloading(false);setCancellingDownload(false);setBusy(false);setProgress(null);}
    }
  }
  async function importModel(file?: File) {
    if (!file) return;
    const current = ++generation.current;
    setError("");
    setBusy(true);
    let id = "";
    try {
      validModelFile(file);
      id = await invoke<string>("voice_import_begin", {
        name: file.name,
        bytes: file.size,
      });
      importId.current = id;
      for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
        if (current !== generation.current)
          throw new LocalUiError('voiceImportCancelled');
        const bytes = Array.from(
          new Uint8Array(
            await file.slice(offset, offset + 1024 * 1024).arrayBuffer(),
          ),
        );
        await invoke("voice_import_chunk", { id, offset, bytes });
        if (current === generation.current)
          setProgress(
            {key:'voiceImportProgress',percent:Math.round((Math.min(file.size, offset + bytes.length) / file.size) * 100)},
          );
      }
      if (current !== generation.current) throw new LocalUiError('voiceImportCancelled');
      await invoke("voice_import_finish", { id, cancel: false });
      id = "";
      importId.current = "";
      if (current === generation.current) await refresh();
    } catch (e) {
      if (id)
        await invoke("voice_import_finish", { id, cancel: true }).catch(
          () => {},
        );
      if (current === generation.current) setError(e);
    } finally {
      importId.current = "";
      if (current === generation.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  async function transcribe(blob: Blob, current: number, historyCapture: ReturnType<typeof history.capture>, delivery: {direct:boolean;autoSend:boolean;claimed:boolean}) {
    if (current !== generation.current) return;
    if (!canPublish()) { releaseMicrophone(); return; }
    releaseMicrophone();
    setRecording(false);
    setBusy(true);
    setProgress({key:engine === 'cloud'?'voiceTranscribingCloud':'voiceTranscribingLocal'});
    let context: AudioContext | undefined;
    let requestId = "";
    try {
      context = new AudioContext();
      const audio = await context.decodeAudioData(await blob.arrayBuffer());
      const samples = mono16k(
        Array.from({ length: audio.numberOfChannels }, (_, index) =>
          audio.getChannelData(index),
        ),
        audio.sampleRate,
      );
      if (current !== generation.current || !canPublish()) return;
      if (engine === "apple") {
        requestId = crypto.randomUUID();
        appleRequest.current = requestId;
      }
      let text: string;
      if (engine === 'cloud') {
        requestId = cloudRequest.current;
        if (!requestId) throw new LocalUiError('voiceCloudCancelled');
        const result = await invoke<{requestId: string; text: string; quota: CloudQuota; checkedAt: number}>('voice_cloud_transcribe', {
          requestId, sessionId, samples, language: cloudLanguage,
        });
        if (!result || result.requestId !== requestId || typeof result.text !== 'string'
          || new TextEncoder().encode(result.text).length > 16384 || !Number.isSafeInteger(result.checkedAt) || result.checkedAt < 0)
          throw new LocalUiError('voiceInvalidCloudResult');
        validateCloudQuota(result.quota);
        text = result.text;
        if (current === generation.current) setCloudSnapshot(previous => previous ? {...previous, quota: result.quota, checkedAt: result.checkedAt} : previous);
      } else if (engine === 'parakeet') {
        requestId = crypto.randomUUID();
        beginParakeet(requestId, 'transcribing');
        const result = await invoke<{requestId:string;text:string}>('voice_parakeet_transcribe', {requestId, samples});
        if (!result || result.requestId !== requestId || typeof result.text !== 'string' || new TextEncoder().encode(result.text).length > 65536)
          throw new LocalUiError('voiceInvalidParakeetResult');
        text = result.text;
      } else text =
        engine === "apple"
          ? await invoke<string>("apple_speech_transcribe", {
              samples,
              language: appleLanguage,
              requestId,
            })
          : await invoke<string>("voice_transcribe", {
              id: model,
              samples,
              language,
            });
      if (typeof text !== "string" || text.length > 65536)
        throw new LocalUiError('voiceInvalidResult');
      if (current === generation.current && canPublish()) {
        void history.add(text,historyCapture);
        if (delivery.direct) setDraft(text);
        else if (text.trim()) {
          const next=latestDraft.current?`${latestDraft.current}\n${text}`:text;
          if(next.length>65536)throw new LocalUiError('voiceComposeTooLong');
          setDraft(next);
        }
        if (delivery.direct && sessionId && onDirectDictation) {
          await onDirectDictation({sessionId,text,autoSend:delivery.autoSend,claim:()=>{
            if (current !== generation.current || !canPublish() || delivery.claimed) return false;
            delivery.claimed=true;
            return true;
          }});
          if (current === generation.current && canPublish()) setDeliveryStatus(delivery.autoSend
            ? 'voiceQueuedEnter' : 'voiceQueuedNoEnter');
        }
      }
    } catch (e) {
      if (current === generation.current && canPublish()) setError(e);
    } finally {
      if (engine === 'cloud') {
        if (current === generation.current) {
          const cloudId = cloudRequest.current; cloudRequest.current = '';
          if (cloudId) void cancelCloud(cloudId);
        }
      }
      if (appleRequest.current === requestId) appleRequest.current = "";
      await context?.close().catch(() => {});
      // Empty IDs are pre-request sentinels, not ownership of another recording.
      // A real cancelled UUID still owns native finishing cleanup across generations.
      if (engine === 'parakeet' && requestId && canPublish() && parakeetRequest.current === requestId) {
        parakeetRequest.current = ''; setBusy(false);
        await refreshParakeet().catch(e => { if (canPublish()) setError(e); });
      }
      if (current === generation.current && canPublish()) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  async function start() {
    if (!canPublish() || working || recording || (engine === 'parakeet' && (!parakeet.available || !parakeet.installed))) return;
    const current = ++generation.current;
    const historyCapture = history.capture();
    const delivery = {direct,autoSend:direct && autoSend,claimed:false};
    setDeliveryStatus("");
    setError("");
    setBusy(true);
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new LocalUiError('voiceMicrophoneUnavailable');
      if (engine === 'cloud') {
        if (!cloudSnapshot || cloudSnapshot.quota.deviceRemainingSamples < 1600 || cloudSnapshot.quota.globalRemainingSamples < 1600)
          throw new LocalUiError('voiceVerifyCloud');
        const requestId = await invoke<string>('voice_cloud_begin', { sessionId });
        if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))
          throw new LocalUiError('voiceInvalidReservation');
        if (current !== generation.current || document.visibilityState !== 'visible') { void cancelCloud(requestId, current); return; }
        cloudRequest.current = requestId;
      }
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
        video: false,
      });
      if (current !== generation.current || !canPublish()) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      const capture = new MediaRecorder(media);
      recorder.current = capture;
      const parts: Blob[] = [];
      let bytes = 0;
      capture.ondataavailable = (event) => {
        if (current !== generation.current || !canPublish()) return;
        bytes += event.data.size;
        if (bytes > 8 * 1024 * 1024) {
          cancel();
          setError(new LocalUiError('voiceAudioSize'));
        } else parts.push(event.data);
      };
      capture.onerror = () => {
        if (current !== generation.current || !canPublish()) return;
        cancel();
        setError(new LocalUiError('voiceRecordingFailed'));
      };
      capture.onstop = () => {
        void transcribe(new Blob(parts, { type: capture.mimeType }), current, historyCapture, delivery);
      };
      capture.start(1000);
      setRecording(true);
      timer.current = setTimeout(() => {
        if (capture.state === "recording") capture.stop();
      }, MAX_VOICE_SECONDS * 1000);
    } catch (e) {
      if (current === generation.current && canPublish()) {
        releaseMicrophone();
        const cloudId = cloudRequest.current; cloudRequest.current = '';
        if (cloudId) void cancelCloud(cloudId);
        setError(e);
      }
    } finally {
      if (current === generation.current && canPublish()) setBusy(false);
    }
  }
  function cancel() {
    if (!canPublish()) return;
    generation.current++;
    history.invalidate();
    const cloudId = cloudRequest.current; cloudRequest.current = '';
    if (cloudId) void cancelCloud(cloudId);
    const parakeetId = parakeetRequest.current || parakeetState.current.requestId;
    if (parakeetId) {
      if (recorder.current?.state === 'recording') recorder.current.stop();
      releaseMicrophone(); setRecording(false);
      void cancelParakeet(parakeetId);
      return;
    }
    if(downloadRequest.current) {
      const requestId=downloadRequest.current;setCancellingDownload(true);setProgress({key:'voiceCancellingModel'});
      void invoke<boolean>('voice_download_cancel',{requestId}).then(cancelled=>{
        if(!cancelled && downloadRequest.current===requestId){setProgress({key:'voiceAlreadyInstalled'});void refresh().catch(()=>{});}
      }).catch(e=>{if(downloadRequest.current===requestId){setCancellingDownload(false);setError(e);}});
      return;
    }
    if (recorder.current?.state === "recording") recorder.current.stop();
    releaseMicrophone();
    setRecording(false);
    setBusy(false);
    setProgress(null);
    void invoke("voice_cancel").catch((e) => setError(e));
    if (appleRequest.current) {
      void invoke("apple_speech_cancel", {
        requestId: appleRequest.current,
      }).catch((e) => setError(e));
      appleRequest.current = "";
    }
  }
  async function appleAsset(remove: boolean) {
    const current = ++generation.current;
    const requestId = crypto.randomUUID();
    appleRequest.current = requestId;
    setBusy(true);
    setError("");
    setProgress(
      remove
        ? {key:'voiceReleasingApple'}
        : {key:'voiceDownloadingApple'},
    );
    try {
      await invoke(remove ? "apple_speech_remove" : "apple_speech_install", {
        language: appleLanguage,
        requestId,
      });
      if (current === generation.current) await refreshApple();
    } catch (e) {
      if (current === generation.current) setError(e);
    } finally {
      if (appleRequest.current === requestId) appleRequest.current = "";
      if (current === generation.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  return (
    <section className="tool-panel voice-panel" aria-label={t('voiceRegion')}>
      <h3>{t('voiceTitle')}</h3>
      <p>
        {t('voiceIntro')}
      </p>
      {errors.length > 0 && (
        <p role="alert" className="inline-error">
          {errors.map(uiErrorText).join(' ')}
        </p>
      )}
      <label>
        {t('voiceSpeechEngine')}
        <select
          value={engine}
          disabled={working || recording || cloudConfigBusy}
          onChange={(event) =>
            setEngine(event.target.value as "whisper" | "apple" | "cloud" | "parakeet")
          }
        >
          <option value="whisper">Whisper</option>
          <option value="parakeet" disabled={!parakeet.available}>{parakeet.available?t('voiceParakeetOption'):t('voiceEngineUnavailable',{engine:t('voiceParakeetOption')})}</option>
          <option value="cloud">Cloud{cloudSnapshot ? ` · ${cloudSnapshot.capabilities.model}` : ''}</option>
          <option value="apple" disabled={!apple.available}>
            {apple.available?'Apple SpeechAnalyzer':t('voiceEngineUnavailable',{engine:'Apple SpeechAnalyzer'})}
          </option>
        </select>
      </label>
      {!parakeet.available && <p>{t('voiceEngineReason',{engine:'Parakeet',reason:parakeetReceived.current?parakeet.reason:t('voiceParakeetInitial')})}</p>}
      {engine === "whisper" ? (
        <>
          <p>
            {t('voiceWhisperHint')}
          </p>
          {catalog.length>0 && <>
            <label>{t('voiceDownloadableModel')}<select value={catalogId} disabled={working || recording} onChange={event=>setCatalogId(event.target.value)}>
              {catalog.map(entry=><option key={entry.id} value={entry.id}>{t('voiceCatalogOption',{label:entry.label,size:formatNumber(entry.bytes/1024/1024,{minimumFractionDigits:1,maximumFractionDigits:1}),installed:models.some(item=>item.id===entry.file)?t('voiceInstalledSuffix'):''})}</option>)}
            </select></label>
            <button disabled={working || recording || !catalog.some(entry=>entry.id===catalogId) || models.length>=3 || models.some(item=>item.id===catalog.find(entry=>entry.id===catalogId)?.file)} onClick={()=>void downloadModel()}>{t('voiceDownloadSelected')}</button>
            {models.length>=3 && <p>{t('voiceMaximumModels')}</p>}
            {downloading && <progress aria-label={t('voiceModelDownload')} value={downloadBytes} max={catalog.find(entry=>entry.id===catalogId)?.bytes ?? 1}/>}
          </>}
          <label>
            {t('voiceImportModel')}
            <input
              type="file"
              accept=".bin"
              disabled={working || recording}
              onChange={(event) => {
                void importModel(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
          <label>
            {t('voiceModel')}
            <select
              value={model}
              disabled={working || recording}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">{t('voiceChooseModel')}</option>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {t('voiceCatalogOption',{label:item.id,size:formatNumber(Math.round(item.bytes/1024/1024)),installed:''})}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!model || working || recording}
            onClick={() => {
              void invoke("voice_remove_model", { id: model })
                .then(refresh)
                .catch((e) => setError(e));
            }}
          >
            {t('voiceRemoveSelected')}
          </button>
          <label>
            {t('voiceLanguage')}
            <select
              disabled={working || recording}
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              {[
                ['auto', t('voiceDetectLanguage')],
                ["en", "English"],
                ["pt", "Português"],
                ["es", "Español"],
                ["fr", "Français"],
                ["de", "Deutsch"],
                ["ja", "日本語"],
                ["zh", "中文"],
                ["ko", "한국어"],
                ["hi", "हिन्दी"],
                ["ar", "العربية"],
              ].map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : engine === 'parakeet' ? (
        <>
          <p>{t('voiceParakeetHint')}</p>
          <p>{t('voiceParakeetWarning',{bytes:formatNumber(PARAKEET_BYTES),mib:formatNumber(PARAKEET_BYTES/1024/1024,{minimumFractionDigits:1,maximumFractionDigits:1}),diskBytes:formatNumber(1644818882),gib:formatNumber(1644818882/1024/1024/1024,{minimumFractionDigits:2,maximumFractionDigits:2})})}</p>
          <p>{parakeetReceived.current?parakeet.reason:t('voiceParakeetInitial')}</p>
          <p>{parakeet.installed ? (parakeet.ready ? t('voiceParakeetReady') : t('voiceParakeetInstalled')) : t('voiceParakeetNeedsModel')}</p>
          <button disabled={working || recording || !parakeet.available || parakeet.installed} onClick={() => void parakeetAsset(false)}>{t('voiceDownloadParakeet')}</button>
          <button disabled={working || recording || !parakeet.installed} onClick={() => void parakeetAsset(true)}>{t('voiceRemoveParakeet')}</button>
          {parakeet.stage === 'downloading' && <progress aria-label={t('voiceParakeetDownloadLabel')} value={parakeet.received} max={PARAKEET_BYTES}/>}
        </>
      ) : engine === 'cloud' ? (
        <>
          <CloudVoiceSettingsPanel snapshot={cloudSnapshot} onSnapshot={setCloudSnapshot} onBusy={setCloudConfigBusy} disabled={working || recording}/>
          <label>{t('voiceCloudLanguage')}<select value={cloudLanguage} disabled={working || recording || cloudConfigBusy || !cloudSnapshot} onChange={event => setCloudLanguage(event.target.value)}>
            {(cloudSnapshot?.capabilities.languages ?? ['auto']).map(code => <option key={code} value={code}>{code==='auto'?t('voiceDetectLanguage'):CLOUD_LANGUAGES[code]}</option>)}
          </select></label>
        </>
      ) : (
        <>
          <p>{appleReceived.current?apple.reason:t('voiceAppleInitial')}</p>
          <label>
            {t('voiceAppleLanguage')}
            <select
              value={appleLanguage}
              disabled={working || recording}
              onChange={(event) => setAppleLanguage(event.target.value)}
            >
              {apple.supportedLanguages.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <p>
            {apple.installedLanguages.includes(appleLanguage)
              ? t('voiceAppleAssetsInstalled')
              : t('voiceAppleAssetsNeeded')}
          </p>
          <button
            disabled={working || recording || !appleLanguage}
            onClick={() => void appleAsset(false)}
          >
            {t('voiceDownloadAppleLanguage')}
          </button>
          <button
            disabled={
              working ||
              recording ||
              !apple.reservedLanguages.includes(appleLanguage)
            }
            onClick={() => void appleAsset(true)}
          >
            {t('voiceReleaseAppleLanguage')}
          </button>
        </>
      )}
      {sessionId && onDirectDictation && <fieldset disabled={working || recording}>
        <legend>{t('voiceDelivery')}</legend>
        <label><input type="checkbox" checked={direct} onChange={event=>{
          setDirect(event.target.checked);setAutoSend(false);setDeliveryStatus("");
        }}/>{t('voiceTypeDirect')}</label>
        <label><input type="checkbox" checked={autoSend} disabled={!direct} onChange={event=>setAutoSend(event.target.checked)}/>{t('voiceAutoSend')}</label>
        <p>{t('voiceDeliveryHint')}</p>
      </fieldset>}
      <div className="tool-bar">
        <button
          disabled={
            working || cloudConfigBusy ||
            (engine === 'parakeet' ? !parakeet.available || !parakeet.installed : engine === "cloud" ? !cloudSnapshot || cloudSnapshot.quota.deviceRemainingSamples < 1600 || cloudSnapshot.quota.globalRemainingSamples < 1600 : engine === "whisper"
              ? !model
              : !apple.available ||
                !apple.installedLanguages.includes(appleLanguage))
          }
          onClick={() => (recording ? recorder.current?.stop() : void start())}
        >
          {recording ? t('voiceStop') : t('voiceRecord')}
        </button>
        {(busy || recording || (parakeet.busy && parakeet.requestId)) && <button disabled={(downloading && cancellingDownload) || parakeet.stage === 'finishing'} onClick={cancel}>{parakeet.stage === 'finishing' ? t('voiceFinishingCancel') : downloading?(cancellingDownload?t('voiceCancellingDownload'):t('voiceCancelDownload')):t('voiceCancel')}</button>}
      </div>
      {(parakeet.busy || progress) && <p role="status">{parakeet.busy && parakeet.requestId ? (
        parakeet.stage === 'finishing' ? t('voiceParakeetFinishing')
        : parakeet.stage === 'downloading' ? t('voiceParakeetProgress',{percent:formatNumber(Math.floor(parakeet.received/PARAKEET_BYTES*100))})
        : parakeet.stage === 'preparing' ? t('voiceParakeetPreparing')
        : parakeet.stage === 'loading' ? t('voiceParakeetLoading')
        : parakeet.stage === 'removing' ? t('voiceParakeetRemoving') : t('voiceParakeetTranscribing')
      ) : progress ? progressText(progress) : t('voiceEngineBusy')}</p>}
      {deliveryStatus && <p role="status">{t(deliveryStatus)}</p>}
      <label>
        {t('voiceDraft')}
        <textarea
          rows={7}
          value={draft}
          maxLength={65536}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="tool-bar">
        <button
          disabled={!draft}
          onClick={() => {
            void navigator.clipboard
              .writeText(draft)
              .catch((e) => setError(e));
          }}
        >
          {t('voiceCopyDraft')}
        </button>
        {sessionId && (
          <button
            disabled={!draft}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("lazysh-prompt-draft", {
                  detail: { sessionId, text: draft },
                }),
              )
            }
          >
            {t('voiceStageTerminal')}
          </button>
        )}
      </div>
      <VoiceHistoryPanel history={history} onReuse={setDraft} disabled={working || recording}/>
    </section>
  );
}
