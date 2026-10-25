// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PreferencesPanel from "./PreferencesPanel";
import { defaults, getPreferences, savePreferences } from "./preferences";
afterEach(() => cleanup());

describe("terminal settings", () => {
  it("persists theme and reordered toolbar, rejects invalid theme import, and resets", () => {
    savePreferences({...defaults});
    render(<PreferencesPanel />);
    fireEvent.change(screen.getByLabelText("Theme"), {target: {value: "paper"}});
    expect(getPreferences().theme).toBe("paper");
    fireEvent.click(screen.getByRole("button", {name: "Move ctrl earlier"}));
    expect(getPreferences().toolbar.slice(0, 2)).toEqual(["ctrl", "esc"]);
    fireEvent.change(screen.getByLabelText("Theme JSON"), {target: {value: '{"background":"url(https://bad)","foreground":"#ffffff"}'}});
    fireEvent.click(screen.getByRole("button", {name: "Import theme"}));
    expect(screen.getByRole("alert").textContent).toContain("Invalid theme color");
    expect(getPreferences().customTheme).toBeUndefined();
    fireEvent.click(screen.getByRole("button", {name: "Reset preferences"}));
    expect(getPreferences()).toEqual(defaults);
  });
});
