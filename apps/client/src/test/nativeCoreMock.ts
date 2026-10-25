import { vi } from "vitest";
import { cleanup } from "@testing-library/react";
export async function mockNativeCore(original: () => Promise<typeof import("@tauri-apps/api/core")>) {
  return { ...await original(), invoke: vi.fn() };
}
export function cleanupNativeMocks() { cleanup(); vi.clearAllMocks(); }
