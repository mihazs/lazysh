// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyAppTheme } from "./appearance";

describe("whole-app appearance", () => {
  it("sets custom tokens and removes every override when returning to a bundled theme", () => {
    applyAppTheme("custom", {v:1,name:"Custom",mode:"light",colors:{background:"#ffffff",foreground:"#111111"}});
    expect(document.documentElement.style.getPropertyValue("--theme-bg")).toBe("#ffffff");
    expect(document.documentElement.style.colorScheme).toBe("light");
    applyAppTheme("forest");
    expect(document.documentElement.style.getPropertyValue("--theme-bg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--theme-on-accent")).toBe("");
  });
  it("applies light and dark color schemes and resets the default theme", () => {
    applyAppTheme("paper");
    expect(document.documentElement.dataset.appTheme).toBe("paper");
    expect(document.documentElement.style.colorScheme).toBe("light");
    applyAppTheme("midnight");
    expect(document.documentElement.dataset.appTheme).toBe("midnight");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    applyAppTheme("forest");
    expect(document.documentElement.dataset.appTheme).toBe("forest");
  });
});
