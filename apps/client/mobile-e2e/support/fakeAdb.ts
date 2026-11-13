import {chmod, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// A stand-in for the adb binary that keeps a device in a JSON file, so device.ts and the setup code run against
// controlled inputs without a guest. Used only by unit tests.

export interface FakeDevice {
  size: string | null;
  density: number | null;
  navigation: string;
  settings: Record<string, string>;
  permissions: Record<string, boolean>;
  failOn: string[];
  calls: string[];
}

export const initialDevice = (): FakeDevice => ({
  size: null, density: null, navigation: 'threebutton', failOn: [], calls: [],
  settings: {
    'secure.default_input_method': 'com.android.inputmethod.latin/.LatinIME', 'system.user_rotation': '0',
    'system.accelerometer_rotation': '0', 'global.window_animation_scale': '1.0', 'global.transition_animation_scale': '1.0',
  },
  permissions: {'android.permission.POST_NOTIFICATIONS': false, 'android.permission.CAMERA': true},
});

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.FAKE_ADB_STATE;
// adb serves parallel callers; serialise the read-modify-write of the state file like the real daemon does.
for (;;) { try { fs.mkdirSync(file + '.lock'); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } }
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args.join(' '));
const done = (out = '', code = 0) => { fs.writeFileSync(file, JSON.stringify(state)); fs.rmdirSync(file + '.lock'); process.stdout.write(out); process.exit(code); };
if (args[0] !== '-s' || !args[1] || args[2] !== 'shell') { process.stderr.write('error: device not pinned'); done('', 1); }
const [command, ...rest] = args.slice(3);
const line = rest.join(' ');
if (state.failOn.some(text => (command + ' ' + line).includes(text))) { process.stderr.write('error: injected failure'); done('', 1); }
if (command === 'wm') {
  const [what, value] = rest, key = what;
  if (value === undefined) {
    const physical = what === 'size' ? 'Physical size: 1080x2340\\n' : 'Physical density: 420\\n';
    done(physical + (state[key] === null ? '' : 'Override ' + key + ': ' + state[key] + '\\n'));
  }
  state[key] = value === 'reset' ? null : (key === 'density' ? Number(value) : value);
  done();
}
if (command === 'cmd' && rest[0] === 'overlay' && rest[1] === 'list') {
  done(['threebutton', 'twobutton', 'gestural'].map(name => (state.navigation === name ? '[x] ' : '[ ] ') + 'com.android.internal.systemui.navbar.' + name).join('\\n') + '\\n');
}
if (command === 'cmd' && rest[1] === 'enable-exclusive') { state.navigation = rest[3].split('.').pop(); done(); }
if (command === 'settings') {
  const [verb, namespace, key, value] = rest, name = namespace + '.' + key;
  if (verb === 'get') done((state.settings[name] ?? 'null') + '\\n');
  if (verb === 'put') state.settings[name] = value; else delete state.settings[name];
  done();
}
if (command === 'ime') { state.settings['secure.default_input_method'] = rest[1]; done(); }
if (command === 'pm') { state.permissions[rest[4]] = rest[0] === 'grant'; done(); }
if (command === 'dumpsys') {
  done('Packages:\\n  Package [app.lazysh.client]\\n    User 0: ceDataInode=1\\n      runtime permissions:\\n' +
    Object.entries(state.permissions).map(([name, granted]) => '        ' + name + ': granted=' + granted + ', flags=[ ]\\n').join('') + '    install permissions:\\n');
}
process.stderr.write('error: unknown command ' + command); done('', 1);
`;

export async function createFakeAdb(device = initialDevice()) {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-fake-adb-'));
  const binary = join(directory, 'adb'), state = join(directory, 'device.json');
  await writeFile(binary, SCRIPT);
  await chmod(binary, 0o700);
  await writeFile(state, JSON.stringify(device));
  process.env.FAKE_ADB_STATE = state;
  return {
    directory, binary,
    read: async () => JSON.parse(await readFile(state, 'utf8')) as FakeDevice,
    write: (next: FakeDevice) => writeFile(state, JSON.stringify(next)),
  };
}
