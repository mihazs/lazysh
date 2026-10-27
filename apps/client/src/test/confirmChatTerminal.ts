import {fireEvent,screen} from '@testing-library/react';
import {t} from '../i18n/core';
/** Shared explicit user action for the native component and actual Chat tests. */
export async function confirmChatTerminal() {
  fireEvent.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));
  fireEvent.click(await screen.findByRole('button',{name:t('chatTerminalConfirm')}));
  await screen.findByRole('button',{name:t('chatTerminalSend')});
}
