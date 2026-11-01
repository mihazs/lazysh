# lazysh documentation

Choose a guided lesson when learning, a how-to guide when completing a task, reference when looking up a contract, or explanation when understanding a boundary. These documents describe the checked-out source. The [installation guide](install-and-update.md) and public release assets determine what you can actually download; source versions and CI artifacts alone are not released availability.

## Tutorials

[Open your first SSH session](tutorials/first-ssh-session.md) walks through saving one direct host, independently verifying its key, printing a message, disconnecting and reconnecting. It needs an installed native app and a reachable Unix password-authenticated SSH host you control.

## How-to guides

| Your goal | Guide |
| --- | --- |
| Install or update a native app or companion | [Install and update](install-and-update.md) |
| Configure direct SSH, transports or saved workspace entry | [Connections](connections.md) |
| Reach a private destination through one jump host | [Connect through a bastion](how-to/connect-through-bastion.md) |
| Resume a host-side workspace | [Multiplexers](multiplexers.md) |
| Open a desktop shell in a local directory | [Local terminal](local-terminal.md) |
| Install a companion and enable agent reporting | [Configure the companion](how-to/configure-companion.md) |
| Inspect or explicitly manage provider lifecycle hooks | [Agent hooks](agent-hooks.md) |
| Disable companion discovery, recorded usage or device tools | [Host settings](companion-settings.md) |
| Inspect/install optional setup guidance for an agent | [Product skills](product-skills.md) |
| Read agent history and integration-specific records | [Companion adapter contracts](companion.md#read-transcript-records) |
| Stage text for an explicitly confirmed terminal destination | [Chat terminal input](chat-terminal-input.md) |
| Resolve an exact waiting Claude permission hook | [Approvals](approvals.md) |
| Browse Git changes and stage review comments | [Repository review](repository-review.md) |
| Preview a forwarded remote web service | [Previews](previews.md) |
| Preview, upload or recover an image transfer | [Attachments](attachments.md) |
| Encrypt and synchronize selected settings or credentials | [Sync](sync.md) |
| Create an explicitly public, expiring share link | [Sharing](sharing.md) |
| Configure terminal appearance and imports | [Themes](themes.md) · [Theme QR](theme-qr.md) · [Fonts](font-downloads.md) |
| Use terminal shortcuts and chords | [Shortcuts](shortcuts.md) |
| Dictate editable text or import a local speech model | [Voice](voice.md) · [Parakeet](voice-parakeet.md) |
| Configure an optional cloud transcription service | [Cloud transcription](cloud-transcription.md) |
| Keep a supported active mobile screen awake | [Keep awake](keep-awake.md) |
| Enroll a notification device or configure relay delivery | [Notifications](notifications.md) · [Push registration](push-registration.md) · [UnifiedPush enrollment](unifiedpush-enrollment.md) · [Notification relay](notification-relay.md) · [Web push server](web-push-server.md) |
| Inspect/control an owned Android device or iOS simulator | [Devices](devices.md) |
| Build and validate native client interfaces | [Native GUI testing](native-gui-testing.md) · [Android testing](android-testing.md) · [iOS testing](ios-testing.md) |
| Verify exact published APKs or startup CPU evidence | [Published APK qualification](android-published-apk.md) · [Android startup CPU budget](android-startup-cpu-budget.md) |
| Localize UI or produce platform icon assets | [Localization](localization.md) · [App icons](app-icons.md) |
| Prepare versions and release artifacts | [Versioning](versioning.md) · [Release artifacts](release-artifacts.md) · [Release tag gate](release-tag-gate.md) |

## Reference

| Information to look up | Reference |
| --- | --- |
| Desktop executable selectors, limits and receipt behavior | [Desktop launch arguments](reference/desktop-launch.md) |
| Companion switches, defaults, revision conflicts and strict schema | [Companion settings](reference/companion-settings.md) |
| Credential storage, identity binding and native resume-lock contracts | [Credentials](credentials.md) |
| Generic lifecycle protocol, retention and SQLite/WAL safety | [Companion events and storage](reference/companion-events.md) |
| Provider-specific transcript formats and reader limits | [Companion contracts](companion.md) |
| Recorded token counters, context and provider-window freshness | [Recorded usage](usage.md) |
| Explicit live account collectors and unsupported/unknown states | [AI account usage](ai-account-usage.md) |
| Native local-speech models, inference and interop limits | [Voice native interop](voice-native-interop.md) |
| Native UI locale support and delivery boundaries | [Native UI locale](native-ui-locale.md) |
| Release history | [Changelog](../CHANGELOG.md) |

## Explanation

| Question | Explanation |
| --- | --- |
| Why does saved connection information differ from live work? | [Session lifetime](explanation/session-lifetime.md) |
| How are client, native transport and optional services separated? | [Architecture and implementation boundary](architecture.md) |

## Evidence and delivery

[Roadmap](roadmap.md) links the live issue and Project delivery record. The [implementation evidence catalog](reference-evidence.md) distinguishes source, reference-client observations, tests and remaining acceptance. Historical observations apply to their recorded candidate, platform and fixture; reorganizing links does not recertify them.

| Evidence or delivery boundary | Record |
| --- | --- |
| Apple extension/watch integration and outstanding gates | [Apple status](apple-status.md) |
| Exact notification and relay acceptance procedures/limits | [UnifiedPush acceptance](unifiedpush-acceptance.md) · [Whisper relay acceptance](whisper-relay-acceptance.md) |
| F-Droid metadata, inclusion and distribution status | [F-Droid listing](fdroid-listing.md) |
| ET interoperability research | [ET research](et-research.md) |
| Remaining agent-format investigation | [Agent format research](remaining-agent-format-research.md) |
| Recorded visual benchmarks and candidate-specific refinements | [Android workspace benchmark](ux/android-workspace-benchmark.md) · [Workspace redesign 1.5.1](ux/workspace-redesign-1-5-1.md) · [Connected workspace refinement 1.7.1](ux/connected-workspace-refinement-1-7-1.md) |

Apple application distribution, physical Samsung/SwiftKey behavior, Rex beta compatibility, ordinary-user Windows GUI qualification and full native parity remain separate unresolved limits. A passing source build, emulator case or installer check does not establish them. Notification enrollment does not establish delivery, and an old usage report does not establish a current quota.

## For contributors

Use [Contributing](../CONTRIBUTING.md) for branches, checks and release policy; the [README checks](../README.md#checks) list existing task entrypoints. The tables above inventory the existing product and developer pages by their primary reader need. Some older feature pages still combine usage and contract details; the focused companion/configuration/connection pages are an incremental separation, not a claim that every historical document has been rewritten. Existing filenames and anchors remain supported.
