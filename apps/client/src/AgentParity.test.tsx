// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {ChatCard,parseCard,type Card} from './ChatInteraction';
import {interactionPages} from '../e2e/fixtures/interactionPages';
import {t} from './i18n/core';

afterEach(cleanup);
/** Every card kind of the schema and what the Agent view draws for it. A new kind in `Card` fails the type check
 * until it has a row here, and the two tests below fail until a companion fixture carries it and a component draws it. */
const checklist: Record<Card['kind'], {role: 'region' | 'alert'; title: 'chatPlanTitle' | 'chatProposedPlanTitle' | 'chatQuestionTitle' | 'chatErrorTitle'}> = {
  plan: {role: 'region', title: 'chatPlanTitle'},
  proposed_plan: {role: 'region', title: 'chatProposedPlanTitle'},
  question: {role: 'region', title: 'chatQuestionTitle'},
  error: {role: 'alert', title: 'chatErrorTitle'},
};

type Page = {agent?: string; view?: string; messages: readonly {blocks: readonly {type: string; card?: unknown}[]}[]};
/** The cards the real companion produced for the recorded fixtures, parsed with the client's own schema check. */
function fixtureCards(): {kind: Card['kind']; card: Card}[] {
  return Object.values(interactionPages).filter((page): page is never => typeof page === 'object').flatMap(page => {
    const {agent = 'claude', view = 'active_branch', messages} = page as unknown as Page;
    return messages.flatMap(message => message.blocks.flatMap(block => block.card === undefined ? [] : [{kind: (block.card as Card).kind, card: parseCard(block.card, {agent, view, type: block.type})}]));
  });
}

it('has a companion fixture for every card kind the Agent view can receive', () => {
  const seen = new Set(fixtureCards().map(({kind}) => kind));
  expect(Object.keys(checklist).filter(kind => !seen.has(kind as Card['kind']))).toEqual([]);
  expect([...seen].filter(kind => !(kind in checklist))).toEqual([]);
});

it.each(Object.entries(checklist))('draws the %s card from its fixture with the title the user reads', (kind, {role, title}) => {
  const {card} = fixtureCards().find(row => row.kind === kind)!;
  render(<ChatCard card={card} body="Recorded text"/>);
  expect(screen.getByRole(role, {name: t(title)})).toBeTruthy();
});
