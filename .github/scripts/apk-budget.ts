// Usage: bun .github/scripts/apk-budget.ts <release target> <apk>
// Print an APK's size against the ceiling the release gate holds that target to (.changeset/release-artifacts.ts), and exit 1 over it.
import { stat } from 'node:fs/promises';
import { artifactTargets, packageMaximumBytes, type ArtifactTarget } from '../../.changeset/release-artifacts';

const [target, apk] = process.argv.slice(2);
if (!(target in artifactTargets) || !apk) { console.error('usage: apk-budget.ts <release target> <apk>'); process.exit(2); }
const { size } = await stat(apk);
const limit = packageMaximumBytes(target as ArtifactTarget, 'apk');
const line = `${target}: ${size} bytes of ${limit} allowed (${(size / 1048576).toFixed(1)} of ${limit / 1048576} MiB)`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) await Bun.write(process.env.GITHUB_STEP_SUMMARY, `${await Bun.file(process.env.GITHUB_STEP_SUMMARY).text()}- ${line}\n`);
process.exit(size > limit ? 1 : 0);
