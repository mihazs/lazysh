import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFontBudget, FONT_LIMIT, fontFamilyFor, getDeviceFonts, importedFontOf, isImportedFamily, validateFont } from "./fonts";
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
  describe("imported fonts for the native renderer", () => {
    const id = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
    const bytes = new ArrayBuffer(12); new DataView(bytes).setUint32(0, 0x4f54544f);
    /** A font store whose `get` answers from `records`, as IndexedDB does. */
    function store(records: Record<string, unknown>) {
      const close = vi.fn();
      const later = (request: {result?: unknown; onsuccess?: () => void}, result: unknown) => { queueMicrotask(() => { request.result = result; request.onsuccess?.(); }); return request; };
      const db = {transaction: () => ({objectStore: () => ({get: (key: string) => later({}, records[key])})}), close};
      vi.stubGlobal("indexedDB", {open: () => later({}, db)});
      return close;
    }
    afterEach(() => vi.unstubAllGlobals());

    it("tells the family of an imported font from any other name", () => {
      for (const name of [`lazysh-font-${id}-primary`, `lazysh-font-${id}-cjk`]) expect(isImportedFamily(name)).toBe(true);
      for (const name of ["monospace", "Menlo", `lazysh-font-${id}-bold`, `lazysh-font-${id}`, `xlazysh-font-${id}-cjk`, "lazysh-font-not-an-id-cjk"]) expect(isImportedFamily(name)).toBe(false);
    });

    it("reads the font a family name stands for, with its role, and closes the store", async () => {
      const close = store({[id]: {id, name: "Mono.otf", size: bytes.byteLength, bytes}});
      expect(await importedFontOf(`lazysh-font-${id}-cjk`)).toEqual({role: "cjk", bytes});
      expect(close).toHaveBeenCalledOnce();
    });

    it("answers nothing for a font that is gone, a name that is not an imported font's, and refuses a record that is not a font", async () => {
      const close = store({});
      expect(await importedFontOf(`lazysh-font-${id}-primary`)).toBeUndefined();
      const untouched = vi.fn();
      vi.stubGlobal("indexedDB", {open: untouched});
      expect(await importedFontOf("monospace")).toBeUndefined();
      expect(untouched).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      store({[id]: {id, name: "x", size: 12, bytes: new ArrayBuffer(12)}});
      await expect(importedFontOf(`lazysh-font-${id}-primary`)).rejects.toThrow();
    });
  });
});
