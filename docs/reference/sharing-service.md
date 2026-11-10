# Sharing service reference

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

The [sharing design](../explanation/sharing.md) explains the service boundary.

Tests use temporary files, ephemeral loopback listeners and a test-only trusted TLS certificate. They cover upload/history/delete, MIME and metadata rejection, body and storage limits, expiry, orphan cleanup, process locking, cursor behavior, stream-lifetime limits, exact origin checks, redirects, native chunk ordering and cancellation. No user files are uploaded by these tests, and no public service is deployed. Camera permissions, real reverse-proxy operation, mobile network/lifecycle behavior and platform vault behavior still require their corresponding device/environment checks.

For setup and usage, see [sharing](../sharing.md). Return to the [documentation map](../README.md).
