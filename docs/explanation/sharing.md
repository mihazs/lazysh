# Why sharing uses a separate service

The existing SFTP path provides private host transfer but cannot supply expiring public URLs. An external vendor account would introduce an unspecified provider and credentials. The chosen standalone, single-owner Rust service provides the requested explicit sharing boundary while reusing SQLite and native Cargo testing. Axum/Hyper handle HTTP framing; no new HTTP parser or custom runner is introduced.

See [sharing setup](../sharing.md) and the [HTTP contract](../reference/sharing-service.md#http-contract).
