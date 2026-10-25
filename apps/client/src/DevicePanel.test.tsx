// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import DevicePanel, { framePoint, parseFrame } from "./DevicePanel";
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const frame = {
  schemaVersion: 1,
  platform: "android",
  id: "emulator-5554",
  mime: "image/jpeg",
  base64: "/9j/2Q==",
  width: 1080,
  height: 1920,
  imageWidth: 540,
  imageHeight: 960,
};
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
    }),
  );
});
it("keeps Android video view-only until a fresh screenshot follows stop", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_devices")
      return {
        schemaVersion: 1,
        devices: [
          {
            id: frame.id,
            name: "Android",
            state: "device",
            kind: "emulator",
            capabilities: { screenshot: true, tap: true, key: true },
          },
        ],
        avds: [],
      };
    if (command === "android_device_probe")
      return {
        schemaVersion: 1,
        id: frame.id,
        platform: "android",
        stream: true,
        viewOnly: true,
        maximumSeconds: 180,
      };
    if (command === "device_stream_start") return "video";
    if (command === "device_stream_next") return new Promise(() => {});
    if (command === "device_frame") return frame;
    return undefined;
  });
  render(<DevicePanel sessionId="ssh-video" />);
  fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
  await screen.findByRole("option", { name: "Android · device" });
  fireEvent.change(screen.getByLabelText("Device"), {
    target: { value: frame.id },
  });
  expect(
    screen.getByRole("button", { name: "Start video preview" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(
    screen.getByRole("button", { name: "Verify Android video tools" }),
  );
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Start video preview" }),
    ).toHaveProperty("disabled", false),
  );
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
    }),
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
  });
});
