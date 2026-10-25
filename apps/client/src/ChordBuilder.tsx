import {t, useUi} from './i18n/core';
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
  useUi();
  const id = useId();
  const [mode, setMode] = useState<'advanced' | 'simple'>('advanced');
  const [keys, setKeys] = useState(binding);
  const [text, setText] = useState('');
  const [modifiers, setModifiers] = useState({ctrl:false, meta:false, shift:false});
  const [error, setError] = useState('');
  const name = (field: 'builder' | 'text') => label ? t(field === 'builder' ? 'shortcutBuilderForLabel' : 'shortcutTextForLabel', {label}) : t(field === 'builder' ? 'shortcutShortcutBuilder' : 'shortcutCustomShortcutText');
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
    <label htmlFor={`${id}-builder`}>{name('builder')}</label><select id={`${id}-builder`} value={mode} onChange={event => {setMode(event.target.value as 'advanced' | 'simple'); setError('');}}><option value="advanced">{t("shortcutAdvancedBinding")}</option><option value="simple">{t("shortcutSimpleCustomText")}</option></select>
    {mode === 'advanced' ? <><label htmlFor={`${id}-keys`}>{label ? t("shortcutValue1Chord", {value1: label}) : t("shortcutKeySequence")}</label><input id={`${id}-keys`} maxLength={128} value={keys} placeholder="C-b, T" onChange={event => setKeys(event.target.value)} /></> : <>
      <p>{t("shortcutWithoutModifiersSendTextExactlyIncludingUnicodeCommasAnd")}</p>
      <p>{t("shortcutThisFieldIsLiteralCustomTextEnterMeansThe")}</p>
      {(['ctrl','meta','shift'] as const).map(modifier => {
        const modifierName = t(({ctrl:'shortcutControl',meta:'shortcutOptionAlt',shift:'shortcutShift'} as const)[modifier]);
        return <label key={modifier}><input type="checkbox" checked={modifiers[modifier]} onChange={event => setModifiers({...modifiers,[modifier]:event.target.checked})} />{label ? t('shortcutModifierForLabel', {label, modifier:modifierName}) : modifierName}</label>;
      })}
      <label htmlFor={`${id}-text`}>{name('text')}</label><textarea id={`${id}-text`} rows={2} value={text} onChange={event => setText(event.target.value)} />
    </>}
    {error && <p role="alert">{error}</p>}
    <button disabled={disabled || !(mode === 'simple' ? text : keys.trim())} onClick={save}>{label ? t("shortcutSaveValue1Chord", {value1: label}) : t("shortcutAddChord")}</button>
  </div>;
}
