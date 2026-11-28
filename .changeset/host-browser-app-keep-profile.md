---
"@lazysh/client": minor
---

feat(browser): add Keep profile and Clear browser data to the Host browser settings

Keep profile is off for every host until chosen, remembered on this device for that host only (never in the encrypted sync, host ids only) and passed to the host browser relay as `--keep-profile`, so cookies and sign-ins stay on the host's disk until cleared. Clear browser data deletes that kept profile directory on the host after a confirmation that names what is deleted; it is offered with the host browser switch off, reports when there is nothing to clear, is refused while a browser uses the profile, and asks you to update an older companion. No browser session starts from the app yet, so Keep profile takes effect when the Chrome viewer ships.
