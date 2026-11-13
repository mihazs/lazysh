import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {saveFailureArtifacts} from './support/artifacts';
import {forbidPause} from './support/guards';

export const here = dirname(fileURLToPath(import.meta.url));
export const reports = join(here, 'reports');
const serial = () => process.env.ANDROID_SERIAL ?? '';

/** Settings shared by every platform config; conventions are in docs/reference/mobile-e2e-conventions.md. */
export const config: Omit<WebdriverIO.Config, 'capabilities'> = {
  runner: 'local',
  framework: 'mocha',
  specs: [join(here, 'specs/smoke/**/*.e2e.ts'), join(here, 'specs/regression/**/*.e2e.ts')],
  suites: {
    smoke: [join(here, 'specs/smoke/**/*.e2e.ts')],
    regression: [join(here, 'specs/regression/**/*.e2e.ts')],
    journeys: [join(here, 'specs/journeys/**/*.e2e.ts')],
  },
  maxInstances: 1,
  logLevel: 'warn',
  outputDir: reports,
  waitforTimeout: 10_000,
  waitforInterval: 250,
  connectionRetryTimeout: 180_000,
  connectionRetryCount: 1,
  // A retry hides a real defect. CI adds one fresh-session retry per spec file (specFileRetries), never per test.
  mochaOpts: {ui: 'bdd', timeout: 120_000, retries: 0},
  reporters: ['spec', ['junit', {outputDir: join(reports, 'junit'), outputFileFormat: (options: {cid: string}) => `results-${options.cid}.xml`}]],
  before: (_capabilities, _specs, driver) => forbidPause(driver),
  afterTest: async (test, _context, result) => {
    if (!result.passed) await saveFailureArtifacts(test, reports, serial());
  },
  // A failing before/beforeEach hook never reaches afterTest, and that is where a connect flow usually breaks.
  afterHook: async (test, _context, result) => {
    if (result.error) await saveFailureArtifacts(test, reports, serial());
  },
};
