import {$} from '@wdio/globals';
import Page from '../page';

/** The system document picker in its save mode, in the native layer: where an Android app saves a file the person chose. */
class DocumentPickerComponent extends Page {
  readonly context = 'NATIVE_APP' as const;
  get root() { return $('id=com.android.documentsui:id/container_save'); }
  /** The name the file is offered under; the person may edit it. */
  get fileName() { return $('android=new UiSelector().className("android.widget.EditText").resourceId("android:id/title")'); }
  get save() { return $('id=android:id/button1'); }

  /** Saves where the picker opened (it remembers the last folder), then waits for it to close. */
  async saveHere() {
    await this.in(async () => {
      // `waitForClickable` exists only for web pages; a native element is waited for by its display.
      await this.save.waitForDisplayed({timeout: 30_000, timeoutMsg: 'The document picker did not show Save'});
      await this.save.click();
      await this.root.waitForDisplayed({reverse: true, timeoutMsg: 'The document picker stayed open after Save'});
    });
  }
}
export default new DocumentPickerComponent();
