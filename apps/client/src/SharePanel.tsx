import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "./SessionTools";
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
  if (!value || typeof value !== 'object') throw new Error('Invalid image preview.');
  const result = value as Record<string, unknown>;
  if (result.mime !== 'image/png' || !Number.isSafeInteger(result.width) || Number(result.width) < 1 || Number(result.width) > 256 || !Number.isSafeInteger(result.height) || Number(result.height) < 1 || Number(result.height) > 256 || !Array.isArray(result.data) || result.data.length > 512 * 1024 || result.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Invalid image preview.');
  const bytes = Uint8Array.from(result.data);
  const dimensions = imageSize(bytes);
  if (!dimensions || dimensions.mime !== 'image/png' || dimensions.width !== result.width || dimensions.height !== result.height) throw new Error('Image preview dimensions do not match its contents.');
  return { blob: new Blob([bytes], { type: 'image/png' }), width: dimensions.width, height: dimensions.height };
}
function originUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use the HTTPS origin of your sharing service.");
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
    throw new Error("Invalid sharing service response.");
  const url = new URL(item.url);
  if (
    url.origin !== originUrl(origin).origin ||
    url.username ||
    url.password ||
    url.pathname !== `/s/${item.id}` ||
    url.search ||
    url.hash
  )
    throw new Error("The service returned an unexpected download address.");
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
    throw new Error("Invalid sharing history response.");
  return {
    ...page,
    shares: page.shares.map((item) => parseShare(item, origin)),
  };
}

