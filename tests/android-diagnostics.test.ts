import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {OwnedProcess} from './support/ownedProcess';

const temporary: string[] = [];
const workflow = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/checks.yml', import.meta.url)).text()) as {
  jobs: Record<string, { needs?:string; 'runs-on'?: string; 'timeout-minutes'?: number; env?: Record<string,string>; steps: { uses?:string; name?: string; 'timeout-minutes'?: number; env?: Record<string,string>; run?: string; with?: { name?:string; path?:string; script?: string; 'env-vars'?: string } }[] }>;
};
const decoded = workflow.jobs['native-android-runtime'].steps.find(step => step.name === 'Run native Android instrumentation')!.with!.script!;
// Match emulator-runner v2's parseScript: each retained line is a separate sh -c.
const commands = decoded.trim().split(/\r\n|\n|\r/).map(line => line.trim()).filter(line => !line.startsWith('#') && line.length > 0);

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('native fixture namespaces are admitted without privilege changes before Linux tests or Android boot', () => {
  expect(workflow.jobs['native-linux']['runs-on']).toBe('ubuntu-22.04');
  expect(workflow.jobs['native-android-runtime']['runs-on']).toBe(workflow.jobs['native-linux']['runs-on']);
  const linux = workflow.jobs['native-linux'].steps;
  const admission = linux.findIndex(step => step.name === 'Verify native GUI namespace prerequisites');
  expect(linux[admission].env?.LAZYSH_NATIVE_NAMESPACE_NETWORK).toBe('private');
  expect(linux[admission].run).toContain('namespace_command=(bwrap --unshare-user --unshare-net --dev-bind / / -- bwrap --unshare-user --unshare-net)');
  expect(linux[admission].run).toContain('"${namespace_command[@]}" --unshare-pid --dev-bind / / --proc /proc');
  expect(linux[admission].run).toContain('--ro-bind /etc/group /etc/group');
  expect(linux[admission].run).toContain('test "$(id -u)" -ne 0');
  const owner = linux.findIndex(step => step.run?.includes('LAZYSH_TEST_SSH_USER_NAMESPACE=1'));
  expect(owner).toBeGreaterThan(admission);
  expect(linux[owner].run).toContain("bun test tests/android-ssh-host.test.ts --test-name-pattern 'owned namespaced SSH'");
  const android=workflow.jobs['native-android-runtime'].steps;
  const dependencies=android.findIndex(step=>step.name==='Install native Mosh fixture dependencies');
  const namespace=android.findIndex(step=>step.name===linux[admission].name);
  const emulator=android.findIndex(step=>step.name==='Run native Android instrumentation');
  expect(android[dependencies].run).toContain('mosh bubblewrap');
  expect(namespace).toBeGreaterThan(dependencies);
  expect(emulator).toBeGreaterThan(namespace);
  expect(android[namespace].env?.LAZYSH_NATIVE_NAMESPACE_NETWORK).toBe('shared');
  expect(android[namespace].run).toBe(linux[admission].run);
  expect(decoded).toContain('test:android-ssh');
});

test('independent Android auxiliary owners have their own finite native job and unchanged prerequisites',()=>{
  const guarded=workflow.jobs['native-android-runtime'],auxiliary=workflow.jobs['native-android-auxiliary'];
  expect(auxiliary).toBeDefined();
  expect(auxiliary['timeout-minutes']).toBe(30);
  expect(auxiliary['runs-on']).toBe('ubuntu-24.04');
  expect(auxiliary.needs).toBeUndefined();
  expect(auxiliary.env).toEqual({ANDROID_SERIAL:'emulator-5580',LAZYSH_ANDROID_RUNTIME_OWNER:'auxiliary',VITE_LAZYSH_QR_CAMERA_TRACE:'1'});
  for(const name of ['Grant this runner access to KVM','Run native Android instrumentation'])
    expect(auxiliary.steps.find(step=>step.name===name)).toEqual(guarded.steps.find(step=>step.name===name));
  expect(auxiliary.steps.some(step=>step.name==='Install native Mosh fixture dependencies'||step.name==='Verify native GUI namespace prerequisites'||step.name==='Build the pinned official Mosh fixture outside the checkout'||step.name==='Build real companion and receiver for owned Android cases'||step.uses==='actions/download-artifact@v4')).toBe(false);
  const outputs=[guarded,auxiliary,workflow.jobs['native-android-herdr-navigation']].map(job=>job.steps.find(step=>step.uses==='actions/upload-artifact@v4')!.with!);
  expect(new Set(outputs.map(output=>output.name)).size).toBe(3);
  expect(outputs[1].name).toBe('lazysh-android-auxiliary-results');
  expect(outputs[1].path).toBe(outputs[0].path);
});

