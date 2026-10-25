# Optional expiring file sharing

lazysh normally transfers attachments privately to the SSH host. **Sharing** is a separate, opt-in service for files that need a URL. Configure your own HTTPS service and management token, choose a file and expiry, then explicitly upload it. No service is configured by default, and selecting an SSH attachment does not publish it.

The client keeps the management token in the platform credential vault. It never returns that token to the frontend, writes it into settings, includes it in download links, or follows service redirects. File bytes cross native IPC in ordered chunks of at most 256 KiB, with at most two pending/sending files and 20 MiB of native buffers. Pending uploads expire after two minutes without progress. Cancel stops the request; if the service already accepted it, refresh sharing history and delete it there. Forgetting service credentials removes enrollment from this device and cancels pending work; it does not delete remote shares.

Downloads are public to anyone holding the unguessable URL until expiry or deletion. Expiry prevents new downloads immediately; a cleanup task removes expired objects within the next minute. It cannot retract bytes already downloaded. History and deletion require the management token. The service's wall clock must be correct for expiry timestamps.

## Run the optional Rust service

`apps/share-service` is a standalone Rust application in the Bun/Turborepo and Cargo workspaces. Native tasks use Cargo; there is no custom test runner or service deployment script.

```sh
bunx turbo run build --filter=@lazysh/share-service
target/release/lazysh-share keygen
```

Save the generated token in a private regular file. On Unix, the token file must have mode `0600` or stricter. Run the service with a dedicated private data directory and the real public HTTPS origin of your proxy:

```sh
target/release/lazysh-share serve \
  --token-file /private/path/management-token \
  --data-dir /private/path/lazysh-share \
  --public-origin https://your-actual-sharing-host \
  --listen 127.0.0.1:7347
```

The origin above is a placeholder, not a provided endpoint. The service accepts only loopback listeners and has no outbound network path. Operate an HTTPS reverse proxy separately, forwarding its root path to the loopback address. The service uses its configured public origin when constructing links; it never trusts a request's `Host` or forwarded headers to select the download domain. It sends no telemetry or request logs. Treat proxy logs containing download URLs as sensitive, because those URLs are bearer capabilities.

Only one service process can use a data directory. SQLite metadata and blob files are private; startup removes abandoned service-owned blob files while retaining unrelated files. On Windows, protect the data directory and token file using the service account's filesystem ACL. Token rotation requires changing the private file and restarting the service. Existing download links remain active until deleted or expired.

## HTTP contract

Management requests use `Authorization: Bearer <management-token>`; cookies are not used and no CORS origins are enabled.

| Request | Behavior |
| --- | --- |
| `POST /v1/shares?filename=<basename>&ttlSeconds=3600` | Raw file body and a valid `Content-Type`. Returns `201` with `{schemaVersion:1, share}`. |
| `GET /v1/shares?limit=50&cursor=<opaque>` | Authenticated history, up to 100 rows per page, with `{schemaVersion:1, shares, nextCursor}`. Client pages use up to 50 rows. |
| `DELETE /v1/shares/<id>` | Authenticated deletion; returns `204`. |
| `GET /s/<id>` | Public download until expiry/deletion. Unknown and expired links return `404`. |

A share contains `id`, `name`, `mime`, `size`, `createdAt`, `expiresAt`, and `url`. IDs contain 256 random bits. Times are Unix seconds. History cursors remain usable if the preceding row was deleted.

Files are limited to 10 MiB, with 256 MiB and 1,000 objects per service. Expiry is between one minute and seven days. MIME declarations are parsed; common image and PDF declarations must match their magic bytes, and plain text must be UTF-8. Other file types remain available as downloads. All downloads use `application/octet-stream`, attachment disposition, `nosniff`, restrictive CSP and `no-store`; SVG, HTML and other fetched content are never executed in the privileged app.

The server bounds active application requests to four, streaming downloads to four, TCP connections to sixteen, headers to 64 KiB/64 fields with a five-second deadline, complete connections to sixty seconds, and request handling to twenty seconds. Download permits remain held while bodies stream. The client requires HTTPS, refuses redirects, limits JSON responses to 256 KiB, and accepts only exact configured-origin download paths.

## Design and verification boundary

The existing SFTP path provides private host transfer but cannot supply expiring public URLs. An external vendor account would introduce an unspecified provider and credentials. The chosen standalone, single-owner Rust service provides the requested explicit sharing boundary while reusing SQLite and native Cargo testing. Axum/Hyper handle HTTP framing; no new HTTP parser or custom runner is introduced.

Tests use temporary files, ephemeral loopback listeners and a test-only trusted TLS certificate. They cover upload/history/delete, MIME and metadata rejection, body and storage limits, expiry, orphan cleanup, process locking, cursor behavior, stream-lifetime limits, exact origin checks, redirects, native chunk ordering and cancellation. No user files are uploaded by these tests, and no public service is deployed. Camera permissions, real reverse-proxy operation, mobile network/lifecycle behavior and platform vault behavior still require their corresponding device/environment checks.

Rollback is stopping the service and forgetting its client enrollment. Preserve the private data directory if existing unexpired links must continue working after restart; deleting it destroys those shared copies. The original SSH attachment path remains independent.
