// @vitest-environment jsdom
import {vi} from 'vitest';
const restore = await vi.hoisted(async () => (await import('./platformEmulation')).emulatePlatform('MacIntel'));
const {runPlatformKeyMatrix} = await import('./platformKeyMatrix');
restore();
runPlatformKeyMatrix('mac');
