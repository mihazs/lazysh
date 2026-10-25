import { useId, useState } from 'react';
import { parseChord } from './preferences';
import { compileSimpleChord } from './simpleChord';

export default function ChordBuilder({ label, binding = '', onSave, disabled = false, clearAfterSave = false }: {
  label?: string;
  binding?: string;
  onSave: (binding: string) => boolean;
  disabled?: boolean;
  clearAfterSave?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState<'advanced' | 'simple'>('advanced');
  const [keys, setKeys] = useState(binding);
  const [text, setText] = useState('');
  const [modifiers, setModifiers] = useState({ctrl:false, meta:false, shift:false});
  const [error, setError] = useState('');
  const name = (field: string) => label ? `${label} ${field.toLowerCase()}` : field;
  function save() {
    try {
      const compiled = mode === 'simple' ? compileSimpleChord(text, modifiers) : keys.startsWith('text:') ? keys : keys.trim();
      parseChord(compiled);
      if (onSave(compiled)) {
        setError(''); setKeys(clearAfterSave ? '' : compiled);
        if (clearAfterSave) setText('');
      }
    } catch (error) { setError(String(error)); }
  }
  return <div>
    <label htmlFor={`${id}-builder`}>{name('Shortcut builder')}</label><select id={`${id}-builder`} value={mode} onChange={event => {setMode(event.target.value as 'advanced' | 'simple'); setError('');}}><option value="advanced">Advanced binding</option><option value="simple">Simple custom text</option></select>
    {mode === 'advanced' ? <><label htmlFor={`${id}-keys`}>{label ? `${label} chord` : 'Key sequence'}</label><input id={`${id}-keys`} maxLength={128} value={keys} placeholder="C-b, T" onChange={event => setKeys(event.target.value)} /></> : <>
      <p>Without modifiers, send text exactly, including Unicode, commas and spaces. Up to 123 characters; some characters count twice. With modifiers, use printable ASCII: b1 modifies only b; a,b modifies both; ,, inserts a comma. Up to 8 key steps. Unsupported shortcuts show an error.</p>
      <p>This field is literal custom text: Enter means the letters Enter. Use Advanced for named or function keys.</p>
      {(['ctrl','meta','shift'] as const).map(modifier => <label key={modifier}><input type="checkbox" checked={modifiers[modifier]} onChange={event => setModifiers({...modifiers,[modifier]:event.target.checked})} />{label ? `${label} ` : ''}{modifier === 'ctrl' ? 'Control' : modifier === 'meta' ? 'Option / Alt' : 'Shift'}</label>)}
      <label htmlFor={`${id}-text`}>{name('Custom shortcut text')}</label><textarea id={`${id}-text`} rows={2} value={text} onChange={event => setText(event.target.value)} />
    </>}
    {error && <p role="alert">{error}</p>}
    <button disabled={disabled || !(mode === 'simple' ? text : keys.trim())} onClick={save}>{label ? `Save ${label} chord` : 'Add chord'}</button>
  </div>;
}
