---
"@lazysh/client": patch
---

build(fdroid): add release notes and phone screenshots to the F-Droid listing

Each version PR now writes `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`, which lists the release's user-facing headlines and links to the full notes. The listing also gets six phone screenshots taken from the README captures.
