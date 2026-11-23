import {describe, expect, it} from 'vitest';
import {reportOfSession, terminalFeedbackUrl} from './terminalFeedback';
import {appVersion} from './version';
import {webUrl} from './webPage';

const parts = (url: string) => { const {origin, pathname, searchParams} = new URL(url); return {where: origin + pathname, labels: searchParams.get('labels'), title: searchParams.get('title'), body: searchParams.get('body')!}; };

describe('the prefilled issue form of a terminal problem', () => {
  it('opens the repository\'s new issue page with the engine, the setting, the recorded reasons and the app version', () => {
    const url = terminalFeedbackUrl(reportOfSession({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'failed: surface lost'}]}, 'native'));
    const {where, labels, title, body} = parts(url);
    expect([where, labels, title]).toEqual(['https://github.com/mihazs/lazysh/issues/new', 'bug', 'Terminal engine: ']);
    expect(body.split('\n').slice(0, 8)).toEqual(['**Version**', `lazysh ${appVersion}`, '', '**Terminal engine**', '- Engine: xterm', '- Setting: native', '- Reason: fallback', '- Reason: native: failed: surface lost']);
    expect(body).toContain('**What happened**');
  });

  it('carries only what the report names, and is a link the app is willing to open', () => {
    for (const report of [{}, {preference: 'auto'}, reportOfSession({id: 'native', reason: 'preference', fallbacks: []})]) {
      const url = terminalFeedbackUrl(report);
      expect(webUrl(url)).toBe(url);
    }
    expect(parts(terminalFeedbackUrl({})).body).not.toContain('Engine');
    expect(parts(terminalFeedbackUrl({preference: 'auto'})).body).toContain('- Setting: auto');
  });

  it('stays within what the system browser opener accepts however long the reasons are', () => {
    const long = 'é'.repeat(5000);
    const url = terminalFeedbackUrl({engine: 'native', reasons: [long, long, long, long, long, long]});
    expect(url.length).toBeLessThanOrEqual(4000);
    expect(webUrl(url)).toBe(url);
    expect(parts(url).body.match(/- Reason:/g)).toHaveLength(4);
  });
});
