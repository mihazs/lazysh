// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import DevicePanel, { framePoint, parseFrame } from "./DevicePanel";
import { t } from "./i18n/core";
vi.mock("@tauri-apps/api/core", async original => (await import("./test/nativeCoreMock")).mockNativeCore(original));
afterEach(cleanupNativeMocks);

import {androidVideoInputProbe,androidVideoProbe,deviceFrame as frame} from './test/deviceData';
it("bounds frame content and maps displayed coordinates to original device pixels", () => {
  expect(parseFrame(frame)).toEqual(frame);
  for (const value of [
    null,
    { ...frame, mime: "image/svg+xml" },
    { ...frame, base64: "https://external" },
    { ...frame, width: 32768, height: 32768 },
    { ...frame, imageWidth: -1 },
  ])
    expect(() => parseFrame(value)).toThrow();
  expect(framePoint(135, 240, 270, 480, frame)).toEqual({ x: 540, y: 960 });
  expect(framePoint(-10, 999, 270, 480, frame)).toEqual({ x: 0, y: 1919 });
});
it("does not discover, capture or send device input without explicit actions", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_devices"
      ? {
          schemaVersion: 1,
          devices: [
            {
              id: frame.id,
              name: "Test emulator",
              state: "device",
              kind: "emulator",
              capabilities: { screenshot: true, tap: true, key: true },
            },
          ],
          avds: [],
          warnings: [],
        }
      : frame,
  );
  render(<DevicePanel sessionId="ssh1" />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
  await screen.findByRole("option", { name: "Test emulator · device" });
  fireEvent.change(screen.getByLabelText("Device"), {
    target: { value: frame.id },
  });
  expect(screen.getByRole("button", { name: "home" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Capture screen" }));
  expect(await screen.findByAltText("Screen of Test emulator")).toHaveProperty(
    "src",
    `data:image/jpeg;base64,${frame.base64}`,
  );
  expect(
    vi.mocked(invoke).mock.calls.some(([name]) => name === "device_action"),
  ).toBe(false);
});
it("shows host SDK availability errors without fabricating devices", async () => {
  vi.mocked(invoke).mockResolvedValue({
    schemaVersion: 1,
    devices: [],
    avds: [],
    warnings: ["Android SDK is not installed on this host."],
  });
  render(<DevicePanel sessionId="ssh1" />);
  fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
  expect(
    await screen.findByText("Android SDK is not installed on this host."),
  ).toBeTruthy();
});
it("requires explicit socket verification and input enablement before iOS controls", async () => {
  const id = "9C405382-203A-4DC0-A11B-B2FC37EBA881";
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_devices")
      return {
        schemaVersion: 1,
        devices: [
          {
            id,
            name: "iPhone",
            state: "Booted",
            kind: "simulator",
            capabilities: { screenshot: true, tap: false, key: false },
          },
        ],
        avds: [],
      };
    if (command === "ios_device_probe")
      return { schemaVersion: 1, id, platform: "ios", width: 390, height: 844 };
    return { schemaVersion: 1, status: "requested" };
  });
  render(<DevicePanel sessionId="ssh-ios" />);
  fireEvent.change(screen.getByLabelText("Platform"), {
    target: { value: "ios" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
  await screen.findByRole("option", { name: "iPhone · Booted" });
  fireEvent.change(screen.getByLabelText("Device"), { target: { value: id } });
  expect(
    screen.getByRole("button", { name: "Start video preview" }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Enable device input")).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.change(screen.getByLabelText("idb companion socket"), {
    target: { value: "/private/idb.sock" },
  });
  expect(
    vi.mocked(invoke).mock.calls.some(([name]) => name === "ios_device_probe"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Verify iOS companion" }));
  const home = await screen.findByRole("button", { name: "home" });
  expect(home).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByLabelText("Enable device input"));
  fireEvent.click(home);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("ios_device_action", {
      sessionId: "ssh-ios",
      id,
      socket: "/private/idb.sock",
      width: 390,
      height: 844,
      action: { type: "key", key: "home" },
    }, { headers: { "X-Lazysh-Access": expect.any(String) } }),
  );
});
const android = {
  id: frame.id,
  name: "Android",
  state: "device",
  kind: "emulator",
  capabilities: { screenshot: true, tap: true, swipe: true, key: true },
};
function mockAndroid(probe: object, packets: unknown[] = []) {
  let pulls = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_devices")
      return { schemaVersion: 1, devices: [android], avds: [] };
    if (command === "android_device_probe") return probe;
    if (command === "device_stream_start") return "video";
    if (command === "device_stream_next")
      return pulls < packets.length ? packets[pulls++] : new Promise(() => {});
    if (command === "device_frame") return frame;
    return undefined;
  });
}
async function selectAndroid() {
  render(<DevicePanel sessionId="ssh-video" />);
  fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
  await screen.findByRole("option", { name: "Android · device" });
  fireEvent.change(screen.getByLabelText("Device"), {
    target: { value: frame.id },
  });
}
const startButton = () =>
  screen.getByRole("button", { name: "Start video preview" });
async function verifyAndroid() {
  fireEvent.click(
    screen.getByRole("button", { name: "Verify Android video tools" }),
  );
  await vi.waitFor(() => expect(startButton()).toHaveProperty("disabled", false));
}
it("keeps Android video view-only until a fresh screenshot follows stop", async () => {
  mockAndroid(androidVideoProbe);
  await selectAndroid();
  expect(startButton()).toHaveProperty("disabled", true);
  await verifyAndroid();
  fireEvent.click(screen.getByRole("button", { name: "Start video preview" }));
  expect(screen.getByLabelText("Enable device input")).toHaveProperty(
    "disabled",
    true,
  );
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("device_stream_start", {
      sessionId: "ssh-video",
      id: frame.id,
      socket: "",
      devicePlatform: "android",
    }, { headers: { "X-Lazysh-Access": expect.any(String) } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop video preview" }));
  expect(screen.getByLabelText("Enable device input")).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Capture screen" }));
  await vi.waitFor(() =>
    expect(screen.getByLabelText("Enable device input")).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(
    vi.mocked(invoke).mock.calls.some(([name]) => name === "device_action"),
  ).toBe(false);
  expect(invoke).toHaveBeenCalledWith("device_stream_stop", {
    sessionId: "ssh-video",
    streamId: "video",
  }, { headers: { "X-Lazysh-Access": expect.any(String) } });
});

it("maps a touch on the Android video to the verified display and stops the video once the host refuses it", async () => {
  const video = { ...frame, width: 720, height: 1280, imageWidth: 720, imageHeight: 1280 };
  let rotated = false;
  mockAndroid(androidVideoInputProbe, [{ sequence: 1, frame: video }]);
  await selectAndroid();
  await verifyAndroid();
  fireEvent.click(startButton());
  const action = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "android_device_action") return action(command, args);
    if (rotated) throw new Error("DeviceDimensionsChanged");
    return { status: "requested" };
  });
  const image = await screen.findByRole("img");
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperties(image, {
    getBoundingClientRect: { value: () => ({ left: 10, top: 20, width: 360, height: 640 }) },
    setPointerCapture: { value: vi.fn() },
  });
  const input = screen.getByLabelText("Enable device input");
  expect(input).toHaveProperty("disabled", false);
  fireEvent.click(input);
  const touch = (from: [number, number], to = from) => {
    fireEvent.pointerDown(image, { clientX: from[0], clientY: from[1] });
    fireEvent.pointerUp(image, { clientX: to[0], clientY: to[1] });
  };
  try {
    touch([190, 340]); // the middle of the displayed video, in the 1080x1920 display's pixels
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("android_device_action", {
        sessionId: "ssh-video",
        id: frame.id,
        width: 1080,
        height: 1920,
        action: { type: "tap", x: 540, y: 960 },
      }, expect.anything()),
    );
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "home" })).toHaveProperty("disabled", false));
    touch([10, 20], [370, 20]);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("android_device_action", expect.objectContaining({
        action: expect.objectContaining({ type: "swipe", x: 0, y: 0, to_x: 1079, to_y: 0 }),
      }), expect.anything()),
    );
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "home" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "home" }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("device_action", expect.objectContaining({ action: { type: "key", key: "home" } }), expect.anything()),
    );
    rotated = true;
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "home" })).toHaveProperty("disabled", false));
    touch([190, 340]);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "DeviceDimensionsChanged");
    expect(screen.getByRole("button", { name: "Start video preview" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Enable device input")).toHaveProperty("disabled", true);
    expect(invoke).toHaveBeenCalledWith("device_stream_stop", { sessionId: "ssh-video", streamId: "video" }, expect.anything());
  } finally {
    vi.unstubAllGlobals();
  }
});
it("keeps video input off for a companion that reports a view-only probe", async () => {
  mockAndroid(androidVideoProbe);
  await selectAndroid();
  await verifyAndroid();
  fireEvent.click(startButton());
  expect(screen.getByLabelText("Enable device input")).toHaveProperty("disabled", true);
});
it("refuses an Android probe whose input claim has no display size", async () => {
  mockAndroid({ ...androidVideoInputProbe, displayWidth: 0 });
  await selectAndroid();
  fireEvent.click(screen.getByRole("button", { name: "Verify Android video tools" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(startButton()).toHaveProperty("disabled", true);
});
it("says the SDK is on this device for a local session and on the SSH host for a remote one", () => {
  const { unmount } = render(<DevicePanel sessionId="local:12345678-1234-4234-8234-123456789abc" />);
  expect(screen.getByText(t("devicesHintLocal"))).toBeTruthy();
  expect(screen.queryByText(t("devicesHint"))).toBeNull();
  unmount();
  render(<DevicePanel sessionId="ssh1" />);
  expect(screen.getByText(t("devicesHint"))).toBeTruthy();
  expect(screen.queryByText(t("devicesHintLocal"))).toBeNull();
});
