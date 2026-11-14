import { vi } from "vitest";
import { cleanup } from "@testing-library/react";
export async function mockNativeCore(original: () => Promise<typeof import("@tauri-apps/api/core")>) {
  return { ...await original(), invoke: vi.fn() };
}
export function cleanupNativeMocks() { cleanup(); vi.clearAllMocks(); }
/** The native core with a `Channel` that records its handler, for a reader that opens a live watch. */
export async function mockNativeCoreWithChannel(original: () => Promise<typeof import("@tauri-apps/api/core")>) {
  return { ...await mockNativeCore(original), Channel: class { onmessage: ((event: unknown) => void) | undefined; } };
}
