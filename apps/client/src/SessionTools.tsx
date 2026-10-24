import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  File,
  Folder,
  RefreshCw,
  Upload,
  GitCompareArrows,
  Layers,
} from "lucide-react";
import { api, type FileEntry, type MuxSession } from "./bridge";

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}

const join = (parent: string, child: string) =>
  `${parent.replace(/\/$/, "")}/${child}`;

export function FilesPanel({ sessionId }: { sessionId: string }) {
  const [path, setPath] = useState(".");
  const [draft, setDraft] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [content, setContent] = useState<{ path: string; text: string } | null>(
    null,
  );
  const [error, setError] = useState("");
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
      if (current === request.current) setError(errorMessage(e));
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
      if (current === request.current) setError(errorMessage(e));
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
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tool-panel" aria-label="Remote files">
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
          aria-label="Parent directory"
          disabled={busy}
          onClick={() => void load(join(path, ".."))}
        >
          <ArrowLeft size={16} />
        </button>
        <label className="sr-only" htmlFor="remote-path">
          Remote directory
        </label>
        <input
          id="remote-path"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          required
        />
        <button className="subtle-button" disabled={busy}>
          Open
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh files"
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
          <Upload size={15} /> Upload
        </button>
        <input
          type="file"
          className="sr-only"
          ref={picker}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) {
              setError("Choose a file smaller than 10 MiB.");
              return;
            }
            setUpload(file);
            setDestination(join(path, file.name));
          }}
        />
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {upload && (
        <div className="upload-confirm">
          <p>
            Upload <strong>{upload.name}</strong> (
            {upload.size.toLocaleString()} bytes) to this host?
          </p>
          <label>
            Destination path
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
              Upload file
            </button>
            <button
              className="subtle-button"
              disabled={busy}
              onClick={() => setUpload(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {busy && (
        <p className="loading" role="status">
          Loading from host…
        </p>
      )}
      <div className="file-layout">
        <div className="file-list" aria-label="Directory entries">
          {entries.length === 0 && !busy && (
            <p className="muted">This directory is empty.</p>
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
                {entry.isDir ? "" : `${entry.size.toLocaleString()} B`}
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
              <h3>Read from the source.</h3>
              <p>
                Select a file to view its contents.
                <br />
                Files stay on your host until you open them.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function DiffPanel({ sessionId }: { sessionId: string }) {
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
    <section className="tool-panel" aria-label="Git diff">
      <form
        className="tool-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label className="sr-only" htmlFor="repository-path">
          Repository path
        </label>
        <input
          id="repository-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Repository path on host"
          required
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={staged}
            onChange={(e) => setStaged(e.target.checked)}
          />{" "}
          Staged
        </label>
        <button className="subtle-button" disabled={busy}>
          {busy ? "Loading…" : "Read diff"}
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
          <h3>Review before you return.</h3>
          <p>
            Enter the repository path on your host to read
            <br />
            its working tree or staged changes.
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
          <h3>No changes in this diff.</h3>
          <p>
            {staged
              ? "Nothing is staged."
              : "The tracked working tree is clean. Untracked files are not included."}
          </p>
        </div>
      )}
    </section>
  );
}

export function MuxPanel({
  sessionId,
  onAttach,
}: {
  sessionId: string;
  onAttach: (name: string) => Promise<void>;
}) {
  const [sessions, setSessions] = useState<MuxSession[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setSessions(await api.muxSessions(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [sessionId]);
  async function attach(name: string) {
    setBusy(true);
    setError("");
    try {
      await onAttach(name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="tool-panel">
      <div className="tool-bar">
        <h3>tmux sessions</h3>
        <button
          className="subtle-button"
          onClick={() => void load()}
          disabled={busy}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="loading" role="status">
          Reading sessions…
        </p>
      )}
      {!busy && !error && sessions.length === 0 && (
        <div className="panel-empty">
          <Layers size={28} />
          <h3>No tmux sessions found.</h3>
          <p>
            Start tmux on this host to keep agents running
            <br />
            when you disconnect.
          </p>
          <code>tmux new -s work</code>
        </div>
      )}
      <div className="mux-list">
        {sessions.map((session) => (
          <div className="mux-row" key={session.id}>
            <Layers size={18} />
            <div>
              <strong>{session.name}</strong>
              <small>
                {session.windows} windows ·{" "}
                {session.attached ? "attached elsewhere" : "detached"}
              </small>
            </div>
            <button
              className="subtle-button"
              disabled={busy}
              onClick={() => void attach(session.name)}
            >
              Attach
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
