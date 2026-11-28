# Community guides

| Guide | Use it to |
| --- | --- |
| [Your first lazysh contribution](first-contribution.md) | Choose a bounded task, set up a branch and run the checks a pull request needs. |
| [Glossary for first-time SSH workspace users](glossary.md) | Look up SSH host, host-key fingerprint, terminal, host-side multiplexer, optional companion and recorded agent activity. |

## Optional services

Direct SSH needs none of these services, and none is enabled until you set it up. Each guide is the authority for setup and limits, including which platforms and behaviors are not verified on hardware; this table only collects the prerequisite each one documents.

| Service | Prerequisite | Guide |
| --- | --- | --- |
| Sharing | Your own HTTPS service, the `lazysh-share` Rust app behind a reverse proxy, and its management token. No service is configured by default. | [Optional expiring file sharing](../sharing.md) |
| Voice | A Whisper model you explicitly download (contacts Hugging Face only after your click) or import, and microphone permission when you record. Cloud dictation instead needs your own relay's HTTPS origin and an administrator-issued device token. | [Dictation](../voice.md) |
| Sync | A self-hosted HTTPS WebDAV folder with a certificate trusted by the web PKI, strong ETags and `If-Match`/`If-None-Match` support, a dedicated app password per device, and a recovery secret to enroll more devices. | [Optional encrypted sync](../sync.md) |
| Notifications | The host companion's lifecycle hooks installed on the host, and an existing host-key-verified SSH connection to monitor. System alerts also need OS notification permission; the inbox works without it. | [Agent inbox and local notifications](../notifications.md) |

[CONTRIBUTING.md](../../CONTRIBUTING.md) and the [documentation map](../README.md) cover everything else.
