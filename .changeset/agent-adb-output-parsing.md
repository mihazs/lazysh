---
"@lazysh/agent": patch
---

Read the `adb` feature list whether it is comma-separated or one feature per line, and start an Android screenshot at its PNG signature when the guest printed a warning line before it, and convert the decoded video to full range before the JPEG encoder, so `lazysh-agent devices` works on a device that `adb` 1.0.41 and the Waydroid guest describe that way and whose encoder tags limited-range video. A list without `shell_v2` and bytes with no PNG signature in the first KiB are still refused.
