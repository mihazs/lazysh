import {fireEvent,render,within} from "@testing-library/react";
import PreferencesPanel from "../PreferencesPanel";

/**
 * Queries scoped to the settings page that is showing. Every page stays mounted (the search reads
 * them), and jsdom resolves a label or role by walking the document, so a `screen` query costs
 * seconds on a loaded runner; one page is a few dozen elements.
 */
export function showingPage() {
  return within(document.querySelector<HTMLElement>('[data-settings-page]:not([hidden])')!);
}
/** The root list of settings rows. */
export const settingsIndex=()=>within(document.querySelector<HTMLElement>('.settings-index')!);
/** Opens the rows in order (the first from the root list, each next from the page showing) and returns that page. */
export function openSettingsPages(...titles:string[]) {
  titles.forEach((title,depth)=>fireEvent.click((depth?showingPage():settingsIndex()).getByRole('button',{name:title})));
  return showingPage();
}
/** The detail header's Back button. */
export const goBack=(name='Back')=>fireEvent.click(within(document.querySelector<HTMLElement>('.settings-detail-header')!).getByRole('button',{name}));
/** Renders Preferences, opens the pages in order and returns queries scoped to the last one. */
export function mountPreferences(...titles:string[]) {
  render(<PreferencesPanel/>);
  return openSettingsPages(...titles);
}
