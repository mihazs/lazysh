import {$} from '@wdio/globals';
import type {ChainablePromiseElement} from 'webdriverio';
import Page from '../page';
import {screenBox} from '../../support/gestures';
import {centreOf, type Rect} from '../../support/navigation';

/**
 * The grips that gesture navigation draws beside the system's Back zones and above its Home zone: a tab you drag, or tap, to open
 * the side menu (left), the bottom menu (bottom) or the Agent view (right). Three-button navigation draws none of them.
 */
class GestureHandlesComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return this.left; }
  get left() { return $('aria/Open the menu (drag right or tap)'); }
  get bottom() { return $('aria/Open bottom menu'); }

  /** Where a handle is on the screen in device pixels. */
  boxOf(handle: () => ChainablePromiseElement): Promise<Rect> { return screenBox(handle); }
  async centreOf(handle: () => ChainablePromiseElement) { return centreOf(await this.boxOf(handle)); }
}
export default new GestureHandlesComponent();
