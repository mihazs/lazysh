// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyAppTheme } from "./appearance";

describe("whole-app appearance", () => {
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
