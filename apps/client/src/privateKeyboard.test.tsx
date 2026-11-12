// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { isAndroidApp } from "./isAndroidApp";
import PreferencesPanel from "./PreferencesPanel";
import { usePrivateKeyboard } from "./privateKeyboard";
import { defaults, getPreferences, savePreferences } from "./preferences";
import { t, uiI18n } from "./i18n/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
// The packaged Android app is the only place the setting exists; the browser tests below stand in for its WebView.
vi.mock("./isAndroidApp", () => ({ isAndroidApp: vi.fn() }));
const report = (active: boolean) => ["terminal_private_keyboard", { active }, { headers: { "X-Lazysh-Access": "" } }];
const reports = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "terminal_private_keyboard");
beforeEach(() => {
  localStorage.clear(); savePreferences({ ...defaults });
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(isAndroidApp).mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

function mountSetting() {
  render(<PreferencesPanel />);
  fireEvent.click(screen.getByRole("button", { name: t("preferencesCategoryInput") }));
}

describe("the Private keyboard setting", () => {
  it("is offered on Android with its trade-off, persists on this device and is cleared by Reset preferences", async () => {
    mountSetting();
    const toggle = screen.getByRole("checkbox", { name: "Private keyboard in the terminal" });
    expect(toggle).toHaveProperty("checked", false);
    expect(toggle.getAttribute("aria-describedby")).toBe("private-keyboard-help");
    expect(document.getElementById("private-keyboard-help")!.textContent)
      .toMatch(/Predictive text, autocorrect and swipe typing stop working in the terminal while this is on/);
    expect(Object.hasOwn(getPreferences(), "privateKeyboard")).toBe(false);
    fireEvent.click(toggle);
    expect(getPreferences().privateKeyboard).toBe(true);
    expect(JSON.parse(localStorage.getItem("lazysh.preferences.v1")!).privateKeyboard).toBe(true);
    cleanup();
    mountSetting();
    expect(screen.getByRole("checkbox", { name: "Private keyboard in the terminal" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Private keyboard in the terminal" }));
    expect(Object.hasOwn(getPreferences(), "privateKeyboard")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Private keyboard in the terminal" }));
    cleanup();
    render(<PreferencesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Reset settings" }));
    expect(getPreferences().privateKeyboard).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset preferences" }));
    await waitFor(() => expect(getPreferences()).toEqual(defaults));
  });

  it("is found by the settings search", () => {
    render(<PreferencesPanel />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "private keyboard" } });
    expect(screen.getByRole("navigation", { name: t("settingsSearchResults") }).textContent).toContain("Private keyboard in the terminal");
  });

  it("is not offered off Android", () => {
    vi.mocked(isAndroidApp).mockReturnValue(false);
    mountSetting();
    expect(screen.queryByRole("checkbox", { name: "Private keyboard in the terminal" })).toBeNull();
  });

  it.each([["pt-BR", "Teclado privado no terminal", /Texto preditivo, autocorreção e digitação por deslize deixam de funcionar no terminal/], ["es", "Teclado privado en el terminal", /El texto predictivo, la autocorrección y la escritura por deslizamiento dejan de funcionar en el terminal/]])("is translated in %s", async (language, label, trade) => {
    await act(async () => { await uiI18n.changeLanguage(language); });
    try {
      mountSetting();
      expect(screen.getByRole("checkbox", { name: label })).toBeTruthy();
      expect(document.getElementById("private-keyboard-help")!.textContent).toMatch(trade);
    } finally { cleanup(); await act(async () => { await uiI18n.changeLanguage("en"); }); }
  });
});

function Harness() {
  usePrivateKeyboard();
  return <><div className="terminal-canvas"><textarea className="xterm-helper-textarea" aria-label="terminal editor" /></div><textarea aria-label="chat composer" /><input aria-label="other field" /></>;
}
const focus = (name: string) => act(async () => { screen.getByLabelText(name).focus(); await new Promise(resolve => setTimeout(resolve)); });
const blur = () => act(async () => { (document.activeElement as HTMLElement).blur(); await new Promise(resolve => setTimeout(resolve)); });

describe("what the terminal reports to the Android shell", () => {
  it("is active only while the terminal editor has focus, never for the composer or another field", async () => {
    savePreferences({ ...defaults, privateKeyboard: true });
    render(<Harness />);
    await act(async () => {});
    expect(reports().map(call => call[1])).toEqual([{ active: false }]);
    await focus("terminal editor");
    expect(reports().at(-1)).toEqual(report(true));
    await focus("chat composer");
    expect(reports().at(-1)).toEqual(report(false));
    await focus("terminal editor");
    await focus("other field");
    expect(reports().at(-1)).toEqual(report(false));
    await focus("terminal editor");
    await blur();
    expect(reports().map(call => (call[1] as { active: boolean }).active)).toEqual([false, true, false, true, false, true, false]);
    // A focus change that reports nothing new sends nothing.
    await focus("chat composer");
    await focus("other field");
    expect(reports()).toHaveLength(7);
  });

  it("follows the setting while the terminal keeps focus, without a reconnect", async () => {
    render(<Harness />);
    await focus("terminal editor");
    expect(reports().map(call => call[1])).toEqual([{ active: false }]);
    await act(async () => { savePreferences({ ...getPreferences(), privateKeyboard: true }); });
    expect(reports().at(-1)).toEqual(report(true));
    await act(async () => { savePreferences({ ...defaults }); });
    expect(reports().at(-1)).toEqual(report(false));
    expect(reports()).toHaveLength(3);
  });

  it("keeps reports in order even when the shell answers slowly", async () => {
    const answers: (() => void)[] = [];
    vi.mocked(invoke).mockImplementation(() => new Promise<void>(resolve => { answers.push(resolve); }));
    savePreferences({ ...defaults, privateKeyboard: true });
    render(<Harness />);
    await focus("terminal editor");
    await focus("chat composer");
    expect(reports()).toHaveLength(1);
    for (let step = 0; step < 3; step++) { await act(async () => { answers.shift()?.(); }); }
    expect(reports().map(call => (call[1] as { active: boolean }).active)).toEqual([false, true, false]);
  });

  it("sends the state again after a refused report", async () => {
    let refuse = true;
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      if (refuse && (args as { active: boolean }).active) { refuse = false; throw new Error("locked"); }
    });
    savePreferences({ ...defaults, privateKeyboard: true });
    render(<Harness />);
    await focus("terminal editor");
    await focus("chat composer");
    const active = () => reports().map(call => (call[1] as { active: boolean }).active);
    expect(active().at(-1)).toBe(false);
    await focus("terminal editor");
    // The refused activation was not remembered as delivered: the shell was told again and now holds it.
    expect(refuse).toBe(false);
    expect(active().filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(active().at(-1)).toBe(true);
  });

  it("reports nothing off Android", async () => {
    vi.mocked(isAndroidApp).mockReturnValue(false);
    savePreferences({ ...defaults, privateKeyboard: true });
    render(<Harness />);
    await focus("terminal editor");
    expect(reports()).toHaveLength(0);
  });
});
