import {afterEach, expect, test} from 'bun:test';
import {access} from 'node:fs/promises';
import {request} from 'node:https';
import type {Adb} from './device';
import {ROOT_FILE, distrustOwnedCa, reversePort, startOwnedWebdav, trustOwnedCa, type OwnedWebdav} from './webdav';

const started: OwnedWebdav[] = [];
const start = async () => { const webdav = await startOwnedWebdav(); started.push(webdav); return webdav; };
afterEach(async () => { for (const webdav of started.splice(0)) await webdav.stop(); });

interface Reply {status: number; etag?: string; body: Buffer}
/** One HTTPS request to the fixture; `ca` is what the client trusts, as the app trusts only the root it is given. */
function call(webdav: OwnedWebdav, method: string, name: string, options: {ca?: string; headers?: Record<string, string>; body?: Buffer; authorized?: boolean} = {}) {
  const authorization = `Basic ${Buffer.from(`${webdav.username}:${webdav.password}`).toString('base64')}`;
  return new Promise<Reply>((resolve, reject) => {
    const req = request(`${webdav.url}${name}`, {method, ca: options.ca ?? webdav.ca, headers: {...(options.authorized === false ? {} : {authorization}), ...options.headers}}, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode ?? 0, etag: res.headers.etag, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('a client that holds the owned CA reads and writes only with the account, and only the two resource-shaped names', async () => {
  const webdav = await start();
  expect((await call(webdav, 'GET', 'lazysh-settings-v1.age', {authorized: false})).status).toBe(401);
  expect((await call(webdav, 'GET', '../etc/passwd')).status).toBe(404);
  expect((await call(webdav, 'DELETE', 'lazysh-settings-v1.age')).status).toBe(405);
  expect((await call(webdav, 'GET', 'lazysh-settings-v1.age')).status).toBe(404);
  expect(webdav.requests.map(({method, status}) => `${method} ${status}`)).toEqual(['GET 401', 'GET 404', 'DELETE 405', 'GET 404']);
  expect(webdav.objects.size).toBe(0);
});

test('writes are conditional on the version they replace and answer with a strong ETag', async () => {
  const webdav = await start();
  const put = (body: string, headers: Record<string, string>) => call(webdav, 'PUT', 'lazysh-settings-v1.age', {headers, body: Buffer.from(body)});
  expect((await put('first', {})).status).toBe(412);
  const created = await put('first', {'If-None-Match': '*'});
  expect(created.status).toBe(201);
  expect(created.etag).toMatch(/^"[0-9a-f]{32}"$/);
  expect((await put('lost race', {'If-None-Match': '*'})).status).toBe(412);
  expect((await put('stale', {'If-Match': '"stale"'})).status).toBe(412);
  expect((await call(webdav, 'GET', 'lazysh-settings-v1.age')).body.toString()).toBe('first');
  const updated = await put('second', {'If-Match': created.etag!});
  expect(updated.status).toBe(204);
  expect(updated.etag).not.toBe(created.etag);
  expect(await call(webdav, 'GET', 'lazysh-settings-v1.age')).toMatchObject({status: 200, etag: updated.etag, body: Buffer.from('second')});
  expect([...webdav.objects.keys()]).toEqual(['lazysh-settings-v1.age']);
});

test('a body past 8 MiB is refused and stores nothing', async () => {
  const webdav = await start();
  const reply = await call(webdav, 'PUT', 'lazysh-settings-v1.age', {headers: {'If-None-Match': '*'}, body: Buffer.alloc(8 * 1024 * 1024 + 1)});
  expect(reply.status).toBe(413);
  expect(webdav.objects.size).toBe(0);
});

test('a client that holds a different CA is refused before any HTTP request reaches the server', async () => {
  const [webdav, other] = [await start(), await start()];
  await expect(call(webdav, 'GET', 'lazysh-settings-v1.age', {ca: other.ca})).rejects.toThrow();
  expect(webdav.requests).toEqual([]);
});

test('stopping frees the port and removes the generated keys', async () => {
  const webdav = await startOwnedWebdav();
  await webdav.stop();
  await expect(call(webdav, 'GET', 'lazysh-settings-v1.age')).rejects.toThrow();
  await expect(access(webdav.caFile)).rejects.toThrow();
});

const recorder = (failing: string[] = []) => {
  const calls: string[][] = [];
  const adb: Adb = async (...args) => {
    calls.push(args);
    if (failing.some(text => args.join(' ').includes(text))) throw new Error('adb failed\nsecond line');
    return '';
  };
  return {adb, calls};
};

test('the owned CA is left for the app through run-as and adb push, and one working route is enough', async () => {
  const webdav = {ca: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', caFile: '/tmp/ca.pem'};
  const all = recorder();
  await trustOwnedCa(all.adb, webdav);
  const external = `/sdcard/Android/data/app.lazysh.client/files`, shared = `/data/local/tmp/app.lazysh.client.${ROOT_FILE}`;
  expect(all.calls.slice(1)).toEqual([
    ['shell', 'mkdir', '-p', external], ['push', '/tmp/ca.pem', `${external}/${ROOT_FILE}`],
    ['push', '/tmp/ca.pem', shared], ['shell', 'chmod', '644', shared],
  ]);
  const [shell, script] = all.calls[0];
  expect([shell, script.startsWith('run-as app.lazysh.client sh -c ')]).toEqual(['shell', true]);
  expect(Buffer.from(/echo (\S+) \|/.exec(script)![1], 'base64').toString()).toBe(webdav.ca);
  await trustOwnedCa(recorder(['run-as']).adb, webdav);
  await trustOwnedCa(recorder(['/sdcard/', 'chmod']).adb, webdav);
  await expect(trustOwnedCa(recorder(['run-as', 'push']).adb, webdav)).rejects.toThrow('could not be left for the app (run-as: adb failed; external files: adb failed; local tmp: adb failed)');
});

test('the guest port is forwarded without rebinding and the forward can be removed', async () => {
  const {adb, calls} = recorder();
  const release = await reversePort(adb, 4455);
  await release();
  expect(calls).toEqual([['reverse', '--no-rebind', 'tcp:4455', 'tcp:4455'], ['reverse', '--remove', 'tcp:4455']]);
});

test('what the shared guest keeps of the owned CA is removed by name', async () => {
  const {adb, calls} = recorder();
  await distrustOwnedCa(adb);
  expect(calls).toEqual([['shell', 'rm', '-f', `/data/local/tmp/app.lazysh.client.${ROOT_FILE}`, `/sdcard/Android/data/app.lazysh.client/files/${ROOT_FILE}`]]);
});
