// Usage: bun .github/scripts/apk-engine.ts <apk> <google|foss> [on|off]
// Hold an Android APK to what its flavor and the build's kill switch (LAZYSH_NATIVE_TERMINAL, #1342) say about the native terminal engine:
// both flavors carry it unless the switch was off. "Carries" is read from the arm64 native library: the
// JNI entry points of the surface host and the renderer's wgpu strings. One without the other fails whatever was expected.
// Exits 1 when the APK is not what was expected and 2 when the call or the library is unusable.
import { appendFile } from 'node:fs/promises';

const [apk, flavor, killSwitch = 'on'] = process.argv.slice(2);
if (!apk || !['google', 'foss'].includes(flavor) || !['on', 'off'].includes(killSwitch)) { console.error('usage: apk-engine.ts <apk> <google|foss> [on|off]'); process.exit(2); }
const library = 'lib/arm64-v8a/liblazysh_lib.so';
const unzip = Bun.spawn(['unzip', '-p', apk, library], { stdout: 'pipe', stderr: 'pipe' });
const [bytes, error, code] = await Promise.all([new Response(unzip.stdout).arrayBuffer(), new Response(unzip.stderr).text(), unzip.exited]);
if (code !== 0 || !bytes.byteLength) { console.error(`Cannot read ${library} from ${apk}: ${error.trim() || `unzip exited ${code}`}`); process.exit(2); }
const lib = Buffer.from(bytes);
const count = (needle: string) => { let found = 0; for (let at = lib.indexOf(needle); at >= 0; at = lib.indexOf(needle, at + needle.length)) found++; return found; };
const entries = count('Java_app_lazysh_client_JniSurface_native'), wgpu = count('wgpu');
const carries = entries > 0 && wgpu > 0, without = entries === 0 && wgpu === 0;
const required = killSwitch === 'on';
const line = `${flavor} APK built with the kill switch ${killSwitch}: ${entries} surface host entry points and ${wgpu} wgpu strings in ${library}; the engine is ${required ? 'required' : 'to be left out'}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
process.exit((required ? carries : without) ? 0 : 1);
