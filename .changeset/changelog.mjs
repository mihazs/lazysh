// The Changesets changelog generator (config.json "changelog"): one line per change, linked to its pull request,
// with the details collapsed, and no commit hashes or dependency-update noise.
import { execFileSync } from 'node:child_process';
import { parseSummary, renderEntry, repositoryUrl } from './changelog-model.mjs';

/** `[#N](url)` from the squash commit subject `type(scope): headline (#N)` of the commit that added a fragment. */
function pullRequestLink(commit) {
  if (!commit) return undefined;
  try {
    const subject = execFileSync('git', ['show', '--no-patch', '--format=%s', commit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const number = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
    return number && `[#${number}](${repositoryUrl}/pull/${number})`;
  } catch {
    return undefined;
  }
}

export default {
  getReleaseLine: async (changeset, bump) => renderEntry({ ...parseSummary(changeset.summary, bump), link: pullRequestLink(changeset.commit) }),
  getDependencyReleaseLine: async () => '',
};
