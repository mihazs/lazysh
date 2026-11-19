export default {
  // A whole-repository scan compares staged code with unchanged source too.
  // Returning a command avoids appending filenames and narrowing that scan.
  '*': () => 'bun run --bun duplicates:check',
  // Only the staged fragments: legacy fragments already on main keep working, so CI never runs this.
  '.changeset/!(README).md': 'bun .changeset/lint-fragments.ts',
};