export default function SharePanel() {
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
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
        if (alive.current) setError(errorMessage(e));
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
    setMessage("");
    try {
      originUrl(origin);
      const value = await invoke<Status>("share_configure", { origin, token });
      if (alive.current) {
        setStatus(value);
        setToken("");
        setItems([]);
        setCursor(null);
        setMessage("Sharing service saved on this device.");
      }
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
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
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function upload() {
    if (!file || !status.origin) return;
    if (file.size > limit) {
      setError("Files must be 10 MiB or smaller.");
      return;
    }
    setBusy(true);
    setUploading(true);
    setProgress(0);
    setError("");
    setMessage("");
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
          throw new Error("Upload cancelled.");
        const chunk = new Uint8Array(
          await file.slice(offset, offset + 256 * 1024).arrayBuffer(),
        );
        if (cancelled.current || !alive.current)
          throw new Error("Upload cancelled.");
        await invoke("share_upload_chunk", {
          id: result.id,
          offset,
          data: Array.from(chunk),
        });
        if (alive.current)
          setProgress(Math.min(file.size, offset + chunk.length));
      }
      if (cancelled.current || !alive.current)
        throw new Error("Upload cancelled.");
      sent = true;
      const response = await invoke<{ schemaVersion: number; share: unknown }>(
        "share_upload_finish",
        { id: result.id },
      );
      if (response.schemaVersion !== 1)
        throw new Error("Unsupported sharing service response.");
      const item = parseShare(response.share, status.origin);
      uploadId.current = null;
      if (alive.current) {
        setItems((current) =>
          [
            item,
            ...current.filter((existing) => existing.id !== item.id),
          ].slice(0, 50),
        );
        setMessage(cancelled.current ? "Upload completed before cancellation. Delete it below to revoke the link." : "Upload complete. Copy its expiring link below.");
      } else window.dispatchEvent(new CustomEvent('lazysh-error',{detail:'A shared upload completed while the dialog was closing. Open Shareable uploads and refresh history to delete it.'}));
    } catch (e) {
      if (alive.current)
        setError(
          cancelled.current
            ? "Upload cancelled. Refresh history to check for a completed upload."
            : errorMessage(e),
        );
      else if(sent)window.dispatchEvent(new CustomEvent('lazysh-error',{detail:'A shared upload stopped while the dialog was closing. Refresh sharing history to check whether the service completed it.'}));
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
        `Delete the shared file “${item.name}” and revoke its link?`,
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
      if (alive.current) setError(errorMessage(e));
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
    } catch (e) { if (alive.current && generation === thumbnailGeneration.current) setError(errorMessage(e)); }
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
    <section className="preferences-panel" aria-label="Shareable uploads">
      <h2>Shareable uploads</h2>
      <p>
        Optional: send a selected file to your HTTPS sharing service and create
        an expiring download link. Host attachments use SSH separately.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <fieldset disabled={busy}>
        <legend>Service on this device</legend>
        <label>
          Sharing service origin
          <input
            type="url"
            placeholder="https://files.example.com"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
        </label>
        <label>
          Management token
          <input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            maxLength={64}
          />
        </label>
        <p>
          The token stays in the native credential store. Leave it blank to keep
          the existing token for the same service.
        </p>
        <button onClick={() => void configure()} disabled={!origin.trim()}>
          Save sharing service
        </button>
      {status.configured && <button onClick={()=>{
        clearThumbnail();
        setBusy(true);setError("");
        void invoke("share_forget").then(()=>{if(alive.current){setStatus({configured:false,origin:null});setOrigin("");setToken("");setItems([]);setCursor(null);setMessage("Service credentials removed from this device.");}}).catch(e=>{if(alive.current)setError(errorMessage(e));}).finally(()=>{if(alive.current)setBusy(false);});
      }}>Forget service on this device</button>}
      </fieldset>
      <fieldset disabled={busy || !status.configured}>
        <legend>New expiring link</legend>
        <label>
          File to share
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
            {file.name} · {file.size.toLocaleString()} bytes
          </p>
        )}
        <label>
          Link lifetime
          <select
            value={ttl}
            onChange={(event) => setTtl(Number(event.target.value))}
          >
            <option value={3600}>1 hour</option>
            <option value={86400}>1 day</option>
            <option value={604800}>7 days</option>
          </select>
        </label>
        <button
          disabled={!file || file.size > limit}
          onClick={() => void upload()}
        >
          Upload and create link
        </button>
      </fieldset>
      {uploading && (
        <div>
          <label>
            Preparing upload
            <progress max={file?.size || 1} value={progress} />
          </label>
          {progress === file?.size && <p>Sending to the sharing service…</p>}
          <button
            onClick={() => {
              cancelled.current = true;
              if (uploadId.current)
                void invoke("share_upload_cancel", {
                  id: uploadId.current,
                }).catch(() => {});
            }}
          >
            Cancel upload
          </button>
        </div>
      )}
      <button
        disabled={busy || !status.configured}
        onClick={() => void history()}
      >
        Refresh upload history
      </button>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <strong>{item.name}</strong>
            <p>
              {item.size.toLocaleString()} bytes ·{" "}
              {item.expiresAt * 1000 <= now ? "Expired" : "Expires"}{" "}
              {new Date(item.expiresAt * 1000).toLocaleString()}
            </p>
            {imageShare(item) && <><button disabled={busy || thumbnailLoading !== null || item.expiresAt * 1000 <= now || item.size > thumbnailInputLimit} onClick={() => void preview(item)}>Load thumbnail for {item.name}</button>{item.size > thumbnailInputLimit && <small>Image previews are limited to 2 MiB. Copy the link to download the original.</small>}</>}
            {thumbnail?.id === item.id && <figure className="share-thumbnail"><img key={thumbnail.url} src={thumbnail.url} width={thumbnail.width} height={thumbnail.height} alt={`Thumbnail of ${thumbnail.name}`} onLoad={event => {
              if (thumbnailUrl.current !== thumbnail.url) return;
              if (event.currentTarget.naturalWidth !== thumbnail.width || event.currentTarget.naturalHeight !== thumbnail.height) { clearThumbnail(); setError('Image preview decoded to unexpected dimensions.'); }
            }} onError={() => { if (thumbnailUrl.current === thumbnail.url) { clearThumbnail(); setError('Image preview could not be displayed. Download the original file instead.'); } }} /><figcaption>Static PNG preview · {thumbnail.width} × {thumbnail.height}</figcaption><button onClick={clearThumbnail}>Hide thumbnail for {item.name}</button></figure>}
            <button
              disabled={busy || item.expiresAt * 1000 <= now}
              onClick={() => {
                void navigator.clipboard
                  .writeText(item.url)
                  .then(() => setMessage("Expiring link copied."))
                  .catch(() => setError("Clipboard unavailable."));
              }}
            >
              Copy link for {item.name}
            </button>
            <button disabled={busy} onClick={() => void remove(item)}>
              Delete {item.name}
            </button>
          </li>
        ))}
      </ul>
      {thumbnailLoading && <div className="share-thumbnail-loading"><p role="status">{thumbnailCancelling ? 'Stopping image preview…' : 'Loading image preview…'}</p><button disabled={thumbnailCancelling} onClick={clearThumbnail}>Cancel thumbnail loading</button></div>}
      {cursor && (
        <button disabled={busy} onClick={() => void history(cursor)}>
          Older uploads
        </button>
      )}
    </section>
  );
}
