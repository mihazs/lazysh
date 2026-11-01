# Companion lifecycle event protocol and storage

`lazysh-agent ingest --agent generic` reads one bounded JSON event from standard input. `lazysh-agent snapshot --limit 50` returns the stored lifecycle snapshot; the limit accepts 1–100 and defaults to 50. The companion has no resident HTTP listener.

## Generic event

```json
{"schemaVersion":1,"sessionId":"build-1","agent":"My agent","project":"/work/app","state":"working","summary":"Running tests","paneId":"%1"}
```

| Field | Contract |
| --- | --- |
| `schemaVersion` | Required integer `1`. |
| `sessionId` | Required nonblank string, at most 256 characters. |
| `agent` | Required nonblank string, at most 80 characters. |
| `project` | Required nonblank string, at most 4096 characters. |
| `state` | Required `working`, `needs_attention` or `done`. |
| `summary` | Required nonblank string, at most 512 characters. |
| `paneId` | Optional/null; when present, nonblank string of at most 256 characters. Reported metadata, not input authority. |

String fields reject characters below U+0020. Input JSON is bounded to 256 KiB; malformed or oversized input fails. These character limits are not the byte-based SSH selector limits.

States are `working`, `needs_attention`, and `done`. Agent plus session ID identifies a row. No fields authorize remote command execution. Summaries are plain text and may contain project-sensitive information; the snapshot is visible to the authenticated SSH user. Only install hooks on hosts and agents you control.

## State directory and retention

At most 100 session summaries are retained for seven days in `events.sqlite3` in the user's state directory (`~/.local/state/lazysh` on Linux; the local application data directory on macOS/Windows). A mode-0700 directory and mode-0600 database are used on Unix. `LAZYSH_STATE_DIR` overrides that directory for testing. No original event payloads are retained. This event storage does not schedule background refresh or grant remote approval authority; [opt-in Claude approvals](../approvals.md) use a separate waiting-hook protocol.

The event Store uses SQLite WAL with explicit `synchronous=FULL` on every connection. Existing rollback-journal databases change to WAL when opened successfully; existing rows remain. This changes the storage default, without reducing the three-second ingest lock-wait budget or retrying a failed transaction. WAL still has one writer, so sufficiently slow storage can exhaust that budget and produces an explicit error. The directory must be on an admitted local filesystem; shared network filesystems are unsupported by SQLite WAL.

Admission runs before directory creation, chmod, bootstrap files or SQLite access. Linux admits ext2/3/4, Btrfs, XFS, tmpfs, ramfs, overlayfs and F2FS by kernel filesystem type; FUSE (including local FUSE implementations), network/cluster and unknown types fail closed. macOS requires the kernel's `MNT_LOCAL` flag. Windows resolves the actual volume and permits fixed, removable and RAM drives; network/unknown volumes fail. Other OS targets are unsupported. Rejection reports the fixed `UnsupportedStateFilesystem` class without migrating or changing existing data; configure a supported local state directory explicitly. These are OS-reported classifications, not a probe of storage hardware or a guarantee that remote block devices honor sync. See [Linux filesystem types](https://github.com/torvalds/linux/blob/master/include/uapi/linux/magic.h), [Darwin statfs](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html), and [Windows drive types](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew).

State paths containing a `..` component fail with `InvalidArgument` before admission or mutation. They are not lexically normalized across symlinks: a missing prefix followed by parent traversal could otherwise be admitted on one filesystem and created on another. Ambiguous Windows drive-relative paths such as `C:state` are also rejected before admission; ordinary relative paths are joined to the current directory and must produce an absolute path. Use the intended path directly without parent traversal.

An existing read-only transaction can prevent the rollback-to-WAL transition; this fails explicitly without retrying or changing journal mode. A new open after that reader releases its transaction can migrate. Older SQLite versions from before WAL support (3.7.0) cannot read WAL databases. Earlier lazysh builds use modern SQLite, but mixed-version concurrent bootstrap is not an acceptance claim. To deliberately revert format, stop all Store users and use SQLite to checkpoint and change `journal_mode=DELETE`; never remove a WAL file yourself. No automatic rollback or dual-format fallback is provided.

Store connections now enable SQLite's [NO_CKPT_ON_CLOSE](https://www.sqlite.org/c3ref/c_dbconfig_defensive.html#sqlitedbconfignockptonclose) immediately after a successful SQLite open, before subsequent validation or database queries. Clean CLI exit retains `events.sqlite3-wal` and `events.sqlite3-shm` instead of repeatedly checkpointing/removing them. They contain private, unencrypted event data/metadata and retain the same owner-only protections; this is a changed sidecar-lifetime default, not encryption or secure erasure. Logical event retention does not securely erase old SQLite/WAL contents.

**The main database file alone can omit acknowledged events even after every CLI process has exited.** Do not discard the WAL or treat retained sidecars as disposable temporary files. Prefer SQLite's [consistent online backup API](https://www.sqlite.org/backup.html). Alternatively, stop all Store users and use a compatible SQLite connection to perform and verify an explicit checkpoint (for example `PRAGMA wal_checkpoint(TRUNCATE)` returning a zero busy result) before copying the main file; or preserve the quiescent database and its WAL together as one consistent set. Copying the main file alone without that verification is not a complete backup. No database/sidecar is removed manually by lazysh.

