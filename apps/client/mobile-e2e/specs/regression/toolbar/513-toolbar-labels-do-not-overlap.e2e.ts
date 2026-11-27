/**
 * #513 Toolbar labels overlapped at phone density (epic #1396, issue #1407). The real WebView lays the keys out at the phone's
 * density, which a desktop browser's emulated phone does not reproduce.
 */
import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import Toolbar, {type KeyBox} from '../../../pageobjects/components/toolbar.component';
import {resetApp} from '../../../support/app';

const overlap = (a: KeyBox['box'], b: KeyBox['box']) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

describe('#513 toolbar labels at phone density', () => {
  before(async () => { await connectOwnedHost(); });
  after(resetApp);

  it('show every key of the Keys page whole, side by side without overlapping', async () => {
    const keys = await Toolbar.keyBoxes('keys');
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter(key => key.cut).map(key => key.label)).toEqual([]);
    const overlapping = keys.flatMap((a, index) => keys.slice(index + 1).filter(b => overlap(a.box, b.box)).map(b => `${a.label} / ${b.label}`));
    expect(overlapping).toEqual([]);
  });
});
