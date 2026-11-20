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

## View files in Files

The **Files** view opens the same viewers for the current directory. Source files
render as escaped text with optional highlighting. Markdown files render by
default through the Chat renderer, without raw HTML, active links or remote
images; **Show source** displays the text. PNG, JPEG, GIF and WebP files up to
2 MiB are read through the same byte-sniffing image reader as repository review;
larger images are refused before reading. SVG files, read as text up to 1 MiB,
are shown only as an image resource from a local blob URL, so their scripts,
event handlers and external references do not run or load; **Show source**
displays the markup as text.

MP4, M4V and WebM video and MP3, M4A, Ogg, Opus, WAV and FLAC audio up to 8 MiB
play in a frame that has no script rights and no access to the app: the file's
type is read from its first bytes, so a page named `clip.mp4` is refused rather
than played, and larger files are refused before reading. Where the platform
cannot play media safely (Linux without GStreamer's audio plugins) the app says
so, and **Open with…** and **Download** still work. PDF files are not drawn in
the app: **Open with…** opens them in the device's PDF viewer. See the
[viewer reference](reference/files-media-viewer.md) for the trust boundary.

## Review from the host's terminal

The host companion reads the same changes and diffs in a terminal on the host,
without the app. It needs only `git` and the companion.

```sh
lazysh-agent review status [--json] DIRECTORY
lazysh-agent review diff [--json] [--staged] DIRECTORY [--] FILE
```

`status` prints the root of the repository that contains `DIRECTORY` (a
subdirectory is enough), then one line per changed file in the format of
`git status --short`: two state letters, a space and the path, or `old -> new` for
a rename. Staged, unstaged, untracked and renamed files are listed; a repository
without changes prints only its root. `diff` prints the unified patch of `FILE`, a
path relative to the repository root as `status` prints it: the unstaged changes,
or the staged ones with `--staged`. A file without changes prints nothing, and a
binary file prints Git's `Binary files ... differ` line. Put `--` before a file
name that starts with `-`; the name is always one literal path, never a pattern.

`--json` prints one line instead, with the fields the app reads from the same
commands and `"schemaVersion": 1`: `path` and `changes` (each with `path`,
`originalPath`, `index` and `worktree`) for `status`, and `patch` and `binary` for
`diff`. Plain text shows a control character of a file name or of the file's own
contents as an escape such as `\u{1b}`, so a repository cannot drive your terminal;
`--json` keeps the exact text.

The command changes nothing: Git does not refresh the index, run an external diff
or text conversion helper, or take a lock, and `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE` and `GIT_COMMON_DIR` from the environment never replace the
repository you name. The [bounds](reference/repository-review.md#bounds) are the
app's: 1 MiB of Git output, 10,000 changed files and 10,000 diff lines, and each
Git command has 30 seconds. The app and the command build their Git commands in
one shared module, so they report the same changes and the same patches.

Exit status 0 means the output is complete. A refusal exits with status 1, prints
nothing on standard output and one line `lazysh-agent: CLASS: operation failed` on
standard error; the class is `ReviewNotARepository`, `ReviewInvalidDirectory`,
`ReviewInvalidFilePath`, `ReviewTooManyChanges`, `ReviewDiffTooLarge`,
`ReviewOutputTooLarge`, `ReviewTimeout`, `ReviewGitUnavailable`, `ReviewGitFailed`,
`ReviewInvalidOutput` or `ReviewCancelled`. A usage error exits with status 2.

`lazysh-agent review --help` and the help of `status` and `diff` are written in
English, Brazilian Portuguese or Spanish, chosen by the first of `LC_ALL`,
`LC_MESSAGES` and `LANG` that is set (`pt...` and `es...`; any other language is
English). The output, the failure classes and the parser's usage errors are not
translated. The tests drive real Git on Linux and macOS hosts; no Windows host was
available, so the Windows build of the command is untested.

## Bounds

See [bounds](reference/repository-review.md#bounds) for details.

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
