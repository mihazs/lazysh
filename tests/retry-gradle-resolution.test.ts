import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFakeBuild } from './support/fakeBuild';
import { project } from './support/gitFixture';
import { document } from './support/workflowGraph';

const script = join(project, '.github/scripts/retry-gradle-resolution.sh');
// Each fake Gradle run prints one line and exits as the plan says; LAZYSH_RETRY_UNIT=0 skips the backoff waits.
const retried = (plan: string[], env: Record<string, string> = {}) =>
  runFakeBuild(plan, 'gradle', build => ['sh', script, build, 'assembleUniversalRelease'], { LAZYSH_RETRY_UNIT: '0', ...env });

test.each([
  "Could not GET 'https://repo.maven.apache.org/maven2/org/codehaus/groovy/groovy/3.0.22/groovy-3.0.22.pom'. Received status code 429 from server: Too Many Requests",
  '> Could not find org.codehaus.groovy:groovy:3.0.22.',
  '> Could not resolve org.jetbrains.kotlin:kotlin-gradle-plugin:2.3.21.',
  '> Could not parse POM https://plugins.gradle.org/m2/org/jetbrains/kotlin/kotlin-gradle-plugin/2.3.21/kotlin-gradle-plugin-2.3.21.pom',
  'Could not GET https://dl.google.com/dl/android/maven2/x.pom. Received status code 502 from server: Bad Gateway',
  'Could not HEAD https://repo.maven.apache.org/maven2/x.pom. Received status code 503 from server: Service Unavailable',
  '> Read timed out', '> Connection reset', 'Premature end of Content-Length delimited message body (expected: 1234; received: 56)',
])('a Gradle dependency download failure (%s) is retried with the log kept', async failure => {
  const result = await retried([`1:${failure}`, '0:BUILD SUCCESSFUL']);
  expect(result).toMatchObject({ exit: 0, calls: ['assembleUniversalRelease', 'assembleUniversalRelease'] });
  expect(result.stdout).toContain(failure);
  expect(result.stdout).toMatch(/::warning::Gradle dependency resolution failed on attempt 1 of 5 \(\S.*\); retrying in 0 seconds/);
});

test('the retry warning names the attempt, the cleaned-up reason and the 1, 3, 6, 10 minute backoff', async () => {
  const failure = '1:   > Could not find org.jetbrains.kotlin:kotlin-stdlib:2.3.21.';
  // A stand-in sleep keeps the default waits from being served.
  const result = await runFakeBuild(Array(5).fill(failure).concat('0:never reached'), 'gradle',
    (build, bin) => { writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o700 }); return ['sh', script, build, 'assemble']; });
  expect(result).toMatchObject({ exit: 1, calls: Array(5).fill('assemble') });
  const reason = 'Could not find org.jetbrains.kotlin:kotlin-stdlib:2.3.21.';
  expect(result.stdout.split('\n').filter(line => line.startsWith('::'))).toEqual([
    ...[60, 180, 360, 600].map((wait, index) => `::warning::Gradle dependency resolution failed on attempt ${index + 1} of 5 (${reason}); retrying in ${wait} seconds`),
    `::error::Gradle dependency resolution still failing after 5 attempts (${reason})`,
  ]);
});

test('an always-failing download is attempted exactly five times and keeps the build exit status', async () => {
  const failure = '17:Could not parse POM https://plugins.gradle.org/m2/x.pom';
  expect(await retried([...Array(5).fill(failure), '0:never reached'])).toMatchObject({ exit: 17, calls: Array(5).fill('assembleUniversalRelease') });
  expect(await retried([failure, '0:never reached'], { LAZYSH_RETRY_ATTEMPTS: '1' })).toMatchObject({ exit: 17, calls: ['assembleUniversalRelease'] });
});

test.each([
  ['a Kotlin compile error', 'e: file:///app/src/Main.kt:12:5 Unresolved reference: foo'],
  ['a lint failure', "Execution failed for task ':app:lintVitalAnalyzeUniversalRelease'. > Lint found errors in the project"],
  ['a dependency verification failure', "Dependency verification failed for configuration ':classpath' (org.jetbrains.kotlin:kotlin-stdlib:2.3.21)"],
  ['a build script error', 'Could not find method implementation() for arguments [foo] on object of type Project'],
  ['status-code lookalikes in compiler output', '2026-11-19T22:37:24.5503829Z compiled 429 files in 502ms with 503 warnings'],
])('%s is returned at once without a retry', async (_, failure) => {
  const result = await retried([`2:${failure}`, '0:never reached']);
  expect(result).toMatchObject({ exit: 2, calls: ['assembleUniversalRelease'] });
  expect(result.stdout).not.toContain('::');
});

test('a clean build runs once without a warning', async () => {
  const result = await retried(['0:BUILD SUCCESSFUL']);
  expect(result).toMatchObject({ exit: 0, calls: ['assembleUniversalRelease'] });
  expect(result.stdout).not.toContain('::');
});

const flaky = 'Could not find org.codehaus.groovy:groovy:3.0.22.';
const stepNamed = async (file: string, name: string) => (await document(file)).jobs[file.includes('tag') ? 'source-build' : 'android'].steps.find((step: any) => step.name === name);

test('the release Android build retries one flavor on a dependency failure and still validates each APK', async () => {
  const step = await stepNamed('.github/workflows/release-artifacts.yml', 'Build each release flavor with the configured signer, validating each APK before the next build');
  const result = await runFakeBuild([`1:${flaky}`, '0:', '0:', '0:', '0:'], 'bun', () => ['bash', '-e', '-c', step.run],
    { GITHUB_WORKSPACE: project, LAZYSH_RETRY_UNIT: '0', NDK_HOME: '/ndk', RUNNER_TEMP: '/owned' });
  const label = (call: string) => call.includes('tauri android build') ? `build ${call.includes('--features fdroid') ? 'foss' : 'google'}` : `validate ${call.split(' ')[1]}`;
  expect(result.exit).toBe(0);
  expect(result.calls.map(label)).toEqual(['build foss', 'build foss', 'validate android-foss-arm64', 'build google', 'validate android-google-arm64']);
});

test('the release source build retries only the fdroid build on a dependency failure, not the scans before it', async () => {
  const step = await stepNamed('.github/workflows/release-tag.yml', 'Source scan exact candidate, then build with binary scans');
  const temp = await mkdtemp(join(tmpdir(), 'lazysh-source-build-'));
  try {
    // Three docker runs (readmeta, lint, scanner) pass, then the build fails once and succeeds on retry.
    const result = await runFakeBuild(['0:', '0:', '0:', `1:${flaky}`, '0:'], 'docker',
      (_, bin) => { writeFileSync(join(bin, 'bun'), '#!/bin/sh\n', { mode: 0o700 }); return ['bash', '-e', '-c', step.run]; },
      { GITHUB_WORKSPACE: project, LAZYSH_RETRY_UNIT: '0', RUNNER_TEMP: temp, BUILD_CONTAINER: 'owned', VERSION_CODE: '1080004' });
    expect(result.exit).toBe(0);
    expect(result.calls.map(call => call.match(/fdroid (\w+)/)![1])).toEqual(['readmeta', 'lint', 'scanner', 'build', 'build']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
