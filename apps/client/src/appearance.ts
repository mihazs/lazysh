import { useEffect } from "react";
import { chromeColors, type ImportedTheme } from "./themeImport";
import { initializeFonts } from "./fonts";
import { usePreferences, type Preferences } from "./preferences";

const customProperties = Object.keys(chromeColors({v:1,name:"keys",mode:"dark",colors:{background:"#000000",foreground:"#ffffff"}}));
export function applyAppTheme(theme: Preferences["appTheme"], imported?: ImportedTheme) {
  const root = document.documentElement;
  root.dataset.themeChanging = "true";
  for (const property of customProperties) root.style.removeProperty(property);
  if (theme === "custom" && imported) for (const [key,value] of Object.entries(chromeColors(imported))) root.style.setProperty(key,value);
  root.dataset.appTheme = theme;
  root.style.colorScheme = theme === "custom" && imported ? imported.mode : theme === "paper" ? "light" : "dark";
  // Commit both foreground and background together before restoring hover transitions.
  void root.offsetWidth;
  delete root.dataset.themeChanging;
}
export function useClientAppearance() {
  const preferences = usePreferences();
  useEffect(() => applyAppTheme(preferences.appTheme, preferences.customTheme && preferences.customThemeInfo ? {v:1,...preferences.customThemeInfo,colors:preferences.customTheme} : undefined), [preferences.appTheme, preferences.customTheme, preferences.customThemeInfo]);
  useEffect(initializeFonts, []);
}
