// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {goBack,mountPreferences,openSettingsPages,settingsIndex,showingPage} from "./test/preferencesPanel";
import {budgetStyleLookups} from "./test/styleBudget";
import PreferencesPanel from "./PreferencesPanel";
import {usageProviders} from "./usageAgentProvider";
import {uiI18n} from "./i18n/core";
import { defaults, getPreferences, savePreferences, toolbarRows } from "./preferences";
afterEach(() => cleanup());
budgetStyleLookups(500);

describe("settings pages", () => {
  it.each([['en','AI account usage','Follow the current agent','Always show a chosen account','Hide the usage item'],
    ['pt-BR','Uso da conta de IA','Seguir o agente atual','Sempre mostrar uma conta escolhida','Ocultar o item de uso'],
    ['es','Uso de la cuenta de IA','Seguir el agente actual','Mostrar siempre una cuenta elegida','Ocultar el elemento de uso']])('chooses the status bar usage item in %s: follows the agent by default, pins an account or hides',async(language,page,follow,fixed,hidden)=>{
    await act(async()=>{await uiI18n.changeLanguage(language);});
    try {
      savePreferences({...defaults});const usage=mountPreferences(page);
      const radio=(name:string)=>usage.getByRole('radio',{name}) as HTMLInputElement;
      expect(radio(follow).checked).toBe(true);expect(getPreferences().usageItem).toBeUndefined();
      fireEvent.click(radio(fixed));expect(getPreferences().usageItem).toBe('fixed');
      const picker=usage.getByRole('combobox') as HTMLSelectElement;
      expect(picker.disabled).toBe(false);expect(picker.options.length).toBe(32);
      fireEvent.change(picker,{target:{value:'openai'}});expect(getPreferences().usageProvider).toBe('openai');
      fireEvent.click(radio(hidden));expect(getPreferences().usageItem).toBe('hidden');expect(picker.disabled).toBe(true);
      fireEvent.click(radio(follow));expect(getPreferences().usageItem).toBeUndefined();expect(getPreferences().usageProvider).toBe('openai');
      fireEvent.change(picker,{target:{value:''}});expect(getPreferences().usageProvider).toBeUndefined();
    } finally {cleanup();await act(async()=>{await uiI18n.changeLanguage('en');});}
  });
  it('lists the accounts the host reported and keeps a stored custom provider selectable',()=>{
    savePreferences({...defaults,usageItem:'fixed',usageProvider:'custom:acme'});
    render(<PreferencesPanel usageAccounts={[{id:'anthropic@work',name:'Claude · work'},{id:'openai',name:'Codex'}]}/>);
    const picker=openSettingsPages('AI account usage').getByRole('combobox') as HTMLSelectElement;
    expect(picker.value).toBe('custom:acme');
    expect([...picker.options].map(option=>option.value)).toEqual(['',...usageProviders.map(([id])=>id),'anthropic@work','custom:acme']);
    });
  it("persists theme and reordered toolbar, rejects invalid theme import, and resets", () => {
    savePreferences({...defaults});
    const appearance=mountPreferences('Appearance and fonts');
    expect(appearance.getByLabelText<HTMLSelectElement>("Session switcher layout").value).toBe("list");
    fireEvent.change(appearance.getByLabelText("Session switcher layout"), {target: {value: "cards"}});
    expect(getPreferences().sessionLayout).toBe("cards");
    fireEvent.change(appearance.getByLabelText("Terminal theme"), {target: {value: "paper"}});
    expect(getPreferences().theme).toBe("paper");
    goBack();
    const toolbar=openSettingsPages("Keyboard and gestures","Toolbar keys and order");
    fireEvent.click(toolbar.getByRole("button", {name: "ctrl"}));
    fireEvent.click(toolbar.getByRole("button", {name: "Move ctrl earlier"}));
    expect(toolbarRows(getPreferences().toolbar)[1].slice(0, 2)).toEqual(["ctrl", "shift"]);
    goBack();
    goBack();
    const theme=openSettingsPages("Appearance and fonts");
    fireEvent.click(theme.getByText("Import and share theme",{exact:true}));
    fireEvent.change(theme.getByLabelText("Theme JSON or share code"), {target: {value: '{"background":"url(https://bad)","foreground":"#ffffff"}'}});
    fireEvent.click(theme.getByRole("button", {name: "Preview theme"}));
    expect(theme.getByText(/Invalid theme color/).getAttribute('role')).toBe('status');
    expect(getPreferences().customTheme).toBeUndefined();
    goBack();
    const reset=openSettingsPages("Reset settings");
    fireEvent.click(reset.getByRole("button", {name: "Reset preferences"}));
    expect(getPreferences()).toEqual(defaults);
  });
});

it('navigates category pages and preserves an unsaved snippet and restored list focus',()=>{
  savePreferences({...defaults});
  const {container}=render(<PreferencesPanel/>);
  expect(container.querySelectorAll('[data-settings-page]:not([hidden])')).toHaveLength(0);
  const input=settingsIndex().getByRole('button',{name:'Keyboard and gestures'});fireEvent.click(input);
  fireEvent.click(showingPage().getByRole('button',{name:'Text snippets'}));
  const snippets=showingPage();
  const name=snippets.getByLabelText('Snippet name'),text=snippets.getByLabelText('Snippet text');
  fireEvent.change(name,{target:{value:'Unsent draft'}});fireEvent.change(text,{target:{value:' exact draft '}});
  goBack();
  expect(showingPage().getByRole('button',{name:'Text snippets'})).toBe(document.activeElement);
  goBack();
  expect(input).toBe(document.activeElement);
  fireEvent.click(settingsIndex().getByRole('button',{name:'Appearance and fonts'}));
  expect(showingPage().getByRole('spinbutton',{name:'Font size'})).toBeTruthy();
  goBack();
  fireEvent.click(input);fireEvent.click(showingPage().getByRole('button',{name:'Text snippets'}));
  expect(showingPage().getByLabelText('Snippet text')).toBe(text);
  expect(name).toHaveProperty('value','Unsent draft');expect(text).toHaveProperty('value',' exact draft ');
  expect(getPreferences().snippets).toEqual(defaults.snippets);
});