test.skipIf(process.platform!=='linux')('decoded Android toolchain fingerprint separates host glibc and architecture for every cache caller',async()=>{
  const name='Fingerprint Android native build tools';
  const script=workflow.jobs['native-android'].steps.find(step=>step.name===name)!.run!;
  for(const job of ['native-android','native-android-runtime','native-android-herdr-navigation','native-android-auxiliary','native-android-ntfy']) {
    const steps=workflow.jobs[job].steps;
    const fingerprint=steps.findIndex(step=>step.name===name);
    const cache=steps.findIndex(step=>step.with?.['env-vars']==='LAZYSH_ANDROID_TOOLCHAIN');
    expect(fingerprint).toBeGreaterThanOrEqual(0);
    expect(cache).toBeGreaterThan(fingerprint);
    expect(steps[fingerprint].run).toBe(script);
  }
  const directory=await mkdtemp(join(tmpdir(),'lazysh-android-host-abi-'));temporary.push(directory);
  const bin=join(directory,'bin'),ndk=join(directory,'ndk'),environmentFile=join(directory,'environment');
  for(const [path,body] of [
    [join(bin,'cmake'),'test "$1" = --version || exit 9; printf "same cmake\\n"'],
    [join(ndk,'toolchains/llvm/prebuilt/linux-x86_64/bin/clang'),'test "$1" = --version || exit 9; printf "same clang\\n"'],
    [join(bin,'getconf'),'test "$1" = GNU_LIBC_VERSION || exit 9; printf "%s\\n" "$LAZYSH_TEST_HOST_GLIBC"'],
    [join(bin,'uname'),'test "$1" = -m || exit 9; printf "%s\\n" "$LAZYSH_TEST_HOST_ARCH"'],
  ]) {
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,'#!/bin/sh\n'+body+'\n',{mode:0o700});
  }
  const fingerprint=async(glibc:string,architecture:string)=>{
    await rm(environmentFile,{force:true});
    const child=new OwnedProcess('/bin/bash',['-e','-o','pipefail','-c',script],directory,
      {...process.env,PATH:bin+':'+process.env.PATH,NDK_HOME:ndk,GITHUB_ENV:environmentFile,
        LAZYSH_TEST_HOST_GLIBC:glibc,LAZYSH_TEST_HOST_ARCH:architecture});
    await child.finish('decoded Android toolchain fingerprint',5000);
    const match=/^LAZYSH_ANDROID_TOOLCHAIN=([a-f0-9]{64})\n$/.exec(await readFile(environmentFile,'utf8'));
    expect(match!==null).toBe(true);
    return match![1];
  };
  const baseline=await fingerprint('glibc 2.35','x86_64');
  expect(await fingerprint('glibc 2.39','x86_64')).not.toBe(baseline);
  expect(await fingerprint('glibc 2.35','aarch64')).not.toBe(baseline);
  expect(await fingerprint('glibc 2.35','x86_64')).toBe(baseline);
});

test.skipIf(process.platform!=='linux').each([undefined,'private-secret-mode'])('decoded namespace prerequisite rejects invalid mode %s without leaking its value',async mode=>{
  const script=workflow.jobs['native-android-runtime'].steps.find(step=>step.name==='Verify native GUI namespace prerequisites')!.run!;
  const environment={...process.env};
  if(mode===undefined)delete environment.LAZYSH_NATIVE_NAMESPACE_NETWORK;
  else environment.LAZYSH_NATIVE_NAMESPACE_NETWORK=mode;
  const child=new OwnedProcess('/bin/bash',['-e','-o','pipefail','-c',script],undefined,environment);
  await expect(child.finish('invalid namespace mode',5000)).rejects.toThrow('Owned fixture failed: invalid namespace mode; exit=1');
  expect(child.stderr.trim()).toBe('Unsupported native fixture namespace mode');
  expect(child.stdout).toBe('');
});

test('packaged companion UI acceptance has an explicit owned Android invocation',async()=>{
  expect(workflow.jobs['native-android-runtime'].env?.LAZYSH_ANDROID_UI_COMPANION).toBe('1');
  expect(decoded).toContain('test:android-ssh');
  const pkg=await Bun.file(new URL('../apps/client/package.json',import.meta.url)).json();
  expect(pkg.scripts['test:android']).toContain('NativeWorkspaceTest#ownedCompanionInstallsThroughRealUi');
  const gradle=await Bun.file(new URL('../apps/client/src-tauri/gen/android/app/build.gradle.kts',import.meta.url)).text();
  expect(gradle).toContain('lazyshCompanionAcceptance');
  expect(gradle).toContain('outputs/androidTest-results/companion-ui');
});

