import { basename } from 'node:path';
import { splitFragment, summaryProblems } from './changelog-model.mjs';

type Problem = { line: number; message: string };
const bumps = ['major', 'minor', 'patch'];

/** The line-numbered problems of one Changesets fragment; an empty fragment (no packages) needs no summary. */
export function fragmentProblems(content: string): Problem[] {
  const parts = splitFragment(content);
  if (!parts) return [{ line: 1, message: 'the fragment must start with a "---" frontmatter block naming the packages and their bumps' }];
  const problems: Problem[] = [];
  parts.header.forEach((line, index) => {
    const entry = /^"([^"]+)": (\w+)$/.exec(line.trim());
    if (!entry || !bumps.includes(entry[2])) {
      problems.push({ line: index + 2, message: `expected "package-name": ${bumps.join('|')}, found "${line}"` });
    }
  });
  if (parts.header.length === 0 || problems.length) return problems;
  if (!parts.summary.trim()) return [{ line: content.split('\n').length, message: 'the fragment has no summary' }];
  return summaryProblems(parts.summary).map(problem => ({ line: problem.line + parts.lineOffset, message: problem.message }));
}

if (import.meta.main) {
  let failed = false;
  for (const path of process.argv.slice(2).filter(path => basename(path) !== 'README.md')) {
    for (const problem of fragmentProblems(await Bun.file(path).text())) {
      failed = true;
      console.error(`${path}:${problem.line}: ${problem.message}`);
    }
  }
  if (failed) {
    console.error('A changeset summary starts with "type(scope): one-sentence headline", then an optional blank line and details. See CONTRIBUTING.md, "Changelog entries".');
    process.exit(1);
  }
}
