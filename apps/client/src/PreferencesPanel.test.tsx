// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PreferencesPanel from "./PreferencesPanel";
import { defaults, getPreferences, savePreferences, parseChord } from "./preferences";
afterEach(() => cleanup());

describe("terminal settings", () => {
  it('keeps Advanced default and existing records, while saving Simple text verbatim', () => {
    savePreferences({...defaults,chords:[{label:'Existing',keys:'F12, M-h'}]});
    render(<PreferencesPanel />);
    expect(screen.getByLabelText<HTMLSelectElement>('Shortcut builder').value).toBe('advanced');
    fireEvent.change(screen.getByLabelText('Shortcut builder'),{target:{value:'simple'}});
    fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Literal'}});
    fireEvent.change(screen.getByLabelText('Custom shortcut text'),{target:{value:' 你好,, world '}});
    fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
    expect(getPreferences().chords).toEqual([{label:'Existing',keys:'F12, M-h'},{label:'Literal',keys:'text: 你好,, world '}]);
    fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Prefix'}});
    fireEvent.click(screen.getByLabelText('Control'));
    fireEvent.change(screen.getByLabelText('Custom shortcut text'),{target:{value:'b1'}});
    fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
    expect(parseChord(getPreferences().chords[2].keys)).toBe('\x021');
    fireEvent.change(screen.getByLabelText('Shortcut builder'),{target:{value:'advanced'}});
    fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Advanced literal'}});
    fireEvent.change(screen.getByLabelText('Key sequence'),{target:{value:'text: trailing '}});
    fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
    expect(getPreferences().chords[3].keys).toBe('text: trailing ');
  });
  it('reports Simple validation errors and retains the complete unsaved input', () => {
    savePreferences({...defaults});
    render(<PreferencesPanel />);
    fireEvent.change(screen.getByLabelText('Shortcut builder'),{target:{value:'simple'}});
    fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Unsent'}});
    for (const text of ['a'.repeat(124),'a'.repeat(200),'a\nb']) {
      fireEvent.change(screen.getByLabelText('Custom shortcut text'),{target:{value:text}});
      fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByLabelText<HTMLTextAreaElement>('Custom shortcut text').value).toBe(text);
      expect(getPreferences().chords).toEqual([]);
    }
    fireEvent.click(screen.getByLabelText('Control'));
    for (const text of ['b你好','abcdefghi','a,','1']) {
      fireEvent.change(screen.getByLabelText('Custom shortcut text'),{target:{value:text}});
      fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByLabelText<HTMLTextAreaElement>('Custom shortcut text').value).toBe(text);
      expect(getPreferences().chords).toEqual([]);
    }
  });
  it("persists theme and reordered toolbar, rejects invalid theme import, and resets", () => {
    savePreferences({...defaults});
    render(<PreferencesPanel />);
    expect(screen.getByLabelText<HTMLSelectElement>("Session switcher layout").value).toBe("list");
    fireEvent.change(screen.getByLabelText("Session switcher layout"), {target: {value: "cards"}});
    expect(getPreferences().sessionLayout).toBe("cards");
    fireEvent.change(screen.getByLabelText("Terminal theme"), {target: {value: "paper"}});
    expect(getPreferences().theme).toBe("paper");
    fireEvent.click(screen.getByRole("button", {name: "Move ctrl earlier"}));
    expect(getPreferences().toolbar.slice(0, 2)).toEqual(["ctrl", "esc"]);
    fireEvent.change(screen.getByLabelText("Theme JSON or share code"), {target: {value: '{"background":"url(https://bad)","foreground":"#ffffff"}'}});
    fireEvent.click(screen.getByRole("button", {name: "Preview theme"}));
    expect(screen.getByText(/Invalid theme color/).getAttribute('role')).toBe('status');
    expect(getPreferences().customTheme).toBeUndefined();
    fireEvent.click(screen.getByRole("button", {name: "Reset preferences"}));
    expect(getPreferences()).toEqual(defaults);
  });
});
