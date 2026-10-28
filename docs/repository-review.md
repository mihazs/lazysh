# Review host repositories

Open a connected host's **Diff** view and enter a repository directory. Subdirectories resolve to the repository root. Working-tree changes include staged, unstaged, renamed and untracked files. Read an untracked file to review its entire content; staged and unstaged changes have separate, side-by-side hunk views. Binary changes are identified explicitly.

The side-by-side diff uses the terminal's selected font family and CJK fallback,
including imported fonts loaded by the existing local font manager. Missing or
unavailable faces fall through to the same configured fallback stack. Changing a
font updates the displayed diff without fetching it again, replacing the selected
file or changing annotation drafts. The diff keeps its existing text size; file
source previews and the legacy raw patch view are outside this font-matching slice.
This implements the documented reference client diff font behavior (source URL omitted)
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


## Comment on a diff line

In a staged or unstaged text diff, choose **+** beside a numbered Before or After
line. Edit the note, then choose **Use in next prompt** to stage it with the
original SSH session. Nothing is sent automatically. Both sides are independent;
removed lines can be discussed without pretending they still exist in the current
file. Hunk headings, empty sides and binary files have no line-comment action.

A note records the displayed repository, selected file, side, line and staged or
unstaged selection. Rename source/destination are retained as observed context.
The existing native command deliberately uses `--no-renames` with the selected
literal pathspec: for a staged rename followed by unstaged edits, both sides of
that unstaged diff refer to the selected **new** path. The old rename path is not
substituted as the before-side location. Pure staged additions expose only actual
after-side lines. The note is not a Git object ID or a guarantee the file remains
unchanged; review paths and lines before sending if the agent continued editing.

Switching files or diff selections preserves the original note references and
text. Editing or removing notes clears the old staging/copy status. Session
changes discard that panel's notes, and an old mount/access lease cannot stage
or copy after revocation. The existing shared limit remains twenty notes, two
thousand characters per note, and 65,536 characters for staged prompt text.

This implements the documented reference client diff/file annotation behavior (source URL omitted)
within the diff-review feature group (source URL omitted).
The desktop product itself is free; this does not claim annotation is a separate
paid entitlement. Browser/native IPC fixtures do not establish remote-device or
full repository-review parity.
