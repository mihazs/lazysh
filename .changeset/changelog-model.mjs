// One model of a changelog entry, shared by the Changesets generator (changelog.mjs), the GitHub release notes
// (release-artifacts.ts), the root CHANGELOG.md rotation (changelog-rotate.ts), the pending-changes preview and the
// fragment linter. A fragment is `type(scope): headline`, then optional details after a blank line.

export const repositoryUrl = 'https://github.com/mihazs/lazysh';
export const fragmentTypes = ['feat', 'fix', 'perf', 'docs', 'refactor', 'build', 'ci', 'test', 'chore', 'revert'];
export const headlineLimit = 110;

/** Release-note headings in display order, with the entry types each one collects. `change` is a legacy entry with no clear type. */
const categories = [
  ['New', ['feat']],
  ['Improved', ['perf', 'refactor', 'change']],
  ['Fixed', ['fix']],
  ['Documentation', ['docs']],
  ['Under the hood', ['build', 'ci', 'test', 'chore', 'revert']],
];

const shape = new RegExp(`^(${[...fragmentTypes, 'change'].join('|')})(?:\\(([a-z0-9][a-z0-9._/-]*)\\))?(!)?: (\\S.*)$`);
const prSuffix = / \((\[#\d+\]\([^)\s]+\))\)$/;
const detailsBlock = /\n\n<details><summary>Details<\/summary>\n\n([\s\S]*?)\n\n<\/details>$/;
const dependencyLine = /^(@lazysh\/[\w-]+@\d|Updated dependencies)/;

// The deterministic classifier for entries written before the structured format: the leading verb decides.
const verbs = [
  ['fix', /^Fix/],
  ['docs', /^(Record|Measure|State|Refresh|Align|Document|Catalogue)/],
  ['build', /^(Build|Run)\b/],
  ['ci', /^CI\b/],
  ['test', /^(Verify|Test|Prove)\b/],
];
const featureVerb = new RegExp(`^(${['Add', 'Show', 'Answer', 'Start', 'Open', 'List', 'Remember', 'Detect', 'Teach', 'Let', 'Offer', 'Support',
  'Discover', 'Enable', 'Allow', 'Display', 'Browse', 'Give', 'Accept', 'Optional', 'Opt-in', 'Expose', 'Reveal', 'Toggle', 'Import'].join('|')})\\b`);

/** `bump` is the Changesets bump when known: a patch never claims a new feature, a minor or major always does. */
export function classifyLegacy(text, bump) {
  const verb = verbs.find(([, pattern]) => pattern.test(text));
  if (verb) return verb[0];
  if (bump === 'patch') return 'change';
  return bump || featureVerb.test(text) ? 'feat' : 'change';
}

const balanced = text => (text.match(/\(/g) ?? []).length === (text.match(/\)/g) ?? []).length && (text.match(/`/g) ?? []).length % 2 === 0;

/** A long sentence as a headline: cut at its first colon or semicolon that fits outside parentheses and code, else at a word. */
function shorten(text, limit) {
  if (text.length <= limit) return text;
  const clause = [...text.matchAll(/[:;] /g)].map(match => match.index).find(index => index >= 20 && index <= limit && balanced(text.slice(0, index)));
  if (clause !== undefined) return text.slice(0, clause);
  let cut = text.slice(0, limit - 1);
  cut = cut.slice(0, Math.max(cut.lastIndexOf(' '), 1));
  if ((cut.match(/\(/g) ?? []).length > (cut.match(/\)/g) ?? []).length) cut = cut.slice(0, cut.lastIndexOf('('));
  if ((cut.match(/`/g) ?? []).length % 2) cut = cut.slice(0, cut.lastIndexOf('`'));
  return `${cut.replace(/[\s,;:([-]+$/, '')}…`;
}

/** Problems of a fragment summary against the structured format, each with its 1-based line in the summary. */
export function summaryProblems(summary) {
  const lines = summary.trim().split('\n');
  const match = shape.exec(lines[0].trimEnd());
  if (!match || match[1] === 'change') {
    return [{ line: 1, message: `the first line must be "type(scope): headline" with a type of ${fragmentTypes.join(', ')}, found "${lines[0]}"` }];
  }
  const problems = [];
  if (match[4].length > headlineLimit) {
    problems.push({ line: 1, message: `the headline is ${match[4].length} characters, keep it to ${headlineLimit} and move the rest into the details` });
  }
  if (lines.length > 1 && lines[1].trim()) problems.push({ line: 2, message: 'leave a blank line between the headline and the details' });
  return problems;
}

/** The first sentence of the first paragraph, and what follows it. */
function splitSentence(text) {
  const paragraph = /^[\s\S]*?(?=\n\s*\n|$)/.exec(text)[0];
  const end = /^[\s\S]*?[.!?](?=\s+[A-Z`(*[]|\s*$)/.exec(paragraph)?.[0] ?? paragraph;
  return [end.replace(/\s+/g, ' ').trim().replace(/\.$/, ''), text.slice(end.length).trim()];
}

/**
 * An entry from a fragment summary or from the text of a changelog bullet. A summary that is not `type(scope): headline`
 * is a legacy free-text one: its first sentence becomes the headline and the rest, or the whole text when the
 * headline had to be shortened, becomes the details.
 */
export function parseSummary(summary, bump) {
  const text = summary.trim();
  const [first, ...rest] = text.split('\n');
  const match = shape.exec(first.trimEnd());
  if (match) return { type: match[1], scope: match[2], breaking: Boolean(match[3]), headline: match[4], details: rest.join('\n').trim() };
  const [sentence, remainder] = splitSentence(text);
  const headline = shorten(sentence, headlineLimit);
  return { type: classifyLegacy(text, bump), headline, details: headline === sentence ? remainder : text };
}

/** The entries of a generated or legacy changelog section: the bullets of `### Major|Minor|Patch Changes` and grouped sections alike. */
export function parseEntries(section) {
  const entries = [];
  let bump;
  for (const block of section.split(/^(?=- |#{2,6} )/m)) {
    const heading = /^#{2,6} (Major|Minor|Patch) Changes/.exec(block);
    if (heading) bump = heading[1].toLowerCase();
    if (!block.startsWith('- ')) continue;
    let body = block.slice(2).replace(/\n {2}/g, '\n').replace(/^([0-9a-f]{7}): /, '').trimEnd();
    if (dependencyLine.test(body)) continue;
    const [first, ...rest] = body.split('\n');
    const link = prSuffix.exec(first);
    body = [first.replace(prSuffix, ''), ...rest].join('\n');
    const details = detailsBlock.exec(body);
    if (details) body = `${body.slice(0, details.index)}\n\n${details[1]}`;
    entries.push({ ...parseSummary(body, bump), link: link?.[1] });
  }
  return entries;
}

const indent = text => text.replace(/^(?=.)/gm, '  ');

/** One bullet: `type(scope): headline` for a package changelog, or a bold scope for the grouped release notes. */
export function renderEntry({ type, scope, breaking, headline, details, link }, grouped = false) {
  const label = grouped
    ? `${breaking ? '**Breaking:** ' : ''}${scope ? `**${scope}:** ` : ''}`
    : `${type}${scope ? `(${scope})` : ''}${breaking ? '!' : ''}: `;
  const line = `- ${label}${headline}${link ? ` (${link})` : ''}`;
  return details ? `${line}\n\n${indent(`<details><summary>Details</summary>\n\n${details}\n\n</details>`)}` : line;
}

/** Markdown items `{ type, text }` under one heading per non-empty category, in the fixed order. */
export function groupMarkdown(items, level = '###') {
  return categories.flatMap(([name, types]) => {
    const group = items.filter(item => types.includes(item.type));
    return group.length ? [`${level} ${name}\n\n${group.map(item => item.text).join('\n')}`] : [];
  }).join('\n\n');
}

export const renderGrouped = (entries, level) => groupMarkdown(entries.map(entry => ({ type: entry.type, text: renderEntry(entry, true) })), level);

/** The body of `## <version>` in a Changesets package changelog, or undefined. */
export const changelogSection = (changelog, version) =>
  changelog.split(new RegExp(`^## ${version.replaceAll('.', '\\.')}\\s*$`, 'm'))[1]?.split(/^## /m)[0];

const frontmatter = /^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/;

/** A Changesets fragment as its frontmatter lines, its summary and the number of lines before the summary; undefined without frontmatter. */
export function splitFragment(content) {
  const parsed = frontmatter.exec(content);
  if (!parsed) return undefined;
  const summary = parsed[2].replace(/^\n+/, '');
  return { header: parsed[1].split('\n').filter(line => line.trim()), summary, lineOffset: content.slice(0, content.length - summary.length).split('\n').length - 1 };
}
