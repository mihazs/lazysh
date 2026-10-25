// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useDeviceStream } from "./useDeviceStream";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("closes a stream whose startup finishes after its panel is removed", async () => {
  let begin!: (token: string) => void;
  vi.mocked(invoke).mockImplementation((name) =>
    name === "device_stream_start"
      ? new Promise((resolve) => {
          begin = resolve as typeof begin;
        })
      : (Promise.resolve(undefined) as never),
  );
  const frame = vi.fn(),
    error = vi.fn();
  const hook = renderHook(() =>
    useDeviceStream(true, "ssh", "id", "/private/idb.sock", frame, error),
  );
  hook.unmount();
  await act(async () => begin("late"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("device_stream_stop", {
      sessionId: "ssh",
      streamId: "late",
    }, { headers: { "X-Lazysh-Access": expect.any(String) } }),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "device_stream_next"),
  ).toHaveLength(0);
  expect(frame).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
it("holds one pull and rejects a repeated sequence then stops the source", async () => {
  let next!: (packet: unknown) => void;
  vi.mocked(invoke).mockImplementation((name) => {
    if (name === "device_stream_start")
      return Promise.resolve("stream") as never;
    if (name === "device_stream_next")
      return new Promise((resolve) => {
        next = resolve;
      }) as never;
    return Promise.resolve(undefined) as never;
  });
  const frame = vi.fn(),
    error = vi.fn();
  renderHook(() =>
    useDeviceStream(true, "ssh", "id", "/private/idb.sock", frame, error),
  );
  await waitFor(() => expect(next).toBeTypeOf("function"));
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "device_stream_next"),
  ).toHaveLength(1);
  await act(async () => next({ sequence: 1, frame: { test: true } }));
  expect(frame).toHaveBeenCalledOnce();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "device_stream_next"),
  ).toHaveLength(2);
  await act(async () => next({ sequence: 1, frame: { test: true } }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("device_stream_stop", {
      sessionId: "ssh",
      streamId: "stream",
    }, { headers: { "X-Lazysh-Access": expect.any(String) } }),
  );
  expect(error).toHaveBeenCalledOnce();
  expect(frame).toHaveBeenCalledOnce();
});
it("preserves the Android image on idle and cancels its pending poll on removal", async () => {
  let next!: (packet: unknown) => void;
  vi.mocked(invoke).mockImplementation((name) => {
    if (name === "device_stream_start")
      return Promise.resolve("android") as never;
    if (name === "device_stream_next")
      return new Promise((resolve) => {
        next = resolve;
      }) as never;
    return Promise.resolve(undefined) as never;
  });
  const frame = vi.fn(),
    error = vi.fn();
  const hook = renderHook(() =>
    useDeviceStream(true, "ssh", "device", "", frame, error, "android"),
  );
  await waitFor(() => expect(next).toBeTypeOf("function"));
  await act(async () =>
    next({ sequence: 1, frame: { original: true }, idle: false }),
  );
  await act(async () =>
    next({ sequence: 1, frame: null, error: null, idle: true }),
  );
  expect(frame).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "device_stream_next"),
  ).toHaveLength(3);
  hook.unmount();
  expect(invoke).toHaveBeenCalledWith("device_stream_stop", {
    sessionId: "ssh",
    streamId: "android",
  }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  await act(async () =>
    next({ sequence: 2, frame: { late: true }, idle: false }),
  );
  expect(frame).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
});
