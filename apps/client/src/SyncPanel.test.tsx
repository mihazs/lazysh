// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import SyncPanel, { parseSyncPreview } from "./SyncPanel";
import {defaults, getPreferences, savePreferences} from "./preferences";
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
    { ...preview, recoveryPending: "yes" },
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
  expect(screen.queryByRole("button", {name: "Keep local settings and acknowledge remote"})).toBeNull();
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
    await screen.findByText("Imported 1 host and 0 credential entries."),
  ).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("sync_apply", { token: "review-one" }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(changed).toHaveBeenCalledOnce();
});


it('warns before a remote snapshot without navigation shortcuts restores defaults, and cancel preserves local settings', async () => {
  const custom = {agents:'C-S-B',workspaces:null};
  savePreferences({...defaults,navigationShortcuts:custom});
  const remotePreferences = {version:1};
  vi.mocked(invoke).mockImplementation(async command => command === 'sync_status'
    ? {configured:true,endpoint:'https://dav.example/',username:'dev',settingsEnabled:true,credentialsEnabled:false}
    : command === 'sync_preview' ? {...preview,preferences:remotePreferences}
    : {hostsAdded:0,credentialsAdded:0,preferences:remotePreferences});
  render(<SyncPanel onHostsChanged={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Preview remote settings'}));
  expect(await screen.findByText(/If the remote copy has no shortcuts/)).toBeTruthy();
  expect(getPreferences().navigationShortcuts).toEqual(custom);
  fireEvent.click(screen.getByRole('button',{name:'Cancel import'}));
  expect(getPreferences().navigationShortcuts).toEqual(custom);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'sync_apply')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Preview remote settings'}));
  fireEvent.click(await screen.findByRole('button',{name:'Apply reviewed changes'}));
  expect(await screen.findByText('Imported 0 hosts and 0 credential entries.')).toBeTruthy();
  expect(getPreferences().navigationShortcuts).toEqual(defaults.navigationShortcuts);
});


it('keeps local shortcuts when acknowledging a partial upload and retries with those shortcuts', async () => {
  const custom = {agents:'C-S-B',workspaces:null};
  savePreferences({...defaults,navigationShortcuts:custom});
  const remote = {version:1,theme:'remote-theme',navigationShortcuts:{agents:'C-S-Z',workspaces:null},snippets:[{label:'remote',text:'preserve me'}]};
  let uploads = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'sync_status') return {configured:true,endpoint:'https://dav.example/',username:'dev',settingsEnabled:true,credentialsEnabled:false};
    if (command === 'sync_preview') return {...preview,recoveryPending:true,preferences:remote};
    if (command === 'sync_push' && ++uploads === 1) throw new Error('Partial upload');
    return {};
  });
  render(<SyncPanel onHostsChanged={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Upload settings'}));
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Preview remote settings'}));
  expect(await screen.findByText(/If the remote copy has no shortcuts/)).toBeTruthy();
  expect(screen.getByText('Remote settings as stored (missing fields use defaults)')).toBeTruthy();
  expect(screen.getByText('Remote settings as stored (missing fields use defaults)').nextElementSibling?.textContent).toBe(JSON.stringify(remote, null, 2));
  expect(getPreferences().navigationShortcuts).toEqual(custom);
  fireEvent.click(screen.getByRole('button',{name:'Keep local settings and acknowledge remote'}));
  expect(await screen.findByText(/Remote copy acknowledged/)).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith('sync_acknowledge',{token:'review-one'}, {headers:{'X-Lazysh-Access':expect.any(String)}});
  expect(getPreferences().navigationShortcuts).toEqual(custom);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'sync_apply')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Upload settings'}));
  expect(await screen.findByText('Encrypted settings uploaded.')).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith('sync_push',{scope:'settings',preferences:expect.objectContaining({navigationShortcuts:custom})},{headers:{'X-Lazysh-Access':expect.any(String)}});
});

it('does not acknowledge recovery without remote settings to review', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'sync_status'
    ? {configured:true,endpoint:'https://dav.example/',username:'dev',settingsEnabled:true,credentialsEnabled:false}
    : {...preview,recoveryPending:true});
  render(<SyncPanel onHostsChanged={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Preview remote settings'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Remote settings are unavailable');
  expect(screen.getByRole('button',{name:'Keep local settings and acknowledge remote'})).toHaveProperty('disabled', true);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'sync_acknowledge')).toBe(false);
});
