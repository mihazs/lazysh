// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import SyncPanel, { parseSyncPreview } from "./SyncPanel";
vi.mock("@tauri-apps/api/core", async original => (await import("./test/nativeCoreMock")).mockNativeCore(original));
afterEach(() => { cleanupNativeMocks(); localStorage.clear(); });

const preview = {
  token: "review-one",
  scope: "settings",
  hosts: [
    {
      id: "new",
      name: "New host",
      hostname: "machine",
      port: 22,
      username: "dev",
      fingerprint: "SHA256:review",
      addHost: true,
      importCredentials: false,
    },
  ],
  conflicts: [],
};
it("rejects malformed encrypted-sync preview identities", () => {
  expect(parseSyncPreview(preview)).toEqual(preview);
  for (const value of [
    null,
    { ...preview, scope: "all" },
    { ...preview, hosts: [{ ...preview.hosts[0], port: 0 }] },
    { ...preview, conflicts: [{ id: "x", reason: 5 }] },
  ])
    expect(() => parseSyncPreview(value)).toThrow();
});
it("requires explicit preview and apply, and never automatically uploads", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "sync_status"
      ? {
          configured: true,
          endpoint: "https://dav.example/",
          username: "dev",
          settingsEnabled: true,
          credentialsEnabled: false,
        }
      : command === "sync_preview"
        ? preview
        : { hostsAdded: 1, credentialsAdded: 0 },
  );
  const changed = vi.fn();
  render(<SyncPanel onHostsChanged={changed} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview remote settings" }),
  );
  expect(await screen.findByText("SHA256:review")).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([name]) => name === "sync_apply" || name === "sync_push",
      ),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Apply reviewed changes" }),
  );
  expect(
    await screen.findByText("Imported 1 hosts and 0 credential entries."),
  ).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("sync_apply", { token: "review-one" }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(changed).toHaveBeenCalledOnce();
});
