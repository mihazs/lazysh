import {$, browser} from '@wdio/globals';
import Page from '../page';
import {adbFor} from '../../support/device';

/** The system notification shade, pulled down over the app. */
class NotificationShadeComponent extends Page {
  readonly context = 'NATIVE_APP' as const;
  get root() { return $('id=com.android.systemui:id/notification_stack_scroller'); }
  entry(title: string) { return $(`android=new UiSelector().text("${title}")`); }

  async open() { await this.in(() => browser.execute('mobile: openNotifications')); }
  /** Collapses the shade the way its own control does and leaves the app where it was; a shade that is already closed stays closed. */
  async close() { await adbFor(process.env.ANDROID_SERIAL ?? '')('shell', 'cmd', 'statusbar', 'collapse'); }
}
export default new NotificationShadeComponent();
