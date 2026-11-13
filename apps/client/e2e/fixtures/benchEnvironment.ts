import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// What the benchmark specs record in the environment block of their result files.
export const root = path.resolve(import.meta.dirname, '../../../..');
export const require = createRequire(import.meta.url);
export const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
export const read = (file: string) => { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } };
