import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const directory = join(dirname(fileURLToPath(import.meta.url)), '../data');

/** Static, deterministic inputs from `data/` (no secrets, no keys). `{nonce}` is replaced with the owned fixture's nonce. */
export async function loadData<T>(name: string, nonce: string): Promise<T> {
  return JSON.parse((await readFile(join(directory, `${name}.json`), 'utf8')).replaceAll('{nonce}', nonce)) as T;
}
