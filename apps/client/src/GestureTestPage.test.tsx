// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';
import GestureTestPage, {swipeOrigin} from './GestureTestPage';
import {setGestureInsets, unknownInsets, type GestureInsets} from './gestureInsets';
import {defaults, savePreferences} from './preferences';
import {t} from './i18n/core';

const oneUi: GestureInsets = {left: 40, right: 40, bottom: 12, mandatoryBottom: 24, navigation: 'gesture'};
const finger = (x: number, y: number) => ({identifier: 0, clientX: x, clientY: y, target: document.body});
function touch(type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', x: number, y: number, down = type !== 'touchend' && type !== 'touchcancel') {
  const event = new Event(type, {bubbles: true, cancelable: true});
  Object.assign(event, {touches: down ? [finger(x, y)] : [], changedTouches: [finger(x, y)]});
  act(() => {window.dispatchEvent(event);});
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: 411});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: 891});
  savePreferences({...defaults}); setGestureInsets(unknownInsets);
});
afterEach(cleanup);

describe('where a swipe began', () => {
  const view = {width: 411, height: 891};
  it('names the edge within the system zone, with a 24 px grab at least', () => {
    expect(swipeOrigin(3, 500, view, oneUi)).toBe('left');
    expect(swipeOrigin(40, 500, view, oneUi)).toBe('left');
    expect(swipeOrigin(41, 500, view, oneUi)).toBe('screen');
    expect(swipeOrigin(409, 500, view, oneUi)).toBe('right');
    expect(swipeOrigin(200, 880, view, oneUi)).toBe('bottom');
    expect(swipeOrigin(200, 700, view, oneUi)).toBe('screen');
    expect(swipeOrigin(20, 500, view, unknownInsets)).toBe('left');
    expect(swipeOrigin(60, 500, view, unknownInsets)).toBe('screen');
  });
  it('names the swipe area beside an edge, past the system zone, when the handle mode gives it a width', () => {
    // The 40 dp Back zone plus 4 dp, and 40 dp deep; the side areas stop 80 dp above the 24 dp Home zone.
    expect(swipeOrigin(50, 500, view, oneUi, 40)).toBe('leftBand');
    expect(swipeOrigin(view.width - 50, 500, view, oneUi, 40)).toBe('rightBand');
    expect(swipeOrigin(200, view.height - 40, view, oneUi, 40)).toBe('bottomBand');
    expect(swipeOrigin(50, 20, view, oneUi, 40)).toBe('leftBand');
    expect(swipeOrigin(50, view.height - 90, view, oneUi, 40)).toBe('screen');
    expect(swipeOrigin(100, 500, view, oneUi, 40)).toBe('screen');
    expect(swipeOrigin(30, 500, view, oneUi, 40)).toBe('left');
    expect(swipeOrigin(50, 500, view, oneUi)).toBe('screen');
  });
});

describe('the gesture test page', () => {
  it('shows the live system zones and updates when they change', () => {
    render(<GestureTestPage />);
    expect(screen.getByText(t('gestureTestNavigationUnknown'))).toBeTruthy();
    act(() => setGestureInsets(oneUi));
    expect(screen.getByText(t('gestureTestNavigationGesture'))).toBeTruthy();
    expect(screen.getByTestId('gesture-test-insets').textContent).toBe(t('gestureTestInsetsValue', {left: '40', right: '40', bottom: '12', home: '24'}));
    expect(screen.getByText(t('gestureModeHandles'), {selector: 'dd'})).toBeTruthy();
    // The system bands and the three handles are drawn.
    expect(screen.getByRole('img').querySelectorAll('i[data-kind="system"]')).toHaveLength(3);
    expect(screen.getByRole('img').querySelectorAll('i[data-kind="handle"]')).toHaveLength(3);
    // Beside each handle, past the system zone, there is the band a swipe may start in.
    expect(screen.getByRole('img').querySelectorAll('i[data-kind="edge"]')).toHaveLength(3);
    act(() => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: true, zoneWidth: 24, mode: 'edges'}}));
    expect(screen.getByRole('img').querySelectorAll('i[data-kind="edge"]')).toHaveLength(3);
    expect(screen.getByRole('img').querySelectorAll('i[data-kind="handle"]')).toHaveLength(0);
  });
  it('says whether the system took a swipe: a finger that lifts reached the app, a cancel is the system', () => {
    act(() => setGestureInsets(oneUi));
    render(<GestureTestPage />);
    expect(screen.getByText(t('gestureTestNoResults'))).toBeTruthy();
    touch('touchstart', 3, 600); touch('touchmove', 50, 600); touch('touchend', 120, 600);
    expect(screen.getByText(t('gestureTestResultApp', {from: t('gestureTestFromLeft'), distance: '117'}))).toBeTruthy();
    touch('touchstart', 200, 885); touch('touchmove', 200, 860); touch('touchcancel', 200, 860);
    const taken = screen.getByText(t('gestureTestResultSystem', {from: t('gestureTestFromBottom')}));
    expect(taken.closest('li')?.getAttribute('data-outcome')).toBe('system');
    // Newest first, and the list stays short.
    expect(screen.getAllByRole('listitem').filter(item => item.hasAttribute('data-outcome'))[0]).toBe(taken.closest('li'));
    for (let index = 0; index < 8; index++) {touch('touchstart', 200, 500); touch('touchend', 200, 400);}
    expect(document.querySelectorAll('.gesture-test-results > li[data-outcome]')).toHaveLength(5);
  });
  it('ignores a second finger and the engine\'s own synthetic cancel', () => {
    render(<GestureTestPage />);
    const two = new Event('touchstart', {bubbles: true});
    Object.assign(two, {touches: [finger(3, 600), finger(300, 600)], changedTouches: [finger(300, 600)]});
    act(() => {window.dispatchEvent(two);});
    act(() => {window.dispatchEvent(new Event('touchcancel', {bubbles: true}));});
    expect(screen.getByText(t('gestureTestNoResults'))).toBeTruthy();
  });
});
