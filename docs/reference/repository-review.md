# Repository review limits

## Bounds

- Git command output and current text previews are limited to 1 MiB. Individual text diffs are limited to 10,000 lines.
- A directory or changed-file response is limited to 10,000 entries. The interface displays the first 500 matching entries; narrow the search for additional matches.
- Historical text and image previews are limited to 200 KiB; current image previews are limited to 2 MiB. Larger or unsupported files remain available in the terminal.
- At most 20 comments, each up to 2,000 characters, can be staged together.
- Historical submodules are identified without accessing another repository. Historical symlinks show their stored target text; image previews require regular files.

Repository review is read-only. It does not stage changes, run external diff/text conversion helpers, check out revisions or write fetched content to the device. Paths are passed as quoted literal pathspecs, and historical revisions use full Git object identifiers.

For setup and usage, see [repository-review](../repository-review.md). Return to the [documentation map](../README.md).
