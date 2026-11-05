import ChordBuilder from "./ChordBuilder";
import {t} from "./i18n/core";
import {gestureLabelKeys, type GestureAction} from "./preferences";

/** One gesture or long-press binding: its action, and the chord a custom action sends. */
export default function GestureBindingField({label, action, keys, allowed, onAction, onKeys}: {
  label: string;
  action: GestureAction;
  keys?: string;
  allowed: readonly GestureAction[];
  onAction: (action: GestureAction) => void;
  onKeys: (keys: string) => boolean;
}) {
  return <div><label>{label}<select value={action} onChange={event => onAction(event.target.value as GestureAction)}>{allowed.map(item => <option key={item} value={item}>{t(gestureLabelKeys[item])}</option>)}</select></label>
    {action === "custom" && <ChordBuilder key={keys ?? ''} label={label} binding={keys} onSave={onKeys} />}
  </div>;
}
