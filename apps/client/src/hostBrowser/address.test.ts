import { describe, expect, it } from 'vitest';
import { normalizeAddress, openOnDevice } from './address';

describe('typed addresses', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['  http://example.com/a?b=1#c  ', 'http://example.com/a?b=1#c'],
    ['example.com', 'https://example.com/'],
    ['example.com/some path', 'https://example.com/some%20path'],
    ['//example.com/x', 'https://example.com/x'],
    ['example.com:8443/x', 'https://example.com:8443/x'],
    // A development server rarely speaks TLS, so a loopback host gets http.
    ['localhost', 'http://localhost/'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['127.0.0.1:5173/app', 'http://127.0.0.1:5173/app'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    ['https://localhost:8443/', 'https://localhost:8443/'],
    ['about:blank', 'about:blank'],
    ['ABOUT:BLANK', 'about:blank'],
    ['münchen.example/straße', 'https://xn--mnchen-3ya.example/stra%C3%9Fe'],
  ])('opens %j as %s', (typed, url) => expect(normalizeAddress(typed)).toEqual({ ok: true, url }));

  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'chrome://settings', 'view-source:https://example.com',
    'blob:https://example.com/x', 'ftp://example.com', 'about:config', 'mailto:a@b.test', 'vbscript:x'])('refuses %j and names its scheme', typed => {
    const result = normalizeAddress(typed);
    expect(result).toEqual({ ok: false, refusal: { reason: 'scheme', scheme: typed.split(':')[0].toLowerCase() } });
  });

  it('refuses what is not an address, is empty or is too long, with a reason for each', () => {
    expect(normalizeAddress('   ')).toEqual({ ok: false, refusal: { reason: 'empty' } });
    expect(normalizeAddress('not a host')).toEqual({ ok: false, refusal: { reason: 'invalid' } });
    expect(normalizeAddress('https://')).toEqual({ ok: false, refusal: { reason: 'invalid' } });
    expect(normalizeAddress(`https://example.com/${'a'.repeat(2048)}`)).toEqual({ ok: false, refusal: { reason: 'tooLong' } });
    expect(normalizeAddress(`example.com/${'é'.repeat(1000)}`)).toEqual({ ok: false, refusal: { reason: 'tooLong' } });
  });

  it('cannot be tricked into a refused scheme by characters the URL parser drops', () => {
    for (const typed of ['java\tscript:alert(1)', 'java\nscript:alert(1)', ' \u0001javascript:alert(1)'])
      expect(normalizeAddress(typed), JSON.stringify(typed)).toMatchObject({ ok: false });
  });

  it('only ever returns an address the host relay accepts: http, https or about:blank, printable ASCII, at most 2048', () => {
    for (const typed of ['example.com/ü', 'localhost:3000/ä?q=é#ö', '[::1]/x y']) {
      const result = normalizeAddress(typed);
      expect(result.ok, typed).toBe(true);
      if (result.ok) expect(result.url).toMatch(/^(https?:\/\/[\x21-\x7e]{1,2000}|about:blank)$/);
    }
  });
});

describe('Open on this device', () => {
  it.each([
    ['http://localhost:3000/app?x=1#y', { kind: 'preview', port: 3000, address: '127.0.0.1', path: '/app?x=1#y' }],
    ['http://127.0.0.1:8080/', { kind: 'preview', port: 8080, address: '127.0.0.1', path: '/' }],
    ['http://[::1]:5173/docs', { kind: 'preview', port: 5173, address: '::1', path: '/docs' }],
    ['http://localhost/', { kind: 'preview', port: 80, address: '127.0.0.1', path: '/' }],
    ['https://localhost/', { kind: 'preview', port: 443, address: '127.0.0.1', path: '/' }],
  ])('forwards the loopback page %s as a Preview', (page, plan) => expect(openOnDevice(page)).toEqual(plan));

  it('names the host of any other page, which is the one the person confirms', () => {
    expect(openOnDevice('https://accounts.example.com/login?next=/')).toEqual({ kind: 'external', host: 'accounts.example.com', url: 'https://accounts.example.com/login?next=/' });
    // A look-alike of a loopback name is not loopback, and an IDN shows as the ASCII a browser would resolve.
    expect(openOnDevice('http://localhost.evil.test/')).toMatchObject({ kind: 'external', host: 'localhost.evil.test' });
    expect(openOnDevice('http://127.0.0.1.evil.test:3000/')).toMatchObject({ kind: 'external' });
    expect(openOnDevice('https://аррӏе.example/')).toMatchObject({ kind: 'external', host: expect.stringMatching(/^xn--/) });
    expect(openOnDevice('http://10.0.0.5:3000/')).toMatchObject({ kind: 'external', host: '10.0.0.5' });
  });

  it('has nothing to open for a page that is not on the web', () => {
    for (const page of ['about:blank', '', 'javascript:alert(1)', 'chrome://version', 'not a url']) expect(openOnDevice(page), page).toBeUndefined();
  });
});
