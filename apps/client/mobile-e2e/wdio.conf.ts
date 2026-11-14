import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {saveFailureArtifacts} from './support/artifacts';
import {Attempts, mochaGrep, quarantine, reportFlaky, shard, specsFor, tiers} from './support/ci';
import {forbidPause} from './support/guards';

export const here = dirname(fileURLToPath(import.meta.url));
export const reports = join(here, 'reports');
const serial = () => process.env.ANDROID_SERIAL ?? '';
// CI names the run (gating or quarantine) in the flaky-spec summary; a local run is just `local`.
const run = process.env.LAZYSH_E2E_RUN ?? 'local';
const mode = quarantine();
const specs = specsFor(here, tiers(), mode);
if (mode === 'only' && !specs.length) throw new Error('LAZYSH_E2E_FLAKY=only found no spec that mentions @flaky; there is nothing to quarantine.');
const attempts = new Attempts();

/** Settings shared by every platform config; conventions are in docs/reference/mobile-e2e-conventions.md. */
export const config: Omit<WebdriverIO.Config, 'capabilities'> = {
  runner: 'local',
  framework: 'mocha',
  // LAZYSH_E2E_TIERS (default smoke,regression), LAZYSH_E2E_FLAKY (only|exclude) and LAZYSH_E2E_SHARD (x/y) select what a run covers.
  specs,
  shard: shard(),
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
  specFileRetries: process.env.CI ? 1 : 0,
  mochaOpts: {ui: 'bdd', timeout: 120_000, retries: 0, ...mochaGrep(mode)},
  reporters: ['spec', ['junit', {outputDir: join(reports, 'junit'), outputFileFormat: (options: {cid: string}) => `results-${options.cid}.xml`}]],
  // A spec file that passes only on its retry is a flake: the job summary lists it so an issue is opened the same day.
  onWorkerEnd: (_cid, exitCode, files) => reportFlaky(run, attempts.record(files, exitCode), here),
  before: (_capabilities, _specs, driver) => forbidPause(driver),
  afterTest: async (test, _context, result) => {
    if (!result.passed) await saveFailureArtifacts(test, reports, serial());
  },
  // A failing before/beforeEach hook never reaches afterTest, and that is where a connect flow usually breaks.
  afterHook: async (test, _context, result) => {
    if (result.error) await saveFailureArtifacts(test, reports, serial());
  },
};
