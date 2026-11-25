import {expect} from '@playwright/test';
import {requestedBackend} from '../src/e2eTerminalBackend';
import {mountNativeSurface} from './fixtures/nativeSurfacePage';
import {test} from './fixtures/terminalBackend';
import {onAdapter,screenText} from './fixtures/terminalState';

test.use({syntheticBackend:true});

test('the selected browser backend parses and exposes terminal output',async({page})=>{
  const engine=requestedBackend()??'native';
  await mountNativeSurface(page,engine);
  try {
    await page.evaluate(()=>window.nativeSurface.output('browser adapter marker'));
    await expect.poll(()=>screenText(page)).toContain('browser adapter marker');
    expect(await onAdapter(page,adapter=>adapter.backend)).toBe(engine);
  } finally {
    await page.evaluate(()=>window.nativeSurface.dispose());
  }
});
