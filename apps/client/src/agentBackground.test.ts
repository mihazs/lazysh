import {afterEach, describe, expect, it} from 'vitest';
import {backgroundLine, outranksPane, validBackground} from './agentBackground';
import {parseSnapshot} from './agentReports';
import {uiI18n} from './i18n/core';

afterEach(async () => {await uiI18n.changeLanguage('en');});

const session = {sessionId: 's1', agent: 'Claude Code', project: '/work', state: 'working', updatedAt: '2026-11-28T10:00:00.000Z', summary: 'Working in the background', paneId: null, eventCount: 3};
const parse = (extra: Record<string, unknown>) => parseSnapshot({schemaVersion: 1, sessions: [{...session, ...extra}]});

describe('the snapshot field', () => {
  it('is optional: a companion that does not send it gives the row as it was', () => {
    expect(parse({})[0]).toEqual(session);
  });
  it('is kept as the companion sent it', () => {
    expect(parse({background: {agents: 2, shells: 1}})[0].background).toEqual({agents: 2, shells: 1});
  });
  it.each([[{agents: 0}], [{agents: -1}], [{workflows: 1.5}], [{shells: '1'}], [{agents: 2 ** 60}], [null], [[]], ['1']])('rejects %j', background => {
    expect(validBackground(background)).toBe(false);
    expect(() => parse({background})).toThrow();
  });
});

describe('what runs', () => {
  it('names only the kinds that run, with their plural', () => {
    expect(backgroundLine({agents: 1, workflows: 2, shells: 3})).toBe('1 sub-agent · 2 workflows · 3 shells or monitors');
    expect(backgroundLine({shells: 1})).toBe('1 shell or monitor');
    expect(backgroundLine({agents: 4})).toBe('4 sub-agents');
    expect(backgroundLine({})).toBe('');
    expect(backgroundLine(undefined)).toBe('');
  });
  it('reads in every locale', async () => {
    await uiI18n.changeLanguage('pt-BR');
    expect(backgroundLine({agents: 2, shells: 1})).toBe('2 subagentes · 1 shell ou monitor');
    await uiI18n.changeLanguage('es');
    expect(backgroundLine({workflows: 1, shells: 2})).toBe('1 flujo de trabajo · 2 shells o monitores');
  });
});

describe('against the pane status', () => {
  const row = {state: 'working', background: {agents: 1}};
  it('beats an idle, done or unknown pane and no pane', () => {
    for (const pane of [undefined, 'idle', 'done', 'unknown']) expect(outranksPane(row, pane)).toEqual({agents: 1});
  });
  it('leaves a working or blocked pane, a row without background and a row that is not working alone', () => {
    for (const pane of ['working', 'blocked']) expect(outranksPane(row, pane)).toBeUndefined();
    expect(outranksPane({state: 'working'}, 'idle')).toBeUndefined();
    expect(outranksPane({state: 'done', background: {agents: 1}}, 'idle')).toBeUndefined();
    expect(outranksPane(undefined, 'idle')).toBeUndefined();
  });
});
