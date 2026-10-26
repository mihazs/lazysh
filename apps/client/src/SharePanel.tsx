import {t,useUi,formatNumber,formatDateTime} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";

import { imageSize } from "./attachment";

type Status = { configured: boolean; origin: string | null };
type Share = {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  url: string;
};
type Page = { schemaVersion: 1; shares: Share[]; nextCursor: string | null };
const limit = 10 * 1024 * 1024;
const thumbnailInputLimit = 2 * 1024 * 1024;
type Thumbnail = { url: string; id: string; name: string; width: number; height: number };
const imageShare = (item: Share) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mime.toLowerCase()) || /\.(png|jpe?g|gif|webp)$/i.test(item.name);
export function thumbnailBlob(value: unknown): { blob: Blob; width: number; height: number } {
  if (!value || typeof value !== 'object') throw new LocalUiError('shareInvalidPreview');
  const result = value as Record<string, unknown>;
  if (result.mime !== 'image/png' || !Number.isSafeInteger(result.width) || Number(result.width) < 1 || Number(result.width) > 256 || !Number.isSafeInteger(result.height) || Number(result.height) < 1 || Number(result.height) > 256 || !Array.isArray(result.data) || result.data.length > 512 * 1024 || result.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new LocalUiError('shareInvalidPreview');
  const bytes = Uint8Array.from(result.data);
  const dimensions = imageSize(bytes);
  if (!dimensions || dimensions.mime !== 'image/png' || dimensions.width !== result.width || dimensions.height !== result.height) throw new LocalUiError('sharePreviewMismatch');
  return { blob: new Blob([bytes], { type: 'image/png' }), width: dimensions.width, height: dimensions.height };
}
function originUrl(value: string): URL {
  let url:URL;try{url=new URL(value);}catch{throw new LocalUiError('shareOriginInvalid');}
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new LocalUiError('shareOriginInvalid');
  return url;
}
export function parseShare(value: unknown, origin: string): Share {
  const item = value as Share;
  if (
    !item ||
    !/^[a-f0-9]{64}$/.test(item.id) ||
    typeof item.name !== "string" ||
    !item.name ||
    item.name.length > 255 ||
    typeof item.mime !== "string" ||
    item.mime.length > 128 ||
    !Number.isSafeInteger(item.size) ||
    item.size < 0 ||
    item.size > limit ||
    !Number.isSafeInteger(item.createdAt) ||
    !Number.isSafeInteger(item.expiresAt) ||
    item.createdAt < 0 ||
    item.expiresAt <= item.createdAt ||
    item.expiresAt > 8640000000000 ||
    typeof item.url !== "string"
  )
    throw new LocalUiError('shareResponseInvalid');
  let url:URL;try{url=new URL(item.url);}catch{throw new LocalUiError('shareAddressInvalid');}
  if (
    url.origin !== originUrl(origin).origin ||
    url.username ||
    url.password ||
    url.pathname !== `/s/${item.id}` ||
    url.search ||
    url.hash
  )
    throw new LocalUiError('shareAddressInvalid');
  return item;
}
function parsePage(value: unknown, origin: string): Page {
  const page = value as Page;
  if (
    !page ||
    page.schemaVersion !== 1 ||
    !Array.isArray(page.shares) ||
    page.shares.length > 50 ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" || page.nextCursor.length > 1024))
  )
    throw new LocalUiError('shareHistoryInvalid');
  return {
    ...page,
    shares: page.shares.map((item) => parseShare(item, origin)),
  };
}

export default function SharePanel() {
  useUi();
  const invoke = useProtectedInvoke();
  const [status, setStatus] = useState<Status>({
    configured: false,
    origin: null,
  });
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ttl, setTtl] = useState(3600);
  const [items, setItems] = useState<Share[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<UiErrorCause>("");
  const [message, setMessage] = useState<null|'shareSaved'|'shareForgotten'|'shareComplete'|'shareCompletedBeforeCancellation'|'shareCopied'>(null);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);
  const cancelled = useRef(false);
  const uploadId = useRef<string | null>(null);
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(null);
  const [thumbnailLoading, setThumbnailLoading] = useState<string | null>(null);
  const [thumbnailCancelling, setThumbnailCancelling] = useState(false);
  const thumbnailUrl = useRef<string | null>(null);
  const thumbnailGeneration = useRef(0);
  const thumbnailRequest = useRef<string | null>(null);
  function clearThumbnail() {
    thumbnailGeneration.current++;
    if (thumbnailUrl.current) { URL.revokeObjectURL(thumbnailUrl.current); thumbnailUrl.current = null; }
    if (thumbnailRequest.current) {
      if (alive.current) setThumbnailCancelling(true);
      void invoke('share_thumbnail_cancel', { requestId: thumbnailRequest.current }).catch(() => {});
    }
    if (alive.current) setThumbnail(null);
  }
  useEffect(() => {
    alive.current = true;
    void invoke<Status>("share_status")
      .then((value) => {
        if (value.origin) originUrl(value.origin);
        if (alive.current) {
          setStatus(value);
          setOrigin(value.origin || "");
        }
      })
      .catch((e) => {
        if (alive.current) setError(captureUiError(e));
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
    const clock = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      alive.current = false;
      clearThumbnail();
      cancelled.current = true;
      clearInterval(clock);
      if (uploadId.current)
        void invoke("share_upload_cancel", { id: uploadId.current }).catch(
          () => {},
        );
    };
  }, []);
  async function configure() {
    clearThumbnail();
    setBusy(true);
    setError("");
    setMessage(null);
    try {
      originUrl(origin);
      const value = await invoke<Status>("share_configure", { origin, token });
      if (alive.current) {
        setStatus(value);
        setToken("");
        setItems([]);
        setCursor(null);
        setMessage('shareSaved');
      }
    } catch (e) {
      if (alive.current) setError(captureUiError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function history(next: string | null = null) {
    if (!status.origin) return;
    clearThumbnail();
    setBusy(true);
    setError("");
    try {
      const page = parsePage(
        await invoke("share_list", { limit: 50, cursor: next }),
        status.origin,
      );
      if (alive.current) {
        setItems(page.shares);
        setCursor(page.nextCursor);
      }
    } catch (e) {
      if (alive.current) setError(captureUiError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function upload() {
    if (!file || !status.origin) return;
    if (file.size > limit) {
      setError(new LocalUiError('shareFileLimit'));
      return;
    }
    setBusy(true);
    setUploading(true);
    setProgress(0);
    setError("");
    setMessage(null);
    cancelled.current = false;
    let sent = false;
    try {
      const result = await invoke<{ id: string }>("share_upload_begin", {
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        ttlSeconds: ttl,
      });
      uploadId.current = result.id;
      for (let offset = 0; offset < file.size; offset += 256 * 1024) {
        if (cancelled.current || !alive.current)
          throw new LocalUiError('shareUploadCancelled');
        const chunk = new Uint8Array(
          await file.slice(offset, offset + 256 * 1024).arrayBuffer(),
        );
        if (cancelled.current || !alive.current)
          throw new LocalUiError('shareUploadCancelled');
        await invoke("share_upload_chunk", {
          id: result.id,
          offset,
          data: Array.from(chunk),
        });
        if (alive.current)
          setProgress(Math.min(file.size, offset + chunk.length));
      }
      if (cancelled.current || !alive.current)
        throw new LocalUiError('shareUploadCancelled');
      sent = true;
      const response = await invoke<{ schemaVersion: number; share: unknown }>(
        "share_upload_finish",
        { id: result.id },
      );
      if (response.schemaVersion !== 1)
        throw new LocalUiError('shareResponseUnsupported');
      const item = parseShare(response.share, status.origin);
      uploadId.current = null;
      if (alive.current) {
        setItems((current) =>
          [
            item,
            ...current.filter((existing) => existing.id !== item.id),
          ].slice(0, 50),
        );
        setMessage(cancelled.current ? 'shareCompletedBeforeCancellation' : 'shareComplete');
      } else window.dispatchEvent(new CustomEvent('lazysh-error',{detail:new LocalUiError('shareCompletedWhileClosing')}));
    } catch (e) {
      if (alive.current)
        setError(
          cancelled.current
            ? new LocalUiError('shareCancellationCheck')
            : captureUiError(e),
        );
      else if(sent)window.dispatchEvent(new CustomEvent('lazysh-error',{detail:new LocalUiError('shareStoppedWhileClosing')}));
    } finally {
      if (uploadId.current) {
        await invoke("share_upload_cancel", { id: uploadId.current }).catch(
          () => {},
        );
        uploadId.current = null;
      }
      if (alive.current) {
        setBusy(false);
        setUploading(false);
      }
    }
  }
  async function remove(item: Share) {
    if (
      !window.confirm(
        t('shareConfirmDelete',{name:item.name}),
      )
    )
      return;
    clearThumbnail();
    setBusy(true);
    setError("");
    try {
      await invoke("share_delete", { id: item.id });
      if (alive.current)
        setItems((current) =>
          current.filter((existing) => existing.id !== item.id),
        );
    } catch (e) {
      if (alive.current) setError(captureUiError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function preview(item: Share) {
    if (!status.origin || thumbnailRequest.current || busy || item.expiresAt * 1000 <= Date.now() || item.size > thumbnailInputLimit || !imageShare(item)) return;
    clearThumbnail();
    const generation = thumbnailGeneration.current;
    const requestId = crypto.randomUUID();
    thumbnailRequest.current = requestId;
    setThumbnailLoading(item.id); setThumbnailCancelling(false); setError('');
    try {
      const response = await invoke('share_thumbnail', { id: item.id, requestId });
      if (!alive.current || generation !== thumbnailGeneration.current || item.expiresAt * 1000 <= Date.now()) return;
      const result = thumbnailBlob(response);
      const url = URL.createObjectURL(result.blob);
      thumbnailUrl.current = url;
      setThumbnail({ url, id: item.id, name: item.name, width: result.width, height: result.height });
    } catch (e) { if (alive.current && generation === thumbnailGeneration.current) setError(captureUiError(e)); }
    finally {
      if (thumbnailRequest.current === requestId) {
        thumbnailRequest.current = null;
        if (alive.current) { setThumbnailLoading(null); setThumbnailCancelling(false); }
      }
    }
  }
  useEffect(() => {
    if (thumbnail && !items.some(item => item.id === thumbnail.id && item.expiresAt * 1000 > now)) clearThumbnail();
  }, [now, items, thumbnail]);
  return (
    <section className="preferences-panel" aria-label={t('shareTitle')}>
      <h2>{t('shareTitle')}</h2>
      <p>
        {t('shareScope')}
      </p>
      {error && <p role="alert">{uiErrorText(error)}</p>}
      {message && <p role="status">{t(message)}</p>}
      <fieldset disabled={busy}>
        <legend>{t('shareServiceLegend')}</legend>
        <label>
          {t('shareOriginLabel')}
          <input
            type="url"
            placeholder="https://files.example.com"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
        </label>
        <label>
          {t('shareToken')}
          <input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            maxLength={64}
          />
        </label>
        <p>
          {t('shareTokenHint')}
        </p>
        <button onClick={() => void configure()} disabled={!origin.trim()}>
          {t('shareSave')}
        </button>
      {status.configured && <button onClick={()=>{
        clearThumbnail();
        setBusy(true);setError("");
        void invoke("share_forget").then(()=>{if(alive.current){setStatus({configured:false,origin:null});setOrigin("");setToken("");setItems([]);setCursor(null);setMessage('shareForgotten');}}).catch(e=>{if(alive.current)setError(captureUiError(e));}).finally(()=>{if(alive.current)setBusy(false);});
      }}>{t('shareForget')}</button>}
      </fieldset>
      <fieldset disabled={busy || !status.configured}>
        <legend>{t('shareNew')}</legend>
        <label>
          {t('shareFile')}
          <input
            type="file"
            onChange={(event) => {
              setFile(event.target.files?.[0] || null);
              setError("");
            }}
          />
        </label>
        {file && (
          <p>
            {t('shareMetadata',{name:file.name,bytes:formatNumber(file.size)})}
          </p>
        )}
        <label>
          {t('shareLifetime')}
          <select
            value={ttl}
            onChange={(event) => setTtl(Number(event.target.value))}
          >
            <option value={3600}>{t('shareHour')}</option>
            <option value={86400}>{t('shareDay')}</option>
            <option value={604800}>{t('shareWeek')}</option>
          </select>
        </label>
        <button
          disabled={!file || file.size > limit}
          onClick={() => void upload()}
        >
          {t('shareUpload')}
        </button>
      </fieldset>
      {uploading && (
        <div>
          <label>
            {t('sharePreparing')}
            <progress max={file?.size || 1} value={progress} />
          </label>
          {progress === file?.size && <p>{t('shareSending')}</p>}
          <button
            onClick={() => {
              cancelled.current = true;
              if (uploadId.current)
                void invoke("share_upload_cancel", {
                  id: uploadId.current,
                }).catch(() => {});
            }}
          >
            {t('shareCancel')}
          </button>
        </div>
      )}
      <button
        disabled={busy || !status.configured}
        onClick={() => void history()}
      >
        {t('shareHistory')}
      </button>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <strong>{item.name}</strong>
            <p>
              {t(item.expiresAt * 1000 <= now?'shareExpired':'shareExpires',{bytes:formatNumber(item.size),time:formatDateTime(new Date(item.expiresAt * 1000))})}
            </p>
            {imageShare(item) && <><button disabled={busy || thumbnailLoading !== null || item.expiresAt * 1000 <= now || item.size > thumbnailInputLimit} onClick={() => void preview(item)}>{t('shareLoadThumbnail',{name:item.name})}</button>{item.size > thumbnailInputLimit && <small>{t('sharePreviewLimit')}</small>}</>}
            {thumbnail?.id === item.id && <figure className="share-thumbnail"><img key={thumbnail.url} src={thumbnail.url} width={thumbnail.width} height={thumbnail.height} alt={t('shareThumbnailAlt',{name:thumbnail.name})} onLoad={event => {
              if (thumbnailUrl.current !== thumbnail.url) return;
              if (event.currentTarget.naturalWidth !== thumbnail.width || event.currentTarget.naturalHeight !== thumbnail.height) { clearThumbnail(); setError(new LocalUiError('shareDecodedMismatch')); }
            }} onError={() => { if (thumbnailUrl.current === thumbnail.url) { clearThumbnail(); setError(new LocalUiError('shareDisplayFailed')); } }} /><figcaption>{t('sharePreviewCaption',{width:formatNumber(thumbnail.width),height:formatNumber(thumbnail.height)})}</figcaption><button onClick={clearThumbnail}>{t('shareHideThumbnail',{name:item.name})}</button></figure>}
            <button
              disabled={busy || item.expiresAt * 1000 <= now}
              onClick={() => {
                void navigator.clipboard
                  .writeText(item.url)
                  .then(() => setMessage('shareCopied'))
                  .catch(() => setError(new LocalUiError('shareClipboardUnavailable')));
              }}
            >
              {t('shareCopy',{name:item.name})}
            </button>
            <button disabled={busy} onClick={() => void remove(item)}>
              {t('shareDelete',{name:item.name})}
            </button>
          </li>
        ))}
      </ul>
      {thumbnailLoading && <div className="share-thumbnail-loading"><p role="status">{thumbnailCancelling ? t('shareStopping') : t('shareLoading')}</p><button disabled={thumbnailCancelling} onClick={clearThumbnail}>{t('shareCancelThumbnail')}</button></div>}
      {cursor && (
        <button disabled={busy} onClick={() => void history(cursor)}>
          {t('shareOlder')}
        </button>
      )}
    </section>
  );
}
