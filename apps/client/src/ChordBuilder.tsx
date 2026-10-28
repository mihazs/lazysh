import {t, useUi} from './i18n/core';
import {LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
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
  const [mode, setMode] = useState<'advanced' | 'simple' | 'named'>('advanced');
  const [keys, setKeys] = useState(binding);
  const [text, setText] = useState('');
  const [modifiers, setModifiers] = useState({ctrl:false, meta:false, shift:false});
  const [namedKey, setNamedKey] = useState('Enter');
  const [namedModifiers, setNamedModifiers] = useState({ctrl:false, meta:false, shift:false});
  const activeModifiers = mode === 'named' ? namedModifiers : modifiers;
  const [error, setError] = useState<UiErrorCause>('');
  const name = (field: 'builder' | 'text') => label ? t(field === 'builder' ? 'shortcutBuilderForLabel' : 'shortcutTextForLabel', {label}) : t(field === 'builder' ? 'shortcutShortcutBuilder' : 'shortcutCustomShortcutText');
  function save() {
    try {
      const compiled = mode === 'simple' ? compileSimpleChord(text, modifiers) : mode === 'named' ? `${namedModifiers.ctrl ? 'C-' : ''}${namedModifiers.meta ? 'M-' : ''}${namedModifiers.shift ? 'S-' : ''}${namedKey}` : keys.startsWith('text:') ? keys : keys.trim();
      parseChord(compiled);
      if (onSave(compiled)) {
        setError(''); setKeys(clearAfterSave ? '' : compiled);
        if (clearAfterSave) setText('');
      }
    } catch (error) { setError(error instanceof LocalUiError?error:String(error)); }
  }
  return <div>
    <label htmlFor={`${id}-builder`}>{name('builder')}</label><select id={`${id}-builder`} value={mode} onChange={event => {setMode(event.target.value as 'advanced' | 'simple' | 'named'); setError('');}}><option value="advanced">{t("shortcutAdvancedBinding")}</option><option value="simple">{t("shortcutSimpleCustomText")}</option><option value="named">{t("shortcutNamedOrFunctionKey")}</option></select>
    {mode === 'advanced' ? <><label htmlFor={`${id}-keys`}>{label ? t("shortcutValue1Chord", {value1: label}) : t("shortcutKeySequence")}</label><input id={`${id}-keys`} maxLength={128} value={keys} placeholder="C-b, T" onChange={event => setKeys(event.target.value)} /></> : <>
      {mode === 'simple' && <><p>{t("shortcutWithoutModifiersSendTextExactlyIncludingUnicodeCommasAnd")}</p>
      <p>{t("shortcutThisFieldIsLiteralCustomTextEnterMeansThe")}</p></>}
      {(['ctrl','meta','shift'] as const).map(modifier => {
        const modifierName = t(({ctrl:'shortcutControl',meta:'shortcutOptionAlt',shift:'shortcutShift'} as const)[modifier]);
        return <label key={modifier}><input type="checkbox" checked={activeModifiers[modifier]} onChange={event => (mode === 'named' ? setNamedModifiers : setModifiers)({...activeModifiers,[modifier]:event.target.checked})} />{label ? t('shortcutModifierForLabel', {label, modifier:modifierName}) : modifierName}</label>;
      })}
      {mode === 'named' ? <><label htmlFor={`${id}-named`}>{label ? t('shortcutNamedKeyForLabel', {label}) : t('shortcutNamedKey')}</label><select id={`${id}-named`} value={namedKey} onChange={event => setNamedKey(event.target.value)}>{['Enter','Tab','Escape','Backspace','Space','Up','Down','Left','Right','Home','End','Insert','Delete','PageUp','PageDown',...Array.from({length:12},(_,i) => `F${i+1}`)].map(key => <option key={key} value={key}>{key}</option>)}</select></> : <><label htmlFor={`${id}-text`}>{name('text')}</label><textarea id={`${id}-text`} rows={2} value={text} onChange={event => setText(event.target.value)} /></>}
    </>}
    {error && <p role="alert">{uiErrorText(error)}</p>}
    <button disabled={disabled || !(mode === 'simple' ? text : mode === 'named' ? namedKey : keys.trim())} onClick={save}>{label ? t("shortcutSaveValue1Chord", {value1: label}) : t("shortcutAddChord")}</button>
  </div>;
}
