// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Host } from "./bridge";

const mocks = vi.hoisted(() => ({
  api: {
    listHosts: vi.fn(),
    saveHost: vi.fn(),
    deleteHost: vi.fn(),
    trustHostKey: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    ackOutput: vi.fn(),
    muxSessions: vi.fn(),
    attachTmux: vi.fn(),
  },
  terminal: { write: vi.fn(), dispose: vi.fn() },
}));
vi.mock("./bridge", () => ({ native: true, api: mocks.api }));
vi.mock("./terminal", () => ({ createTerminal: () => mocks.terminal }));
vi.mock("./TerminalPane", () => ({
  default: ({ active }: { active: boolean }) =>
    active ? <div>Live SSH terminal</div> : null,
}));
vi.mock("./AgentPanel", () => ({ default: () => <div>Agent companion</div> }));
import App, { validateHost } from "./App";

const host: Host = {
  id: "home",
  name: "Home",
  hostname: "home.local",
  port: 22,
  username: "dev",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", {
    setItem: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    length: 0,
  });
  vi.stubGlobal("sessionStorage", {
    setItem: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    length: 0,
  });
  mocks.api.listHosts.mockResolvedValue([host]);
  mocks.api.disconnect.mockResolvedValue(undefined);
  mocks.api.trustHostKey.mockResolvedValue(undefined);
  mocks.api.ackOutput.mockResolvedValue(undefined);
  mocks.terminal.write.mockImplementation(
    (_data: Uint8Array, callback?: () => void) => callback?.(),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("host validation", () => {
  it("accepts direct IPv4, IPv6, and tailnet destinations and rejects ambiguous SSH strings", () => {
    for (const hostname of [
      "100.70.0.2",
      "2001:db8::1",
      "machine.tailnet.ts.net",
    ])
      expect(validateHost({ ...host, hostname })).toBe("");
    for (const hostname of [
      "dev@host",
      "host/path",
      "host name",
      "host\noption",
    ])
      expect(validateHost({ ...host, hostname })).not.toBe("");
    for (const port of [0, 65536, 22.5, NaN])
      expect(validateHost({ ...host, port })).not.toBe("");
  });
});

describe("connection flow", () => {
  async function openConnection() {
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Connect to Home" }),
    );
    await user.type(screen.getByLabelText("Password"), "temporary-secret");
    return user;
  }

  it("requires explicit host-key acceptance before retrying and keeps credentials out of storage", async () => {
    mocks.api.connect
      .mockRejectedValueOnce({
        kind: "unknown_host_key",
        message: "Verify key",
        fingerprint: "SHA256:known-key",
      })
      .mockResolvedValueOnce({ sessionId: "one" });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("SHA256:known-key")).toBeTruthy();
    expect(mocks.api.connect).toHaveBeenCalledTimes(1);
    expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Trust key and connect" }),
    );
    expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
    expect(mocks.api.trustHostKey).toHaveBeenCalledWith(
      "home",
      "SHA256:known-key",
    );
    expect(mocks.api.connect).toHaveBeenLastCalledWith(
      "home",
      { password: "temporary-secret" },
      expect.any(Function),
    );
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("blocks a changed key without offering a trust shortcut", async () => {
    mocks.api.connect.mockRejectedValue({
      kind: "host_key_changed",
      message: "Changed",
      fingerprint: "SHA256:attacker",
    });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Connection blocked",
    );
    expect(
      screen.queryByRole("button", { name: "Trust key and connect" }),
    ).toBeNull();
    expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
  });

  it("does not create duplicate sessions while authentication is pending", async () => {
    let resolve: (value: { sessionId: string }) => void = () => {};
    mocks.api.connect.mockImplementation(
      () =>
        new Promise((value) => {
          resolve = value;
        }),
    );
    const user = await openConnection();
    await user.dblClick(screen.getByRole("button", { name: "Connect" }));
    expect(mocks.api.connect).toHaveBeenCalledTimes(1);
    resolve({ sessionId: "one" });
    await screen.findByText("Live SSH terminal");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("forwards split multibyte output intact and acknowledges consumed bytes after the session is established", async () => {
    mocks.api.connect.mockImplementation(
      async (
        _host: string,
        _credentials: unknown,
        onEvent: (event: unknown) => void,
      ) => {
        const bytes = new TextEncoder().encode("你好");
        onEvent({ type: "data", data: Array.from(bytes.slice(0, 2)) });
        onEvent({ type: "data", data: Array.from(bytes.slice(2)) });
        expect(mocks.api.ackOutput).not.toHaveBeenCalled();
        return { sessionId: "one" };
      },
    );
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    const forwarded = new Uint8Array(
      mocks.terminal.write.mock.calls.flatMap((call) =>
        Array.from(call[0] as Uint8Array),
      ),
    );
    expect(new TextDecoder().decode(forwarded)).toBe("你好");
    expect(mocks.api.ackOutput).toHaveBeenCalledWith("one", 6);
  });

  it("attaches tmux in a separate terminal without injecting input or replacing the original tab", async () => {
    mocks.api.connect.mockResolvedValue({ sessionId: "one" });
    mocks.api.muxSessions.mockResolvedValue([
      { id: "$1", name: "work", windows: 2, attached: false },
    ]);
    mocks.api.attachTmux.mockResolvedValue({ sessionId: "two" });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    await user.click(await screen.findByRole("button", { name: "Attach" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(mocks.api.attachTmux).toHaveBeenCalledWith(
      "one",
      "work",
      expect.any(Function),
    );
    expect(mocks.api.write).not.toHaveBeenCalled();
    expect(mocks.api.disconnect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /^Home$/ }));
    expect(screen.getByText("Live SSH terminal")).toBeTruthy();
  });

  it("only returns output credit after the terminal has consumed a chunk", async () => {
    let consumed: (() => void) | undefined;
    mocks.terminal.write.mockImplementation(
      (_data: Uint8Array, callback?: () => void) => {
        consumed = callback;
      },
    );
    mocks.api.connect.mockImplementation(
      async (
        _host: string,
        _credentials: unknown,
        onEvent: (event: unknown) => void,
      ) => {
        onEvent({ type: "data", data: [97, 98, 99] });
        return { sessionId: "one" };
      },
    );
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    expect(mocks.api.ackOutput).not.toHaveBeenCalled();
    consumed?.();
    expect(mocks.api.ackOutput).toHaveBeenCalledWith("one", 3);
  });
});

it("saves only host metadata through the native API", async () => {
  mocks.api.listHosts.mockResolvedValue([]);
  mocks.api.saveHost.mockResolvedValue(host);
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Add your first host" }));
  await user.type(screen.getByLabelText("Name"), "Home");
  await user.type(screen.getByLabelText("Hostname or IP"), "home.local");
  await user.type(screen.getByLabelText("Username"), "dev");
  await user.click(screen.getByRole("button", { name: "Save host" }));
  await waitFor(() =>
    expect(mocks.api.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Home",
        hostname: "home.local",
        username: "dev",
        port: 22,
      }),
    ),
  );
  expect(Object.keys(mocks.api.saveHost.mock.calls[0][0]).sort()).toEqual([
    "hostname",
    "id",
    "name",
    "port",
    "username",
  ]);
});

it("focuses host search when opened with the command palette shortcut", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Connect to Home" });
  await user.keyboard("{Control>}k{/Control}");
  const search = await screen.findByRole("textbox", {
    name: "Search saved hosts",
  });
  expect(document.activeElement).toBe(search);
  await user.keyboard("missing-host");
  expect(
    await screen.findByText(
      "No matching hosts. Add one to start a connection.",
    ),
  ).toBeTruthy();
});
