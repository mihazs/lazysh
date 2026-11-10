# Optional expiring file sharing

lazysh normally transfers attachments privately to the SSH host. **Sharing** is a separate, opt-in service for files that need a URL. Configure your own HTTPS service and management token, choose a file and expiry, then explicitly upload it. No service is configured by default, and selecting an SSH attachment does not publish it.

The client keeps the management token in the platform credential vault. It never returns that token to the frontend, writes it into settings, includes it in download links, or follows service redirects. File bytes cross native IPC in ordered chunks of at most 256 KiB, with at most two pending/sending files and 20 MiB of native buffers. Pending uploads expire after two minutes without progress. Cancel stops the request; if the service already accepted it, refresh sharing history and delete it there. Forgetting service credentials removes enrollment from this device and cancels pending work; it does not delete remote shares.

Downloads are public to anyone holding the unguessable URL until expiry or deletion. Expiry prevents new downloads immediately; a cleanup task removes expired objects within the next minute. It cannot retract bytes already downloaded. History and deletion require the management token. The service's wall clock must be correct for expiry timestamps.

Image history offers an explicit **Load thumbnail** action for PNG, JPEG, GIF and simple VP8/VP8L WebP files up to 2 MiB. It downloads only from the configured service, without sending the management token, and checks source dimensions before decoding (8 megapixels and 8192 pixels per side). GIF frame dimensions are checked independently of its logical canvas. Extended/animated WebP and additional WebP metadata chunks are rejected before constructing a decoder, because the decoder's generic limits do not cover every nested allocation. These originals remain shareable and downloadable. One preview operation runs at a time. The native client preserves image orientation, converts the first frame to a static PNG no larger than 256×256, and keeps smaller originals small. The WebView receives only this sanitized thumbnail through IPC and displays a local Blob URL, revoked on hide, expiry, refresh or close. SVG and HTML are never previewed. Decoder allocation limits are also requested; actual platform memory and responsiveness still require device measurements.

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

See [http contract](reference/sharing-service.md#http-contract) for details.

## Design and verification boundary

See the [sharing design](explanation/sharing.md) and [verification boundary](reference/sharing-service.md#design-and-verification-boundary).

Rollback is stopping the service and forgetting its client enrollment. Preserve the private data directory if existing unexpired links must continue working after restart; deleting it destroys those shared copies. The original SSH attachment path remains independent.
