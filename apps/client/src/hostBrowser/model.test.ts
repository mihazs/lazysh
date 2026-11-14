import { describe, expect, it } from 'vitest';
import { historyReach, pageTabs, untrusted } from './model';

const chars = (...codes: number[]) => String.fromCodePoint(...codes);

describe('page text', () => {
  it('drops characters that hide or reorder text and turns line breaks into spaces on one line', () => {
    const disguised = `invoice${chars(0x202e)}fdp.exe${chars(0x200b, 0x2066, 0xfeff, 0x7, 0x1b)}\r\n\tend`;
    expect(untrusted(disguised, 100)).toBe('invoicefdp.exe   end');
  });

  it('keeps the lines of a dialog but not its control characters, and bounds it', () => {
    expect(untrusted(`one\r\ntwo\rthree\u0000${chars(0x202e)}`, 100, true)).toBe('one\ntwo\nthree');
    const long = untrusted('😀'.repeat(50), 10);
    expect([...long]).toHaveLength(10);
    expect(long.endsWith('…')).toBe(true);
    expect(untrusted('short', 10)).toBe('short');
  });

  it('shows nothing for what is not text', () => {
    for (const value of [undefined, null, 5, {}, ['a']]) expect(untrusted(value, 10)).toBe('');
  });
});

describe('tabs', () => {
  it('are the pages, in the order reported, as bounded text', () => {
    const tabs = pageTabs([
      { targetId: 'w', type: 'service_worker', url: 'https://sw.test/' },
      { targetId: 'a', type: 'page', title: 'A', url: 'https://a.test/' },
      { targetId: 'ui', type: 'browser_ui', url: 'chrome://omnibox-popup.top-chrome/' },
      { targetId: 'b', type: 'page', title: 'x'.repeat(500), url: `https://b.test/${'y'.repeat(5000)}` },
      { targetId: 'c', type: 'page' },
    ]);
    expect(tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c']);
    expect([...tabs[1].title]).toHaveLength(200);
    expect([...tabs[1].url]).toHaveLength(2048);
    expect(tabs[2]).toEqual({ id: 'c', title: '', url: '' });
  });
});

describe('history', () => {
  it('leads back and forward to the entries beside the current one', () => {
    const entries = [{ id: 4 }, { id: 5 }, { id: 6 }];
    expect(historyReach({ currentIndex: 1, entries })).toEqual({ back: 4, forward: 6 });
    expect(historyReach({ currentIndex: 0, entries })).toEqual({ back: undefined, forward: 5 });
    expect(historyReach({ currentIndex: 2, entries })).toEqual({ back: 5, forward: undefined });
    expect(historyReach(null)).toEqual({ back: undefined, forward: undefined });
  });
});
