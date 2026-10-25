import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MAX_VOICE_SECONDS, mono16k, validModelFile } from "./voice";
import { errorMessage } from "./SessionTools";

type Model = { id: string; bytes: number };
type AppleCapability = {
  available: boolean;
  reason: string;
  supportedLanguages: string[];
  installedLanguages: string[];
  reservedLanguages: string[];
};
export default function VoicePanel({ sessionId }: { sessionId?: string }) {
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [language, setLanguage] = useState("auto");
  const [engine, setEngine] = useState<"whisper" | "apple">("whisper");
  const [apple, setApple] = useState<AppleCapability>({
    available: false,
    reason: "Apple SpeechAnalyzer requires a supported iOS device.",
    supportedLanguages: [],
    installedLanguages: [],
    reservedLanguages: [],
  });
  const [appleLanguage, setAppleLanguage] = useState("en-US");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const importId = useRef("");
  const appleRequest = useRef("");
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
      throw new Error("Invalid Apple speech availability response.");
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
      throw new Error("Invalid voice model list.");
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
    void refresh().catch((e) => setError(errorMessage(e)));
    void refreshApple().catch(() => {});
    const hidden = () => {
      if (document.visibilityState !== "visible") cancel();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", cancel);
    return () => {
      generation.current++;
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
    };
  }, []);
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
          throw new Error("Import cancelled.");
        const bytes = Array.from(
          new Uint8Array(
            await file.slice(offset, offset + 1024 * 1024).arrayBuffer(),
          ),
        );
        await invoke("voice_import_chunk", { id, offset, bytes });
        if (current === generation.current)
          setProgress(
            `Importing ${Math.round((Math.min(file.size, offset + bytes.length) / file.size) * 100)}%`,
          );
      }
      if (current !== generation.current) throw new Error("Import cancelled.");
      await invoke("voice_import_finish", { id, cancel: false });
      id = "";
      importId.current = "";
      if (current === generation.current) await refresh();
    } catch (e) {
      if (id)
        await invoke("voice_import_finish", { id, cancel: true }).catch(
          () => {},
        );
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      importId.current = "";
      if (current === generation.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }
  async function transcribe(blob: Blob, current: number) {
    if (current !== generation.current) return;
    releaseMicrophone();
    setRecording(false);
    setBusy(true);
    setProgress("Transcribing on this device…");
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
      if (current !== generation.current) return;
      if (engine === "apple") {
        requestId = crypto.randomUUID();
        appleRequest.current = requestId;
      }
      const text =
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
        throw new Error("Invalid transcription result.");
      if (current === generation.current) {
        setDraft(text);
        if (text) setHistory((previous) => [text, ...previous].slice(0, 20));
      }
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      if (appleRequest.current === requestId) appleRequest.current = "";
      await context?.close().catch(() => {});
      if (current === generation.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }
  async function start() {
    const current = ++generation.current;
    setError("");
    setBusy(true);
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Microphone recording is unavailable in this WebView. Check device microphone permissions.",
        );
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
        video: false,
      });
      if (current !== generation.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      const capture = new MediaRecorder(media);
      recorder.current = capture;
      const parts: Blob[] = [];
      let bytes = 0;
      capture.ondataavailable = (event) => {
        bytes += event.data.size;
        if (bytes > 8 * 1024 * 1024) {
          generation.current++;
          capture.stop();
          releaseMicrophone();
          setRecording(false);
          setError("Recording exceeded the audio size limit.");
        } else parts.push(event.data);
      };
      capture.onerror = () => {
        generation.current++;
        releaseMicrophone();
        setRecording(false);
        setError("Microphone recording failed.");
      };
      capture.onstop = () => {
        void transcribe(new Blob(parts, { type: capture.mimeType }), current);
      };
      capture.start(1000);
      setRecording(true);
      timer.current = setTimeout(() => {
        if (capture.state === "recording") capture.stop();
      }, MAX_VOICE_SECONDS * 1000);
    } catch (e) {
      releaseMicrophone();
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function cancel() {
    generation.current++;
    if (recorder.current?.state === "recording") recorder.current.stop();
    releaseMicrophone();
    setRecording(false);
    setBusy(false);
    setProgress("");
    void invoke("voice_cancel").catch((e) => setError(errorMessage(e)));
    if (appleRequest.current) {
      void invoke("apple_speech_cancel", {
        requestId: appleRequest.current,
      }).catch((e) => setError(errorMessage(e)));
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
        ? "Releasing this language model…"
        : "Downloading Apple speech assets…",
    );
    try {
      await invoke(remove ? "apple_speech_remove" : "apple_speech_install", {
        language: appleLanguage,
        requestId,
      });
      if (current === generation.current) await refreshApple();
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      if (appleRequest.current === requestId) appleRequest.current = "";
      if (current === generation.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }
  return (
    <section className="tool-panel voice-panel" aria-label="Local dictation">
      <h3>Local dictation</h3>
      <p>
        Record up to 30 seconds with an on-device engine, then edit the result.
        No automatic cloud fallback.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <label>
        Speech engine
        <select
          value={engine}
          disabled={busy || recording}
          onChange={(event) =>
            setEngine(event.target.value as "whisper" | "apple")
          }
        >
          <option value="whisper">Whisper</option>
          <option value="apple" disabled={!apple.available}>
            Apple SpeechAnalyzer{apple.available ? "" : " — unavailable"}
          </option>
        </select>
      </label>
      {engine === "whisper" ? (
        <>
          <p>
            Whisper runs on this device. Import a trusted tiny/base GGML model.
          </p>
          <label>
            Import model
            <input
              type="file"
              accept=".bin"
              disabled={busy || recording}
              onChange={(event) => {
                void importModel(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
          <label>
            Model
            <select
              value={model}
              disabled={busy || recording}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">Choose a model</option>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id} ({Math.round(item.bytes / 1024 / 1024)} MiB)
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!model || busy || recording}
            onClick={() => {
              void invoke("voice_remove_model", { id: model })
                .then(refresh)
                .catch((e) => setError(errorMessage(e)));
            }}
          >
            Remove selected model
          </button>
          <label>
            Language
            <select
              disabled={busy || recording}
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              {[
                ["auto", "Detect language"],
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
      ) : (
        <>
          <p>{apple.reason}</p>
          <label>
            Apple speech language
            <select
              value={appleLanguage}
              disabled={busy || recording}
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
              ? "Language assets are installed."
              : "Download language assets before recording."}
          </p>
          <button
            disabled={busy || recording || !appleLanguage}
            onClick={() => void appleAsset(false)}
          >
            Download Apple speech language
          </button>
          <button
            disabled={
              busy ||
              recording ||
              !apple.reservedLanguages.includes(appleLanguage)
            }
            onClick={() => void appleAsset(true)}
          >
            Release Apple speech language
          </button>
        </>
      )}
      <div className="tool-bar">
        <button
          disabled={
            busy ||
            (engine === "whisper"
              ? !model
              : !apple.available ||
                !apple.installedLanguages.includes(appleLanguage))
          }
          onClick={() => (recording ? recorder.current?.stop() : void start())}
        >
          {recording ? "Stop and transcribe" : "Record speech"}
        </button>
        {(busy || recording) && <button onClick={cancel}>Cancel</button>}
      </div>
      {progress && <p role="status">{progress}</p>}
      <label>
        Dictation draft
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
              .catch((e) => setError(errorMessage(e)));
          }}
        >
          Copy draft
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
            Stage in terminal composer
          </button>
        )}
      </div>
      {history.length > 0 && (
        <details>
          <summary>Session dictation history ({history.length})</summary>
          <button onClick={() => setHistory([])}>Clear history</button>
          {history.map((text, index) => (
            <button key={index} onClick={() => setDraft(text)}>
              {text.slice(0, 100)}
            </button>
          ))}
        </details>
      )}
    </section>
  );
}
