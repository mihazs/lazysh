import {$} from '@wdio/globals';
import Page from '../page';

/** A system dialog over the app in the native layer, such as the "has stopped" and "isn't responding" crash dialogs. */
class SystemDialogComponent extends Page {
  readonly context = 'NATIVE_APP' as const;
  get root() { return $('id=android:id/alertTitle'); }
}
export default new SystemDialogComponent();
