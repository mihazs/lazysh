# Review host repositories

Open a connected host's **Diff** view and enter a repository directory. Subdirectories resolve to the repository root. Working-tree changes include staged, unstaged, renamed and untracked files. Read an untracked file to review its entire content; staged and unstaged changes have separate, side-by-side hunk views. Binary changes are identified explicitly.

The side-by-side diff uses the terminal's selected font family and CJK fallback,
including imported fonts loaded by the existing local font manager. Missing or
unavailable faces fall through to the same configured fallback stack. Changing a
font updates the displayed diff without fetching it again, replacing the selected
file or changing annotation drafts. The diff keeps its existing text size; file
source previews and the legacy raw patch view are outside this font-matching slice.
This implements the documented [Moshi diff font behavior](https://getmoshi.app/docs/diff-viewer#font)
without a subscription gate. Desktop/phone Chromium acceptance checks actual
loaded font styles; physical native WebView rendering is not established by them.

Select a commit to browse its files without checking it out or changing the working tree. History loads in pages of 50 commits, anchored to the first loaded commit so new commits do not shift subsequent pages. Historical trees load one directory at a time. File search filters the current directory; the parent control returns to the enclosing directory. The connection's selected repository and file are remembered in session storage, without retaining file contents.

Text files render as escaped source. Syntax highlighting loads on demand for supported languages and files no larger than 100,000 characters. Markdown rendering omits remote images and active links; raw HTML is never executed. PNG, JPEG, GIF and WebP previews read bytes through the verified SSH connection. SVG and HTML are not image-preview formats.

To comment on source, enter a line number, choose **Add line comment**, and edit the comment. **Use in next prompt** stages the file/line references and comments in an editable prompt. Sending remains an explicit action. **Copy comments** copies the same text. Review references against the current file before sending if the agent has continued editing it.

## Bounds

- Git command output and current text previews are limited to 1 MiB. Individual text diffs are limited to 10,000 lines.
- A directory or changed-file response is limited to 10,000 entries. The interface displays the first 500 matching entries; narrow the search for additional matches.
- Historical text and image previews are limited to 200 KiB; current image previews are limited to 2 MiB. Larger or unsupported files remain available in the terminal.
- At most 20 comments, each up to 2,000 characters, can be staged together.
- Historical submodules are identified without accessing another repository. Historical symlinks show their stored target text; image previews require regular files.

Repository review is read-only. It does not stage changes, run external diff/text conversion helpers, check out revisions or write fetched content to the device. Paths are passed as quoted literal pathspecs, and historical revisions use full Git object identifiers.
