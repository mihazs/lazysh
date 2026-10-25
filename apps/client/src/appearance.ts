import { useEffect } from "react";
import { initializeFonts } from "./fonts";
import { usePreferences, type Preferences } from "./preferences";

export function applyAppTheme(theme: Preferences["appTheme"]) {
  const root = document.documentElement;
  root.dataset.themeChanging = "true";
  root.dataset.appTheme = theme;
  root.style.colorScheme = theme === "paper" ? "light" : "dark";
  // Commit both foreground and background together before restoring hover transitions.
  void root.offsetWidth;
  delete root.dataset.themeChanging;
}
export function useClientAppearance() {
  const preferences = usePreferences();
  useEffect(() => applyAppTheme(preferences.appTheme), [preferences.appTheme]);
  useEffect(initializeFonts, []);
}
