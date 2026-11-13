// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GestureTour from '../GestureTour';
import {tourSteps} from '../gestureTourModel';
import {english} from './en';
import {t, uiI18n} from './core';

afterEach(async () => {cleanup(); await uiI18n.changeLanguage('en');});

it.each(['pt-BR', 'es'])('%s translates every step and the controls, and a language change keeps the step', async locale => {
  const user = userEvent.setup();
  render(<GestureTour notes={{side: null, bottom: 'gestureTourOff', view: null}} finish={() => {}} />);
  await user.click(screen.getByRole('button', {name: t('gestureTourNext')}));
  await act(async () => {await uiI18n.changeLanguage(locale);});
  expect(screen.getByRole('heading', {name: t('gestureTourBottomTitle')})).toBeTruthy();
  expect(screen.getByText(t('gestureTourBottomBody'))).toBeTruthy();
  expect(screen.getByText(t('gestureTourOff'))).toBeTruthy();
  expect(screen.getByText(t('gestureTourProgress', {current: 2, total: tourSteps.length}))).toBeTruthy();
  const keys = [...tourSteps.flatMap(step => [step.title, step.body]), 'gestureTourSkip', 'gestureTourNext', 'gestureTourDone', 'gestureTourReplay', 'gestureTourOff', 'gestureTourTopBar', 'gestureTourScreenReader', 'gestureTourAndroidEdge', 'gestureTourHandles', 'gestureTourPlay', 'gestureHelpTitle', 'gestureTourTitle'] as const;
  // Same word in two languages is fine for "Gestos"; every sentence must be translated.
  for (const key of keys.filter(key => key !== 'gestureHelpTitle')) expect(t(key), `${locale}.${key}`).not.toBe(english[key]);
});
