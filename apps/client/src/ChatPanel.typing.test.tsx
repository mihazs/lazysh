// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import ChatPanel from "./ChatPanel";
import { t } from "./i18n/core";

vi.mock("@tauri-apps/api/core", async original => (await import("./test/nativeCoreMock")).mockNativeCore(original));
afterEach(cleanupNativeMocks);

// #2735: Android delivers a path as native key events faster than React's scheduler runs between them. Each keystroke must still
// commit without an update left pending, or React 19 throws "Maximum update depth exceeded" at the 51st one and the character is lost.
it("keeps every character of a long path typed in one burst", async () => {
  const view = render(<ChatPanel sessionId="ssh1" />);
  const input = view.getByPlaceholderText(t("chatPathHint")) as HTMLInputElement;
  const path = `/tmp/lazysh-android-ssh-AbCdEf/recorded-conversations/${"cards/".repeat(20)}recorded.jsonl`;
  const uncaught: string[] = [];
  const record = (event: ErrorEvent) => { uncaught.push(event.message); event.preventDefault(); };
  window.addEventListener("error", record);
  const act = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  // Outside act() React uses its own scheduler, as in the app, and never runs it inside this synchronous loop.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  try {
    const assign = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    input.focus();
    for (const character of path) {
      assign.call(input, input.value + character);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = act;
    window.removeEventListener("error", record);
  }
  expect(uncaught).toEqual([]);
  expect(input.value).toBe(path);
});
