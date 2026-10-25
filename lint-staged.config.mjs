// A whole-repository scan compares staged code with unchanged source too.
// Returning a command avoids appending filenames and narrowing that scan.
export default () => 'bun run --bun duplicates:check';
