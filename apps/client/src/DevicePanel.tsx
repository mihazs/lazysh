import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "./SessionTools";
type Device = {
  id: string;
  name: string;
  state: string;
  kind: string;
  capabilities: Record<string, boolean>;
};
type Frame = {
  schemaVersion: number;
  platform: string;
  id: string;
  mime: string;
  base64: string;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
};
export function parseFrame(value: unknown): Frame {
  const frame = value as Frame;
  if (
    !frame ||
    frame.schemaVersion !== 1 ||
    !["android", "ios"].includes(frame.platform) ||
    typeof frame.id !== "string" ||
    frame.id.length > 256 ||
    frame.mime !== "image/jpeg" ||
    typeof frame.base64 !== "string" ||
    !frame.base64.startsWith("/9j/") ||
    frame.base64.length > 720000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.base64)
  )
    throw new Error("Invalid device frame.");
  for (const number of [
    frame.width,
    frame.height,
    frame.imageWidth,
    frame.imageHeight,
  ])
    if (!Number.isInteger(number) || number < 1 || number > 32768)
      throw new Error("Invalid device dimensions.");
  if (
    frame.width * frame.height > 40000000 ||
    frame.imageWidth * frame.imageHeight > 4000000
  )
    throw new Error("Device image exceeds limits.");
  return frame;
}
export function framePoint(
  x: number,
  y: number,
  width: number,
  height: number,
  frame: Pick<Frame, "width" | "height">,
) {
  return {
    x: Math.max(
      0,
      Math.min(frame.width - 1, Math.floor((x / width) * frame.width)),
    ),
    y: Math.max(
      0,
      Math.min(frame.height - 1, Math.floor((y / height) * frame.height)),
    ),
  };
}
export default function DevicePanel({ sessionId }: { sessionId: string }) {
  const [platform, setPlatform] = useState("android");
  const [devices, setDevices] = useState<Device[]>([]);
  const [avds, setAvds] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [frame, setFrame] = useState<Frame>();
  const [live, setLive] = useState(false);
  const [input, setInput] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const current = useRef(0);
  const running = useRef(false);
  const device = devices.find((item) => item.id === selected);
  useEffect(() => {
    current.current++;
    setDevices([]);
    setAvds([]);
    setSelected("");
    setFrame(undefined);
    setLive(false);
    setInput(false);
    setWarnings([]);
    return () => {
      current.current++;
    };
  }, [sessionId, platform]);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setLive(false);
      setInput(false);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function list() {
    const generation = current.current;
    const result = await invoke<{
      schemaVersion: number;
      devices: Device[];
      avds: { id: string; name: string }[];
      warnings?: string[];
    }>("list_devices", { sessionId, devicePlatform: platform });
    if (
      result?.schemaVersion !== 1 ||
      !Array.isArray(result.devices) ||
      result.devices.length > 256 ||
      !Array.isArray(result.avds) ||
      result.avds.length > 256 ||
      (result.warnings !== undefined &&
        (!Array.isArray(result.warnings) ||
          result.warnings.length > 32 ||
          result.warnings.some(
            (warning) => typeof warning !== "string" || warning.length > 4096,
          )))
    )
      throw new Error("Invalid device list.");
    for (const item of [...result.devices, ...result.avds])
      if (
        !item ||
        typeof item.id !== "string" ||
        item.id.length > 256 ||
        typeof item.name !== "string" ||
        item.name.length > 1024
      )
        throw new Error("Invalid device identity.");
    for (const item of result.devices)
      if (
        typeof item.state !== "string" ||
        item.state.length > 256 ||
        typeof item.kind !== "string" ||
        item.kind.length > 256 ||
        !item.capabilities ||
        typeof item.capabilities !== "object" ||
        Object.values(item.capabilities).some(
          (value) => typeof value !== "boolean",
        )
      )
        throw new Error("Invalid device capabilities.");
    if (generation === current.current) {
      setDevices(result.devices);
      setAvds(result.avds);
      setWarnings(result.warnings || []);
    }
  }
  async function capture() {
    if (!selected || start.current) return;
    const generation = current.current;
    const result = parseFrame(
      await invoke("device_frame", {
        sessionId,
        devicePlatform: platform,
        id: selected,
      }),
    );
    if (result.id !== selected || result.platform !== platform)
      throw new Error("Device frame identity changed.");
    if (generation === current.current) setFrame(result);
  }
  async function action(action: unknown, id = selected) {
    await invoke("device_action", {
      sessionId,
      devicePlatform: platform,
      id,
      action,
    });
  }
  useEffect(() => {
    if (!live || !selected) return;
    const timer = setInterval(() => {
      if (!document.hidden) void run(capture);
    }, 1000);
    return () => clearInterval(timer);
  }, [live, selected, platform, sessionId]);
  const start = useRef<
    { x: number; y: number; time: number; id: string } | undefined
  >(undefined);
  return (
    <section className="tool-panel" aria-label="Host devices">
      <h3>Simulators and devices</h3>
      <p>
        Uses the SDK installed on this SSH host. Live view captures one frame
        per second; input is sent only when enabled.
      </p>
      <div className="tool-bar">
        <label>
          Platform
          <select
            disabled={busy}
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            <option value="android">Android</option>
            <option value="ios">iOS Simulator</option>
          </select>
        </label>
        <button disabled={busy} onClick={() => void run(list)}>
          Find devices
        </button>
        <label>
          Device
          <select
            disabled={busy}
            value={selected}
            onChange={(event) => {
              current.current++;
              setSelected(event.target.value);
              setFrame(undefined);
              setLive(false);
              setInput(false);
            }}
          >
            <option value="">Select a device</option>
            {devices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.state}
              </option>
            ))}
          </select>
        </label>
      </div>
      {warnings.map((warning, index) => (
        <p role="status" key={index}>
          {warning}
        </p>
      ))}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {device && (
        <div className="tool-bar">
          <button
            disabled={busy || !device.capabilities.screenshot}
            onClick={() => void run(capture)}
          >
            Capture screen
          </button>
          <button
            disabled={!device.capabilities.screenshot}
            onClick={() => {
              setLive(!live);
              if (!live) void run(capture);
            }}
          >
            {live ? "Stop live view" : "Start live view"}
          </button>
          <label>
            <input
              type="checkbox"
              disabled={!device.capabilities.tap}
              checked={input}
              onChange={(event) => setInput(event.target.checked)}
            />
            Enable device input
          </label>
          {device.capabilities.key &&
            ["back", "home", "enter"].map((key) => (
              <button
                key={key}
                disabled={busy || !input}
                onClick={() => void run(() => action({ type: "key", key }))}
              >
                {key}
              </button>
            ))}
          {(["boot", "reboot", "shutdown"] as const).map(
            (type) =>
              device.capabilities[type] && (
                <button
                  key={type}
                  disabled={busy}
                  onClick={() => {
                    if (type === "boot" || confirm(`${type} ${device.name}?`))
                      void run(() => action({ type }));
                  }}
                >
                  {type}
                </button>
              ),
          )}
        </div>
      )}
      {frame && (
        <img
          className="device-frame"
          alt={`Screen of ${device?.name || frame.id}`}
          src={`data:image/jpeg;base64,${frame.base64}`}
          draggable={false}
          style={{
            maxWidth: "100%",
            maxHeight: "65vh",
            width: "auto",
            touchAction: input ? "none" : "auto",
          }}
          onPointerDown={(event) => {
            if (!input || busy) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const point = framePoint(
              event.clientX - rect.left,
              event.clientY - rect.top,
              rect.width,
              rect.height,
              frame,
            );
            start.current = { ...point, time: Date.now(), id: selected };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            const began = start.current;
            start.current = undefined;
            if (!began || began.id !== selected || !input || busy) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const end = framePoint(
              event.clientX - rect.left,
              event.clientY - rect.top,
              rect.width,
              rect.height,
              frame,
            );
            const swipe = Math.hypot(end.x - began.x, end.y - began.y) > 10;
            if (swipe && !device?.capabilities.swipe) return;
            void run(() =>
              action(
                swipe
                  ? {
                      type: "swipe",
                      x: began.x,
                      y: began.y,
                      to_x: end.x,
                      to_y: end.y,
                      duration_ms: Math.max(
                        50,
                        Math.min(3000, Date.now() - began.time),
                      ),
                    }
                  : { type: "tap", x: end.x, y: end.y },
              ),
            );
          }}
          onPointerCancel={() => {
            start.current = undefined;
          }}
        />
      )}
      {avds.length > 0 && (
        <div>
          <h4>Available virtual devices</h4>
          {avds.map((avd) => (
            <button
              key={avd.id}
              disabled={busy}
              onClick={() => void run(() => action({ type: "boot" }, avd.id))}
            >
              Boot {avd.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
