import {browser} from '@wdio/globals';
import type {ChainablePromiseElement} from 'webdriverio';
import {inContext, inNative, inWebView, type AppContext} from '../support/contexts';

/**
 * Base of every page object: it names the context its elements live in. Getters return lazy elements, methods are user
 * actions, and there are no assertions here; specs assert with `expect(...)` inside `page.in(...)`. Actions wait for their
 * element first, because a lazy element that is not rendered yet fails at once instead of waiting.
 */
export default abstract class Page {
  abstract readonly context: AppContext;
  abstract get root(): ChainablePromiseElement;

  /** Runs `run` in this page's context, then returns to the previous one. */
  in<T>(run: () => Promise<T>) { return inContext(this.context, run); }

  async waitUntilShown(timeout?: number) {
    await this.in(() => this.root.waitForDisplayed({timeout, timeoutMsg: `${this.constructor.name} was not displayed`}));
  }

  /** `select` is a thunk: `$()` starts resolving when it is called, so the lookup must run inside this page's context. */
  protected tap(select: () => ChainablePromiseElement) {
    return this.in(async () => { const element = select(); await element.waitForClickable({timeoutMsg: `${this.constructor.name}: element was not clickable`}); await element.click(); });
  }

  protected enter(select: () => ChainablePromiseElement, value: string | number) {
    return this.in(async () => { const element = select(); await element.waitForDisplayed({timeoutMsg: `${this.constructor.name}: element was not displayed`}); await element.setValue(value); });
  }

  /**
   * Closes the soft keyboard the way a user does, by leaving the field. `browser.hideKeyboard()` presses Back and would close
   * the dialog, and a tap that arrives while the keyboard is still resizing the page lands on the wrong spot and is lost.
   */
  protected async closeKeyboard() {
    if (!await inNative(() => browser.isKeyboardShown())) return;
    await inWebView(() => browser.execute(() => (document.activeElement as HTMLElement | null)?.blur()));
    await browser.waitUntil(async () => !await inNative(() => browser.isKeyboardShown()), {timeoutMsg: 'The soft keyboard did not close'});
  }
}
