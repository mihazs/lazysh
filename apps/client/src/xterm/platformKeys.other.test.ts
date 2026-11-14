// @vitest-environment jsdom
import {vi} from 'vitest';
const restore = await vi.hoisted(async () => (await import('./platformEmulation')).emulatePlatform('Linux x86_64'));
const {runPlatformKeyMatrix} = await import('./platformKeyMatrix');
restore();
runPlatformKeyMatrix('other');
