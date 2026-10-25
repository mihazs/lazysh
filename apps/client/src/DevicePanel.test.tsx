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