Commit synchronization remains `FULL`. The normal automatic checkpoint threshold remains 1000 pages, and `journal_size_limit` remains 1 MiB for recycling after a successful checkpoint. That limit is not a hard maximum on live WAL size: long readers, busy checkpoints or storage failures can prevent recycling and permit growth. The native single-writer fixture observes growth followed by recycling across 1100 commits; it is not a universal size or latency bound. Explicit checkpoints still work.

A private `events.sqlite3-init-lock` coordinates connection bootstrap using an OS advisory lock; it contains no event data and is retained to keep a stable lock inode. Ephemeral journal/WAL/SHM validation runs while that lock is held. The original finite re-observation rule still rejects zero-link snapshots rather than accepting removed inodes. Legacy/external SQLite connections with default close behavior can still checkpoint/remove WAL/SHM; the native cleanup fixture explicitly covers that boundary. A failed SQLite open that never returns a handle also cannot be configured by Store. No claim of eliminating every unlink or establishing the intermittent SQLITE_BUSY cause is made.

Native-lock waiting, ephemeral validation and SQLite schema/mode waiting still share one absolute three-second bootstrap deadline; ingestion retains its existing separate locking-episode budget. Blocking filesystem I/O cannot be interrupted by a busy-handler deadline. No per-call cancellation API is added.

Store chooses one checked absolute namespace before filesystem admission and uses that exact path for subsequent state access, without another canonicalization. Custom Unix symlink routes, including symlinked home/state paths, are unsupported. Only Darwin's root-owned `/var`, `/tmp` and `/etc` system aliases with their verified exact `/private/...` targets are mapped; their destinations are checked component by component. Windows rejects reparse points, including directory junctions, in directory routes and existing database/sidecar files. Missing directories are created one component at a time and rechecked without following links before proceeding, so replacing a missing component after admission cannot redirect further creation or chmod onto its target.

On Unix, directory ancestors must be owned by the current user or root and must not have group/other write permission bits, except a root-owned sticky ancestor such as `/private/tmp`. The leaf must belong to the current user and is tightened to 0700 before opening state. The database must be owned and have one link. Existing journal/WAL/SHM/bootstrap files must be owned regular single-link files with mode 0600; unsafe files fail without following their links or changing their targets. SQLite creates new WAL/SHM files with the database's private permissions and its bundled Unix VFS uses no-follow opens. No database/sidecar descriptors are opened and closed outside SQLite, preserving its POSIX locks. Processes running as the same user and root remain trusted. These mode/ownership checks do not inspect additional macOS ACL grants and do not establish their safety. Windows relies on the state directory's existing user ACLs; Windows ACL validation is not added here.

SQLite documents [FULL synchronization in WAL](https://www.sqlite.org/pragma.html#pragma_synchronous) as durable across power loss subject to the underlying filesystem honoring sync. Native acceptance tests cover concurrent first-open, previous-format migration, explicit FULL settings, unsafe sidecars and recovery after killing a writer with both committed data and spilled uncommitted WAL frames. Process-kill recovery is not a hardware power-loss test. See [WAL lifetime, checkpointing and filesystem limits](https://www.sqlite.org/wal.html).

Concurrent lifecycle writes use short lock polls within a three-second elapsed-time wait budget per SQLite locking episode. Sustained contention fails explicitly; storage failures include only the numeric SQLite extended error code, never its potentially sensitive message. WAL changes journal behavior while synchronization stays explicitly FULL.

The Linux CI companion test task explicitly opts into syscall observation for
the existing `concurrent_hooks_preserve_every_event` Cargo integration case via
`LAZYSH_TEST_STORAGE_TRACE_DIR`. Only that case's sixteen synthetic CLI child
processes are wrapped in `strace`; other cases and services remain untraced.
An explicit request fails if the tool or results directory is unavailable.
Traces contain PID-separated `fcntl`, `fsync` and `fdatasync` calls with absolute
timestamps, durations and file-descriptor paths, without event payload reads,
writes, argv or environment. Strace propagates the child's exit status; the
original sixteen-success and event-count assertions remain unchanged.

The native fixture reaps every worker and exports evidence before checking the
success gates. It exports at most 64 owned regular PID files, preserving up to
128 KiB of beginning/end data per file (at most 8 MiB of trace excerpts), plus
a bounded status manifest. Symlinks, hard links, foreign ownership and unexpected
filenames are rejected. The temporary raw spool is **not byte-capped during
tracing**; only the exported excerpts are capped, and the spool is removed when
the fixture exits normally. CI uploads `lazysh-storage-syscalls` after the
original task on success/failure, without rerunning the suite, and bounds the
agent job to twenty minutes. Tracing changes scheduling and I/O timing, so these
artifacts are evidence with an observer effect, not a diagnosis or storage fix
for [issue #36](https://github.com/mihazs/lazysh/issues/36). Production storage,
durability and the three-second busy budget are unchanged.


Related: [configure reporting](../how-to/configure-companion.md) · [reported and live sessions](../explanation/session-lifetime.md) · [documentation](../README.md).