test('Android and Linux share the guarded official Mosh producer before emulator boot',async()=>{
  const name='Build the pinned official Mosh fixture outside the checkout';
  const producer=workflow.jobs['native-linux'].steps.find(step=>step.name===name)!;
  const android=workflow.jobs['native-android-runtime'].steps;
  const build=android.findIndex(step=>step.name===name);
  expect(android[build]).toEqual(producer);
  expect(build).toBeGreaterThan(android.findIndex(step=>step.name==='Verify native GUI namespace prerequisites'));
  expect(android.findIndex(step=>step.name==='Run native Android instrumentation')).toBeGreaterThan(build);
  expect(producer['timeout-minutes']).toBe(10);
  expect(workflow.jobs['native-android-runtime']['timeout-minutes']).toBe(30);
  expect(producer.run).toContain("--proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 120 --max-filesize 2097152");
  expect(producer.run).toContain('872e4b134e5df29c8933dff12350785054d2fd2839b5ae6b5587b14db1465ddd');
  expect(producer.run).toContain('sha256sum --check --strict');
  expect(producer.run).toContain("= 'mosh-server (mosh 1.4.0) [build mosh 1.4.0]'");
  expect(producer.run).toContain('LAZYSH_NATIVE_MOSH_SERVER=$mosh_root/install/bin/mosh-server');
  expect(producer.run).toContain('echo "$mosh_root/install/bin" >> "$GITHUB_PATH"');
  expect(android.find(step=>step.name==='Install native Mosh fixture dependencies')!.run).toContain('libncurses-dev');
  const tasks=(await Bun.file(new URL('../turbo.json',import.meta.url)).json()).tasks;
  for(const task of ['test:android-ssh','test:native-gui'])expect(tasks[task].passThroughEnv).toContain('LAZYSH_NATIVE_MOSH_SERVER');
});

