import { appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function javaProperty(value: string) {
  return value.split('').map(character => /[A-Za-z0-9_/.:-]/.test(character) ? character
    : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
}
if (import.meta.main) {
const directory = process.env.RUNNER_TEMP && join(process.env.RUNNER_TEMP, 'lazysh-android-signing');
if (!directory) throw new Error('Android release requires owned runner temp');
if (process.argv[2] === 'cleanup') {
  await rm(directory, { recursive: true, force: true });
} else {
  const names = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_PASSWORD',
    'ANDROID_KEY_ALIAS', 'ANDROID_SIGNER_SHA256'];
  const missing = names.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Android installation signing unavailable; missing ${missing.join(', ')}`);
  const encoded = process.env.ANDROID_KEYSTORE_BASE64!;
  if (encoded.length > 524_288 || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
    throw new Error('Android release keystore must use bounded canonical base64');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const storeFile = join(directory, 'release.jks');
  await Bun.write(storeFile, Buffer.from(encoded, 'base64'));
  // Java .properties escaping preserves the original password/alias; never emit
  // those values into shell syntax, stdout, workflow outputs or public artifacts.
  const properties = { storeFile, storePassword: process.env.ANDROID_STORE_PASSWORD!,
    keyPassword: process.env.ANDROID_KEY_PASSWORD!, keyAlias: process.env.ANDROID_KEY_ALIAS! };
  const file = join(directory, 'signing.properties');
  await Bun.write(file, Object.entries(properties).map(([key, value]) => `${key}=${javaProperty(value)}`).join('\n'));
  if (!process.env.GITHUB_ENV) throw new Error('Android release requires workflow environment output');
  await appendFile(process.env.GITHUB_ENV, `LAZYSH_ANDROID_SIGNING_PROPERTIES=${file}\n`);
}
}
