import {t, useUi, formatNumber} from './i18n/core';
import { useProtectedApi } from './access';
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  File,
  Folder,
  RefreshCw,
  Upload,
  GitCompareArrows,
} from "lucide-react";
import { api as nativeApi, type FileEntry } from "./bridge";
export { MuxPanel } from "./MultiplexerPanel";

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}

/** Only client-created failures carry local keys; host strings are never interpreted. */
export class LocalFileError extends Error {
  constructor(readonly key: 'filesTooLarge' | 'repoInvalid' | 'repoSubmodule' | 'repoInvalidFile') {
    super(t(key));
  }
}
type FileErrorCause = string | LocalFileError;
export type FileErrorState = FileErrorCause | {history: FileErrorCause};
export function captureFileError(error: unknown): FileErrorCause {
  return error instanceof LocalFileError ? error : errorMessage(error);
}
export function fileErrorText(error: FileErrorState): string {
  if (typeof error === 'string') return error;
  if (error instanceof LocalFileError) return t(error.key);
  return t('repoHistoryUnavailable', {error: fileErrorText(error.history)});
}

const join = (parent: string, child: string) =>
  `${parent.replace(/\/$/, "")}/${child}`;

export function FilesPanel({ sessionId }: { sessionId: string }) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const [path, setPath] = useState(".");
  const [draft, setDraft] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [content, setContent] = useState<{ path: string; text: string } | null>(
    null,
  );
  const [error, setError] = useState<FileErrorState>("");
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<File | null>(null);
  const [destination, setDestination] = useState("");
  const request = useRef(0);
  const picker = useRef<HTMLInputElement>(null);

  async function load(next: string) {
    const current = ++request.current;
    setBusy(true);
    setError("");
    try {
      const result = await api.listDirectory(sessionId, next);
      if (current !== request.current) return;
      setEntries(
        result.sort(
          (a, b) =>
            Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
        ),
      );
      setPath(next);
      setDraft(next);
      setContent(null);
    } catch (e) {
      if (current === request.current) setError(captureFileError(e));
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  useEffect(() => {
    void load(".");
    return () => {
      request.current++;
    };
  }, [sessionId]);

  async function open(entry: FileEntry) {
    const next = join(path, entry.name);
    if (entry.isDir) {
      await load(next);
      return;
    }
    const current = ++request.current;
    setBusy(true);
    setError("");
    try {
      const text = await api.readFile(sessionId, next);
      if (current === request.current) setContent({ path: next, text });
    } catch (e) {
      if (current === request.current) setError(captureFileError(e));
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  async function sendFile() {
    if (!upload || !destination.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.uploadFile(
        sessionId,
        destination,
        Array.from(new Uint8Array(await upload.arrayBuffer())),
      );
      setUpload(null);
      await load(path);
    } catch (e) {
      setError(captureFileError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tool-panel" aria-label={t('filesRemote')}>
      <form
        className="tool-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void load(draft);
        }}
      >
        <button
          type="button"
          className="icon-button"
          aria-label={t('filesParent')}
          disabled={busy}
          onClick={() => void load(join(path, ".."))}
        >
          <ArrowLeft size={16} />
        </button>
        <label className="sr-only" htmlFor="remote-path">
          {t('filesDirectory')}
        </label>
        <input
          id="remote-path"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          required
        />
        <button className="subtle-button" disabled={busy}>
          {t('filesOpen')}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('filesRefresh')}
          disabled={busy}
          onClick={() => void load(path)}
        >
          <RefreshCw size={16} />
        </button>
        <button
          type="button"
          className="subtle-button"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <Upload size={15} /> {t('filesUpload')}
        </button>
        <input
          type="file"
          aria-label={t('filesChooseUpload')}
          className="sr-only"
          ref={picker}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) {
              setError(new LocalFileError('filesTooLarge'));
              return;
            }
            setUpload(file);
            setDestination(join(path, file.name));
          }}
        />
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {fileErrorText(error)}
        </p>
      )}
      {upload && (
        <div className="upload-confirm">
          <p>
            {t('filesConfirm',{name:upload.name,bytes:formatNumber(upload.size)})}
          </p>
          <label>
            {t('filesDestination')}
            <input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              className="primary-button"
              disabled={busy || !destination.trim()}
              onClick={() => void sendFile()}
            >
              {t('filesUploadFile')}
            </button>
            <button
              className="subtle-button"
              disabled={busy}
              onClick={() => setUpload(null)}
            >
              {t('filesCancel')}
            </button>
          </div>
        </div>
      )}
      {busy && (
        <p className="loading" role="status">
          {t('filesLoading')}
        </p>
      )}
      <div className="file-layout">
        <div className="file-list" aria-label={t('filesEntries')}>
          {entries.length === 0 && !busy && (
            <p className="muted">{t('filesEmpty')}</p>
          )}
          {entries.map((entry) => (
            <button
              key={entry.name}
              className="file-entry"
              disabled={busy}
              onClick={() => void open(entry)}
            >
              {entry.isDir ? <Folder size={16} /> : <File size={16} />}
              <span>{entry.name}</span>
              <small>
                {entry.isDir ? "" : `${formatNumber(entry.size)} B`}
              </small>
            </button>
          ))}
        </div>
        <div className="file-preview">
          {content ? (
            <>
              <div className="preview-heading">{content.path}</div>
              <pre tabIndex={0}>{content.text}</pre>
            </>
          ) : (
            <div className="panel-empty">
              <File size={28} />
              <h3>{t('filesReadSource')}</h3>
              <p>
                {t('filesReadHint')}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function DiffPanel({ sessionId }: { sessionId: string }) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const [path, setPath] = useState(".");
  const [staged, setStaged] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setDiff(await api.diff(sessionId, path, staged));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="tool-panel" aria-label={t('diffTitle')}>
      <form
        className="tool-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label className="sr-only" htmlFor="repository-path">
          {t('diffPath')}
        </label>
        <input
          id="repository-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t('diffPathHint')}
          required
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={staged}
            onChange={(e) => setStaged(e.target.checked)}
          />{" "}
          {t('diffStaged')}
        </label>
        <button className="subtle-button" disabled={busy}>
          {busy ? t('diffLoading') : t('diffRead')}
        </button>
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {diff === null ? (
        <div className="panel-empty">
          <GitCompareArrows size={28} />
          <h3>{t('diffReview')}</h3>
          <p>
            {t('diffHint')}
          </p>
        </div>
      ) : diff ? (
        <pre className="diff-content" tabIndex={0}>
          {diff.split("\n").map((line, i) => (
            <span
              key={i}
              className={
                line.startsWith("+")
                  ? "diff-add"
                  : line.startsWith("-")
                    ? "diff-remove"
                    : line.startsWith("@@")
                      ? "diff-location"
                      : ""
              }
            >
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <div className="panel-empty">
          <GitCompareArrows size={28} />
          <h3>{t('diffEmpty')}</h3>
          <p>
            {staged
              ? t('diffNothingStaged')
              : t('diffClean')}
          </p>
        </div>
      )}
    </section>
  );
}
