// @vitest-environment jsdom
import {vi} from 'vitest';
const restore = await vi.hoisted(async () => (await import('./platformEmulation')).emulatePlatform('Win32'));
const {runPlatformKeyMatrix} = await import('./platformKeyMatrix');
restore();
runPlatformKeyMatrix('windows');
