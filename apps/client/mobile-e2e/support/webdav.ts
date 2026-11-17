import {execFile} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer, type Server} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {APP_PACKAGE, type Adb} from './device';

// An owned WebDAV server for the encrypted-sync acceptance case. The app only ever sends GET and conditional PUT of two
// fixed resource names with HTTP Basic credentials, so that is the whole of what this serves: strong ETags, `If-Match` and
// `If-None-Match: *` preconditions, an 8 MiB body limit and an account gate. It is not a general WebDAV provider (no PROPFIND,
// no locks, no collections). TLS comes from a CA generated per run, so the only trust the app is given is that one root.

const exec = promisify(execFile);
const LIMIT = 8 * 1024 * 1024;
export const FOLDER = '/lazysh/';
/** The file the debug acceptance build reads its extra root from (apps/client/src-tauri/src/sync.rs). */
export const ROOT_FILE = 'sync-test-ca.pem';

export interface Stored {body: Buffer; etag: string}
/** One request the server saw. Credentials and bodies are never recorded. */
export interface Seen {method: string; name: string; status: number}
export interface OwnedWebdav {
  /** The folder URL to type into the app, `https://127.0.0.1:<port>/lazysh/`. */
  url: string;
  port: number;
  username: string;
  /** The app password; a secret, so never log it or leave it on a captured screen. */
  password: string;
  /** PEM of the owned CA, and the file it was written to (for `adb push`). */
  ca: string;
  caFile: string;
  objects: Map<string, Stored>;
  requests: Seen[];
  stop(): Promise<void>;
}

const openssl = (...args: string[]) => exec(process.env.OPENSSL || 'openssl', args, {timeout: 20_000});

/** A CA and a server certificate for the literal 127.0.0.1, written under `directory`. */
async function issue(directory: string) {
  const file = (name: string) => join(directory, name);
  const key = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  await openssl('req', '-x509', ...key, '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '2', '-subj', '/CN=lazysh owned sync CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  await openssl('req', ...key, '-keyout', file('server.key'), '-out', file('server.csr'), '-subj', '/CN=127.0.0.1');
  await writeFile(file('server.ext'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\n');
  await openssl('x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('server.pem'),
    '-days', '2', '-extfile', file('server.ext'));
  const [ca, cert, serverKey] = await Promise.all([readFile(file('ca.pem'), 'utf8'), readFile(file('server.pem')), readFile(file('server.key'))]);
  return {ca, caFile: file('ca.pem'), cert, key: serverKey};
}

export async function startOwnedWebdav(): Promise<OwnedWebdav> {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-owned-webdav-'));
  let server: Server | undefined;
  try {
    const {ca, caFile, cert, key} = await issue(directory);
    const username = 'owned', password = randomBytes(12).toString('hex');
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const objects = new Map<string, Stored>(), requests: Seen[] = [];
    server = createServer({cert, key}, (req, res) => {
      const name = req.url?.startsWith(FOLDER) ? req.url.slice(FOLDER.length) : '';
      const reply = (status: number, headers: Record<string, string | number> = {}, body?: Buffer) => {
        requests.push({method: req.method ?? '', name, status});
        res.writeHead(status, status === 204 ? headers : {'Content-Length': body?.length ?? 0, ...headers});
        res.end(body);
      };
      if (req.headers.authorization !== authorization) { req.resume(); return reply(401, {'WWW-Authenticate': 'Basic realm="lazysh"'}); }
      if (!/^[a-z0-9.-]+$/.test(name)) { req.resume(); return reply(404); }
      const current = objects.get(name);
      if (req.method === 'GET') return current ? reply(200, {ETag: current.etag, 'Content-Type': 'application/octet-stream'}, current.body) : reply(404);
      if (req.method !== 'PUT') { req.resume(); return reply(405, {Allow: 'GET, PUT'}); }
      // A write must name the version it replaces, or `*` for a new resource; anything else lost a race.
      if (!(current ? req.headers['if-match'] === current.etag : req.headers['if-none-match'] === '*')) { req.resume(); return reply(412); }
      const chunks: Buffer[] = [];
      let length = 0;
      req.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length <= LIMIT) chunks.push(chunk);
      });
      req.on('end', () => {
        if (length > LIMIT) return reply(413);
        const body = Buffer.concat(chunks), etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
        objects.set(name, {body, etag});
        reply(current ? 204 : 201, {ETag: etag});
      });
    });
    const listening = server;
    await new Promise<void>((resolve, reject) => { listening.once('error', reject); listening.listen(0, '127.0.0.1', resolve); });
    const port = (listening.address() as {port: number}).port;
    return {
      url: `https://127.0.0.1:${port}${FOLDER}`, port, username, password, ca, caFile, objects, requests,
      stop: async () => {
        try {
          // Idle keep-alive sockets would hold close() open; closing an already stopped server is not an error.
          await new Promise<void>(resolve => { listening.close(() => resolve()); listening.closeAllConnections(); });
        } finally { await rm(directory, {recursive: true, force: true}); }
      },
    };
  } catch (error) {
    server?.close();
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
}

/** Routes the guest's 127.0.0.1:`port` to the host, like the owned SSH hosts. Returns what removes the forward. */
export async function reversePort(adb: Adb, port: number) {
  // --no-rebind: never replace a forward somebody else owns.
  await adb('reverse', '--no-rebind', `tcp:${port}`, `tcp:${port}`);
  return async () => { await adb('reverse', '--remove', `tcp:${port}`); };
}

/** Leaves the owned CA in the disposable emulator's private app data. Clearing that data removes it. */
export async function trustOwnedCa(adb: Adb, webdav: Pick<OwnedWebdav, 'ca'>) {
  const encoded = Buffer.from(webdav.ca).toString('base64');
  await adb('shell', `run-as ${APP_PACKAGE} sh -c 'set -C; echo ${encoded} | base64 -d > ${ROOT_FILE}'`);
}
