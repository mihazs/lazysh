// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, screen} from '@testing-library/react';
import {mountPreferences} from './test/preferencesPanel';
import {budgetStyleLookups} from './test/styleBudget';
import {defaults, getPreferences, parsePreferences, savePreferences} from './preferences';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
budgetStyleLookups(200);
const collection = (count:number)=>({
  chords:Array.from({length:count},(_,i)=>({label:`Chord ${i}`,keys:`text: value ${i} `})),
  snippets:Array.from({length:count},(_,i)=>({label:`Snippet ${i}`,text:` 你好 ${i} `})),
});

describe('non-tiered shortcut collections',()=>{
  it('preserves every valid entry beyond twelve during parsing, saving and a fresh module reload',async()=>{
    const entries=collection(100);
    const value={...defaults,...entries};
    expect(parsePreferences(value)).toMatchObject(entries);
    savePreferences(value);
    expect(JSON.parse(localStorage.getItem('lazysh.preferences.v1')!)).toMatchObject(entries);
    vi.resetModules();
    const reloaded=await import('./preferences');
    expect(reloaded.getPreferences()).toMatchObject(entries);
  });
  it.each(['chords','snippets'] as const)('adds and retains a thirteenth %s entry through the real Preferences controls',kind=>{
    savePreferences({...defaults,...collection(12)});
    const chord=kind==='chords';
    const page=mountPreferences('Keyboard and gestures',chord?'Keyboard chords':'Text snippets');
    const name=page.getByLabelText(chord?'Chord name':'Snippet name');
    const input=page.getByLabelText(chord?'Key sequence':'Snippet text');
    fireEvent.change(name,{target:{value:'Thirteenth'}});
    fireEvent.change(input,{target:{value:chord?'text: literal tail ':' literal tail '}});
    fireEvent.click(page.getByRole('button',{name:chord?'Add chord':'Add snippet'}));
    expect(getPreferences()[kind]).toHaveLength(13);
    expect(getPreferences()[kind][12]).toEqual(chord?{label:'Thirteenth',keys:'text: literal tail '}:{label:'Thirteenth',text:' literal tail '});
    expect(page.getByRole('button',{name:`Remove ${chord?'chord':'snippet'} Thirteenth`})).toBeTruthy();
  });
  it('keeps the saved collection and snippet draft when device storage refuses a write',()=>{
    savePreferences({...defaults,...collection(12)});
    const page=mountPreferences('Keyboard and gestures','Text snippets');
    fireEvent.change(page.getByLabelText('Snippet name'),{target:{value:'Unsaved'}});
    fireEvent.change(page.getByLabelText('Snippet text'),{target:{value:' retained draft '}});
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
    fireEvent.click(page.getByRole('button',{name:'Add snippet'}));
    expect(getPreferences().snippets).toEqual(collection(12).snippets);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect((page.getByLabelText('Snippet name') as HTMLInputElement).value).toBe('Unsaved');
    expect((page.getByLabelText('Snippet text') as HTMLTextAreaElement).value).toBe(' retained draft ');
  });
});
