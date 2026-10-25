import { describe, expect, it } from "vitest";
import { assertFontBudget, FONT_LIMIT, fontFamilyFor, getDeviceFonts, validateFont } from "./fonts";
import { defaults, parsePreferences } from "./preferences";

describe("local terminal fonts", () => {
  it("bounds total decoded font bytes independently of count", () => {
    expect(() => assertFontBudget([FONT_LIMIT, FONT_LIMIT])).not.toThrow();
    expect(() => assertFontBudget([FONT_LIMIT, FONT_LIMIT, 12])).toThrow();
    expect(() => assertFontBudget([12, 12, 12, 12, 12])).toThrow();
    expect(() => assertFontBudget([Infinity])).toThrow();
  });
  it("rejects arbitrary data and oversized files before the browser font parser", () => {
    for (const bytes of [new ArrayBuffer(0), new TextEncoder().encode('<svg>external image</svg>').buffer, new ArrayBuffer(FONT_LIMIT + 1)]) expect(() => validateFont(bytes)).toThrow();
    for (const signature of [0x00010000, 0x4f54544f, 0x774f4646, 0x774f4632, 0x74746366]) {
      const bytes = new ArrayBuffer(12); new DataView(bytes).setUint32(0, signature);
      expect(() => validateFont(bytes)).not.toThrow();
    }
  });
  it("includes device fonts and CJK fallback without placing device font IDs in synced preferences", () => {
    const device = {...getDeviceFonts(), primaryFamily: '"local-primary"', cjkFamily: '"local-cjk"'};
    expect(fontFamilyFor(defaults, device)).toBe(`"local-primary", "local-cjk", ${defaults.fontFamily}, ${defaults.cjkFallback}`);
    const preferences = parsePreferences({...defaults, importedFontId: "device-only", cjkFallback: "'Local CJK', monospace", appTheme: "paper"});
    expect(preferences.cjkFallback).toBe("'Local CJK', monospace");
    expect(preferences.appTheme).toBe("paper");
    expect(preferences).not.toHaveProperty("importedFontId");
    expect(parsePreferences({...defaults, appTheme: "remote-url", cjkFallback: "bad;url(evil)"})).toMatchObject({appTheme: "forest", cjkFallback: defaults.cjkFallback});
  });
});
