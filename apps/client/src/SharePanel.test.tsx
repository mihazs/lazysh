import {shareOrigin as origin,shareId as id,sharedFile as share,sharePng as png,shareThumbnail as thumbnail} from './test/shareData';
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));
import SharePanel, { parseShare, thumbnailBlob } from "./SharePanel";
const NativeURL = URL;
const makeObjectUrl = vi.fn();
const revokeObjectUrl = vi.fn();
beforeEach(() => {
  makeObjectUrl.mockReset().mockReturnValue('blob:thumbnail'); revokeObjectUrl.mockReset();
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = makeObjectUrl; static revokeObjectURL = revokeObjectUrl; });
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) =>
    command === "share_status" ? { configured: true, origin } : undefined,
  );
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("rejects download addresses outside the configured capability endpoint", () => {
  expect(parseShare(share, origin)).toEqual(share);
  for (const url of [
    `https://other.test/s/${id}`,
    `${origin}/admin`,
    `${origin}/s/${id}?token=secret`,
    `https://user@files.example.test/s/${id}`,
  ])
    expect(() => parseShare({ ...share, url }, origin)).toThrow();
  expect(() =>
    parseShare({ ...share, size: 11 * 1024 * 1024 }, origin),
  ).toThrow();
});
it("uploads only after an explicit action using ordered bounded chunks", async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "share_status") return { configured: true, origin };
    if (command === "share_upload_begin") return { id: "pending" };
    if (command === "share_upload_finish") return { schemaVersion: 1, share };
  });
  const user = userEvent.setup();
  render(<SharePanel />);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Refresh upload history",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  const bytes = new Uint8Array(300 * 1024);
  const file = new File([bytes], "notes.txt", { type: "text/plain" });
  Object.defineProperty(file, "slice", {
    value: (start: number, end: number) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }),
  });
  await user.upload(screen.getByLabelText("File to share"), file);
  expect(invoke).not.toHaveBeenCalledWith(
    "share_upload_begin",
    expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } }
  );
  await user.click(
    screen.getByRole("button", { name: "Upload and create link" }),
  );
  expect(
    await screen.findByText("Upload complete. Copy its expiring link below."),
  ).toBeTruthy();
  const chunks = invoke.mock.calls.filter(
    ([command]) => command === "share_upload_chunk",
  );
  expect(chunks.map(([, args]) => [args.offset, args.data.length])).toEqual([
    [0, 256 * 1024],
    [256 * 1024, 44 * 1024],
  ]);
  expect(invoke).toHaveBeenCalledWith("share_upload_finish", { id: "pending" }, { headers: { "X-Lazysh-Access": expect.any(String) } });
});
it("cancels a transfer whose begin response arrives after the panel closes", async () => {
  let begin: ((value: { id: string }) => void) | undefined;
  invoke.mockImplementation((command: string) =>
    command === "share_status"
      ? Promise.resolve({ configured: true, origin })
      : command === "share_upload_begin"
        ? new Promise((resolve) => {
            begin = resolve;
          })
        : Promise.resolve(),
  );
  const user = userEvent.setup();
  const view = render(<SharePanel />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("File to share") as HTMLInputElement).closest(
        "fieldset",
      )?.disabled,
    ).toBe(false),
  );
  await user.upload(
    screen.getByLabelText("File to share"),
    new File(["hello"], "notes.txt"),
  );
  await user.click(
    screen.getByRole("button", { name: "Upload and create link" }),
  );
  view.unmount();
  await act(async () => begin?.({ id: "late" }));
  expect(invoke).toHaveBeenCalledWith("share_upload_cancel", { id: "late" }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(invoke).not.toHaveBeenCalledWith(
    "share_upload_chunk",
    expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } }
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "share_upload_finish",
    expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } }
  );
});
it("keeps the management token out of browser storage and clears it after native saving", async () => {
  invoke.mockImplementation(async (command: string) =>
    command === "share_status"
      ? { configured: false, origin: null }
      : command === "share_configure"
        ? { configured: true, origin }
        : undefined,
  );
  const stored = vi.spyOn(Storage.prototype, "setItem");
  const user = userEvent.setup();
  render(<SharePanel />);
  await waitFor(() =>
    expect(
      (
        screen.getByLabelText("Sharing service origin") as HTMLInputElement
      ).closest("fieldset")?.disabled,
    ).toBe(false),
  );
  await user.type(screen.getByLabelText("Sharing service origin"), origin);
  await user.type(screen.getByLabelText("Management token"), "b".repeat(64));
  await user.click(
    screen.getByRole("button", { name: "Save sharing service" }),
  );
  expect(
    await screen.findByText("Sharing service saved on this device."),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText("Management token") as HTMLInputElement).value,
  ).toBe("");
  expect(stored).not.toHaveBeenCalled();
  stored.mockRestore();
});
it("does not offer copy for an expired link", async () => {
  invoke.mockImplementation(async (command: string) =>
    command === "share_status"
      ? { configured: true, origin }
      : command === "share_list"
        ? {
            schemaVersion: 1,
            shares: [{ ...share, createdAt: 1, expiresAt: 2 }],
            nextCursor: null,
          }
        : undefined,
  );
  const user = userEvent.setup();
  render(<SharePanel />);
  const refresh = screen.getByRole("button", {
    name: "Refresh upload history",
  });
  await waitFor(() =>
    expect((refresh as HTMLButtonElement).disabled).toBe(false),
  );
  await user.click(refresh);
  expect(
    (
      (await screen.findByRole("button", {
        name: "Copy link for notes.txt",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it('keeps a delete action when cancellation races an accepted upload',async()=>{
  let finish:((value:unknown)=>void)|undefined;
  invoke.mockImplementation((command:string)=>command==='share_status'?Promise.resolve({configured:true,origin}):command==='share_upload_begin'?Promise.resolve({id:'pending'}):command==='share_upload_finish'?new Promise(resolve=>{finish=resolve;}):Promise.resolve());
  const user=userEvent.setup();render(<SharePanel/>);
  await waitFor(()=>expect((screen.getByLabelText('File to share') as HTMLInputElement).closest('fieldset')?.disabled).toBe(false));
  await user.upload(screen.getByLabelText('File to share'),new File([],'notes.txt'));
  await user.click(screen.getByRole('button',{name:'Upload and create link'}));
  await waitFor(()=>expect(finish).toBeDefined());
  await user.click(screen.getByRole('button',{name:'Cancel upload'}));
  await act(async()=>finish?.({schemaVersion:1,share}));
  expect(await screen.findByText('Upload completed before cancellation. Delete it below to revoke the link.')).toBeTruthy();
  expect((screen.getByRole('button',{name:'Delete notes.txt'}) as HTMLButtonElement).disabled).toBe(false);
});

it('loads a sanitized image thumbnail only on explicit action and revokes its object URL', async () => {
  const item = { ...share, name: 'photo.png', mime: 'image/png', size: png.length };
  invoke.mockImplementation(async (command: string) => command === 'share_status' ? { configured: true, origin } : command === 'share_list' ? { schemaVersion: 1, shares: [item], nextCursor: null } : command === 'share_thumbnail' ? thumbnail : undefined);
  const user = userEvent.setup(); const view = render(<SharePanel />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh upload history' }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Refresh upload history' }));
  const load = await screen.findByRole('button', { name: 'Load thumbnail for photo.png' });
  expect(invoke.mock.calls.filter(([command]) => command === 'share_thumbnail')).toHaveLength(0);
  expect(view.container.querySelector('img')).toBeNull();
  await user.click(load);
  const image = await screen.findByRole('img', { name: 'Thumbnail of photo.png' });
  expect(invoke).toHaveBeenCalledWith('share_thumbnail', { id, requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(image.getAttribute('src')).toBe('blob:thumbnail');
  expect(makeObjectUrl.mock.calls[0][0]).toMatchObject({ type: 'image/png', size: png.length });
  await user.click(screen.getByRole('button', { name: 'Hide thumbnail for photo.png' }));
  expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:thumbnail');
  view.unmount(); expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
});

it('rejects active content, mismatched dimensions and oversized thumbnail payloads before creating an object URL', () => {
  for (const value of [null, { ...thumbnail, mime: 'image/svg+xml' }, { ...thumbnail, data: Array.from(new TextEncoder().encode('<svg onload="bad()"/>')) }, { ...thumbnail, width: 256 }, { ...thumbnail, width: 8193 }, { ...thumbnail, data: [300] }, { ...thumbnail, data: Array(512 * 1024 + 1).fill(0) }]) expect(() => thumbnailBlob(value)).toThrow();
  expect(makeObjectUrl).not.toHaveBeenCalled();
});

it('cancels an in-flight preview when closed and ignores its late response', async () => {
  const item = { ...share, name: 'photo.png', mime: 'image/png', size: png.length };
  let finish: ((value: unknown) => void) | undefined;
  invoke.mockImplementation((command: string) => command === 'share_status' ? Promise.resolve({ configured: true, origin }) : command === 'share_list' ? Promise.resolve({ schemaVersion: 1, shares: [item], nextCursor: null }) : command === 'share_thumbnail' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
  const user = userEvent.setup(); const view = render(<SharePanel />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh upload history' }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Refresh upload history' }));
  await user.click(await screen.findByRole('button', { name: 'Load thumbnail for photo.png' }));
  const requestId = invoke.mock.calls.find(([command]) => command === 'share_thumbnail')![1].requestId;
  view.unmount(); expect(invoke).toHaveBeenCalledWith('share_thumbnail_cancel', { requestId }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  await act(async () => finish?.(thumbnail));
  expect(makeObjectUrl).not.toHaveBeenCalled();
});

it('keeps thumbnails unavailable for expired or large images and exposes no SVG preview', async () => {
  invoke.mockImplementation(async (command: string) => command === 'share_status' ? { configured: true, origin } : command === 'share_list' ? { schemaVersion: 1, shares: [{ ...share, name: 'expired.png', mime: 'image/png', createdAt: 1, expiresAt: 2 }, { ...share, id: 'b'.repeat(64), url: `${origin}/s/${'b'.repeat(64)}`, name: 'large.jpg', mime: 'image/jpeg', size: 3 * 1024 * 1024 }, { ...share, id: 'c'.repeat(64), url: `${origin}/s/${'c'.repeat(64)}`, name: 'active.svg', mime: 'image/svg+xml' }], nextCursor: null } : undefined);
  const user = userEvent.setup(); render(<SharePanel />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh upload history' }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Refresh upload history' }));
  expect(await screen.findByRole('button', { name: 'Load thumbnail for expired.png' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Load thumbnail for large.jpg' })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Load thumbnail for active.svg' })).toBeNull();
});
