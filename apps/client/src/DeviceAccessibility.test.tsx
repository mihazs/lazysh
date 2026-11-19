// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import DeviceAccessibility, { parseTree } from "./DeviceAccessibility";
import DevicePanel from "./DevicePanel";
import { deviceFrame, deviceRecord, iosDeviceRecord } from "./test/deviceData";
vi.mock("@tauri-apps/api/core", async (original) => (await import("./test/nativeCoreMock")).mockNativeCore(original));
afterEach(cleanupNativeMocks);

const node = (text: string, occurrence = 0, extra = {}) => ({
  depth: 1, class: "android.widget.Button", package: "app", resourceId: "", text, contentDescription: "",
  bounds: [0, 0, 10, 10], occurrence, clickable: true, longClickable: false, scrollable: false,
  checkable: false, checked: false, enabled: true, focusable: true, ...extra,
});
const tree = (nodes: unknown[], extra = {}) => ({
  schemaVersion: 1, platform: "android", id: deviceFrame.id, rotation: 0, truncated: false, nodes, ...extra,
});
const withAccess = { headers: { "X-Lazysh-Access": expect.any(String) } };

it("lists the host's accessibility nodes and acts only on an explicit press, naming the node by its identity", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "android_ui_tree"
      ? tree([node("Twin"), node("Twin", 1), node("Off", 0, { enabled: false })])
      : { status: "requested" },
  );
  const { rerender } = render(<DeviceAccessibility sessionId="ssh" id={deviceFrame.id} inputEnabled={false} />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect screen elements" }));
  const items = await screen.findAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(invoke).toHaveBeenCalledWith("android_ui_tree", { sessionId: "ssh", id: deviceFrame.id }, withAccess);
  // Without the explicit input opt-in, and for a disabled node, nothing can be pressed.
  expect(screen.getAllByRole("button", { name: "Tap" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  rerender(<DeviceAccessibility sessionId="ssh" id={deviceFrame.id} inputEnabled />);
  const taps = screen.getAllByRole("button", { name: "Tap" }) as HTMLButtonElement[];
  expect(taps.map((button) => button.disabled)).toEqual([false, false, true]);
  fireEvent.click(taps[1]);
  expect(await screen.findByText("Tapped Twin.")).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith("android_ui_action", {
    sessionId: "ssh", id: deviceFrame.id, node: { resourceId: "", text: "Twin", contentDescription: "", occurrence: 1 }, kind: "click",
  }, withAccess);
  fireEvent.click(screen.getAllByRole("button", { name: "Long press" })[0]);
  expect(await screen.findByText("Long-pressed Twin.")).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.at(-1)?.[1]).toMatchObject({ node: { occurrence: 0 }, kind: "long-click" });
});

it("shows the host's failure and refuses a tree that is not the bounded answer for this device", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("AccessibilityTreeTooLarge"));
  render(<DeviceAccessibility sessionId="ssh" id={deviceFrame.id} inputEnabled />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect screen elements" }));
  expect((await screen.findByRole("alert")).textContent).toBe("AccessibilityTreeTooLarge");
  for (const value of [
    tree([], { id: "other-device" }),
    tree([node("a", -1)]),
    tree([node("a", 0, { enabled: "yes" })]),
    tree([node("x".repeat(1025))]),
    tree(Array.from({ length: 301 }, () => node("a"))),
    tree([], { truncated: undefined }),
    null,
  ])
    expect(() => parseTree(value, deviceFrame.id)).toThrow();
  expect(parseTree(tree([node("a")], { truncated: true }), deviceFrame.id).truncated).toBe(true);
});

it("offers the screen inspection for a running Android device only", async () => {
  const inventory = (record: object) => ({ schemaVersion: 1, devices: [record], avds: [] });
  for (const [platform, record, expected] of [["android", deviceRecord, true], ["ios", iosDeviceRecord, false]] as const) {
    vi.mocked(invoke).mockImplementation(async () => inventory(record));
    const { unmount } = render(<DevicePanel sessionId={`ssh-${platform}`} />);
    fireEvent.change(screen.getByLabelText("Platform"), { target: { value: platform } });
    fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
    await screen.findByRole("option", { name: new RegExp(record.name.replace(/[{}]/g, ".")) });
    fireEvent.change(screen.getByLabelText("Device"), { target: { value: record.id } });
    expect(screen.queryByRole("button", { name: "Inspect screen elements" }) !== null).toBe(expected);
    unmount();
  }
});