test('actual Turbo task forwards pinned Mosh path, companion opt-in and hosted metadata while filtering unrelated environment',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-android-turbo-'));temporary.push(directory);
  const client=join(directory,'apps/client');await mkdir(client,{recursive:true});
  const config=await Bun.file(new URL('../turbo.json',import.meta.url)).json();
  const pkg=await Bun.file(new URL('../package.json',import.meta.url)).json();
  await writeFile(join(directory,'package.json'),JSON.stringify({name:'owned-android-env',private:true,packageManager:pkg.packageManager,workspaces:['apps/*']}));
  await writeFile(join(client,'package.json'),JSON.stringify({name:'@lazysh/client',version:'0.0.0',scripts:{'test:android-ssh':'bun env-probe.ts'}}));
  const keys=['LAZYSH_ANDROID_UI_COMPANION','LAZYSH_NATIVE_MOSH_SERVER','GITHUB_ACTIONS','RUNNER_ENVIRONMENT'];
  await writeFile(join(client,'env-probe.ts'),`await Bun.write('../../observed.json',JSON.stringify({values:${JSON.stringify(keys)}.map(key=>process.env[key]??null),unrelatedFiltered:process.env.LAZYSH_UNRELATED_SENTINEL===undefined}));`);
  for(const admitted of [true,false]) {
    const task={...config.tasks['test:android-ssh']};
    if(!admitted)task.passThroughEnv=task.passThroughEnv.filter((key:string)=>!['LAZYSH_ANDROID_UI_COMPANION','LAZYSH_NATIVE_MOSH_SERVER'].includes(key));
    await writeFile(join(directory,'turbo.json'),JSON.stringify({...config,tasks:{...config.tasks,'test:android-ssh':task}}));
    await rm(join(directory,'observed.json'),{force:true});
    const child=new OwnedProcess(process.execPath,[join(import.meta.dir,'../node_modules/turbo/bin/turbo'),'run','test:android-ssh','--filter=@lazysh/client','--only'],directory,
      {PATH:process.env.PATH,HOME:directory,CI:'true',TURBO_TELEMETRY_DISABLED:'1',LAZYSH_ANDROID_UI_COMPANION:'1',LAZYSH_NATIVE_MOSH_SERVER:'/owned/pinned/mosh-server',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',LAZYSH_UNRELATED_SENTINEL:'must-stay-filtered'});
    await child.finish('actual Turbo task environment',10_000);
    expect(JSON.parse(await readFile(join(directory,'observed.json'),'utf8'))).toEqual({values:[admitted?'1':null,admitted?'/owned/pinned/mosh-server':null,'true','github-hosted'],unrelatedFiltered:true});
  }
},25_000);

test.each([
  { owner:'guarded', mosh:0, instrumentation:0, qr:29, fdroid:41, sdk:31, diagnosticFailure:false, overflow:false },
  { mosh:37, instrumentation:0, qr:0, fdroid:0, sdk:0, diagnosticFailure:true, overflow:false },
  { mosh:0, instrumentation:23, qr:0, fdroid:0, sdk:0, diagnosticFailure:true, overflow:false },
  { mosh:0, instrumentation:23, qr:0, fdroid:0, sdk:0, diagnosticFailure:false, overflow:true },
  { mosh:37, instrumentation:23, qr:0, fdroid:41, sdk:0, diagnosticFailure:true, overflow:false },
  { owner:'auxiliary', mosh:37, instrumentation:23, qr:0, fdroid:0, sdk:0, diagnosticFailure:false, overflow:false },
  { owner:'auxiliary', mosh:0, instrumentation:0, qr:29, fdroid:0, sdk:0, diagnosticFailure:true, overflow:false },
  { owner:'auxiliary', mosh:0, instrumentation:0, qr:0, fdroid:41, sdk:0, diagnosticFailure:true, overflow:false },
  { owner:'auxiliary', mosh:0, instrumentation:0, qr:0, fdroid:0, sdk:31, diagnosticFailure:true, overflow:false },
  { owner:'auxiliary', mosh:0, instrumentation:0, qr:29, fdroid:41, sdk:31, diagnosticFailure:false, overflow:true },
  { owner:'herdr-navigation', mosh:0, instrumentation:0, qr:0, fdroid:0, sdk:0, diagnosticFailure:false, overflow:false },
  { owner:'herdr-navigation', mosh:0, instrumentation:23, qr:0, fdroid:0, sdk:0, diagnosticFailure:true, overflow:false },
  { owner:'unknown', mosh:0, instrumentation:0, qr:0, fdroid:0, sdk:0, diagnosticFailure:true, overflow:false },
  { owner:'', mosh:0, instrumentation:0, qr:0, fdroid:0, sdk:0, diagnosticFailure:true, overflow:false },
])('emulator script preserves exits and reaps collector: %j', async ({ owner = 'guarded', mosh, instrumentation, qr, fdroid, sdk, diagnosticFailure, overflow }) => {
  expect(commands).toHaveLength(1);
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-android-diagnostics-'));
  temporary.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const marker = join(directory, 'collector.pid');
  const invocations = join(directory, 'invocations.txt');
  const fakeBun = join(bin, 'bun');
  const fakeAdb = join(bin, 'adb');
  const fakeCargo = join(bin, 'cargo');
  const sdkSerial = join(directory, 'sdk-serial.txt');
  const sdkArguments = join(directory, 'sdk-arguments.bin');
  const qrPidFile = join(directory, 'qr-pid-file.txt');
  await writeFile(fakeBun, `#!/bin/bash
for ((attempt=0; attempt<100; attempt++)); do
  test -f "$COLLECTOR_PID" && break
  sleep 0.01
done
test -f "$COLLECTOR_PID" || exit 88
printf '%s\\n' "$*" >> "$INVOCATIONS"
if [[ "$2" == test:android-mosh ]]; then exit "$MOSH_EXIT"; fi
if [[ "$2" == test:android-fdroid ]]; then exit "$FDROID_EXIT"; fi
if [[ "$2" == test:android-qr ]]; then
  printf '%s\\n' "$LAZYSH_ANDROID_QR_EMULATOR_PID_FILE" > "$QR_PID_FILE"
  exit "$QR_EXIT"
fi
exit "$INSTRUMENTATION_EXIT"
`);
  await writeFile(fakeAdb, `#!/bin/bash
if [[ "$1" == logcat ]]; then
  printf '%s\\n' "$$" > "$COLLECTOR_PID"
  printf 'ActivityManager: bounded fixture collector\\n'
  exec sleep 1800
fi
if [[ "$DIAGNOSTIC_FAILURE" == 1 ]]; then exit 79; fi
if [[ "$DIAGNOSTIC_OVERFLOW" == 1 && "$*" == *lastanr-traces ]]; then exec yes native-frame; fi
printf 'native diagnostic fixture\\n'
`);
  await writeFile(fakeCargo, `#!/bin/bash
printf 'cargo %s\\n' "$*" >> "$INVOCATIONS"
printf '%s\\n' "$LAZYSH_TEST_ANDROID_SERIAL" > "$SDK_SERIAL"
printf '%s\\0' "$@" > "$SDK_ARGUMENTS"
exit "$SDK_EXIT"
`);
  await Promise.all([fakeBun, fakeAdb, fakeCargo].map(path => chmod(path, 0o755)));
  const child = Bun.spawn(['sh', '-c', commands[0]], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLECTOR_PID: marker, INVOCATIONS: invocations,
      MOSH_EXIT: String(mosh), INSTRUMENTATION_EXIT: String(instrumentation), QR_EXIT: String(qr), FDROID_EXIT: String(fdroid), SDK_EXIT: String(sdk),
      ANDROID_SERIAL: 'emulator-5580', LAZYSH_ANDROID_RUNTIME_OWNER: owner, SDK_SERIAL: sdkSerial, SDK_ARGUMENTS: sdkArguments,
      RUNNER_TEMP: directory, QR_PID_FILE: qrPidFile,
      DIAGNOSTIC_FAILURE: diagnosticFailure ? '1' : '0',
      DIAGNOSTIC_OVERFLOW: overflow ? '1' : '0' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const expectedExit = owner==='guarded' ? mosh || instrumentation : owner==='auxiliary' ? fdroid || qr || sdk : owner==='herdr-navigation' ? instrumentation : 1;
  expect(exit).toBe(expectedExit);
  expect(stdout).toBe('');
  if (!overflow) expect(stderr).toBe(['guarded','auxiliary','herdr-navigation'].includes(owner)?'':'Unknown Android runtime owner\n');
  const qrExpected = owner === 'auxiliary' && fdroid === 0;
  const sdkExpected = qrExpected && qr === 0;
  expect(await Bun.file(qrPidFile).exists()).toBe(qrExpected);
  if (qrExpected) expect(await readFile(qrPidFile, 'utf8')).toBe(`${directory}/lazysh-qr-emulator.pid\n`);
  const actualInvocations=await Bun.file(invocations).exists()?(await readFile(invocations,'utf8')).trim().split('\n'):[];
  expect(actualInvocations).toEqual(owner==='herdr-navigation'?['run test:android-herdr-navigation']:owner==='guarded'?[
    'run test:android-mosh',...(mosh===0?['run test:android-ssh']:[]),
  ]:owner==='auxiliary'?[
    'run test:android-fdroid',...(qrExpected?['run test:android-qr']:[]),
    ...(sdkExpected?['cargo test --locked -p lazysh-agent --lib devices::tests::android_owned_emulator_inventory_and_screenshot -- --ignored --exact --nocapture']:[]),
  ]:[]);
  expect(await Bun.file(sdkSerial).exists()).toBe(sdkExpected);
  expect(await Bun.file(sdkArguments).exists()).toBe(sdkExpected);
  if (sdkExpected) {
    expect(await readFile(sdkSerial, 'utf8')).toBe('emulator-5580\n');
    expect((await readFile(sdkArguments, 'utf8')).split('\0')).toEqual([
      'test', '--locked', '-p', 'lazysh-agent', '--lib',
      'devices::tests::android_owned_emulator_inventory_and_screenshot',
      '--', '--ignored', '--exact', '--nocapture', '',
    ]);
  }
  const pid = Number((await readFile(marker, 'utf8')).trim());
  expect(pid).toBeGreaterThan(1);
  expect(() => process.kill(pid, 0)).toThrow();
  const diagnostics = join(directory, 'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results/system-diagnostics');
  const files = await readdir(diagnostics);
  expect(files.length).toBe(expectedExit ? 8 : 4);
  const status = await readFile(join(diagnostics, 'status.txt'), 'utf8');
  for (const name of files) expect((await stat(join(diagnostics, name))).size).toBeLessThanOrEqual(1024 * 1024);
  expect(status).toContain(`test exit=${expectedExit}`);
  expect(status).toContain('collector exit=143');
  if (diagnosticFailure) {
    for (const name of ['start-load', 'lastanr', 'lastanr-traces', 'cpu-load', 'kernel-load']) {
      expect(status).toContain(`${name} exit=79`);
    }
  }
  if (overflow) {
    expect((await stat(join(diagnostics, 'lastanr-traces.txt'))).size).toBe(1024 * 1024);
    expect(status).toContain('lastanr-traces exit=153');
  }
});
