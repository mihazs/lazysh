# Optional encrypted sync

lazysh works locally without sync or an account. Sync is an explicit backup/merge workflow for a self-hosted WebDAV folder. It makes no background uploads and does not use the reference client's services.

## Configure and enroll devices

1. Create an HTTPS WebDAV folder whose certificate is trusted by the standard web PKI. The server must support GET/PUT, strong ETags, `If-Match` and `If-None-Match`. Use a dedicated app password for each device so its server access can be revoked independently.
2. Open encrypted sync, enter the folder URL, username and app password, and separately choose **Settings** and/or **Credentials**. Both categories start disabled. Configure saves enrollment locally; it uploads nothing.
3. A first enrollment generates a 256-bit recovery secret. Save it through a trusted channel. An enrolled device can show it again explicitly through the native credential store. The secret is never included in ordinary status responses or remote preview metadata.
4. On another trusted device, configure the same folder with that device's WebDAV app password and paste the recovery secret. Preview each selected category, review host identities and any imported fingerprints, then apply it.

Recovery keys use the `LAZYSH-SYNC-V1-` prefix followed by 64 lowercase hexadecimal characters. Use the generated value unchanged; it is not a human password. Missing the recovery secret and every enrolled device makes existing ciphertext unrecoverable. WebDAV authentication alone cannot decrypt it.

Updating toggles on the same endpoint with an empty recovery field retains the enrolled secret. An empty app-password field retains the existing password only for the same endpoint/account. Changing the endpoint requires explicit recovery-key entry. Disconnect first to create a fresh group and generate a new key.

## Independent data categories

- **Settings**: connection metadata and the validated terminal preference schema. It excludes host pins, saved passwords, private keys and passphrases. The current preference schema includes themes, fonts, toolbar/chords/snippets and gesture choices.
- **Credentials**: saved native-vault credentials bound to their host address, port, username, route, forwarding policy and verified fingerprint. Host metadata/pins needed to establish those identities are encrypted in this category. Enabling settings does not enable credential upload.

Each category has a separate age-encrypted resource. Disabling a category stops its fetch/upload operations; it does not delete an existing remote resource. Only the enrolled OS credential store holds the WebDAV password and recovery secret. Decrypted credential previews remain in native memory and expire after ten minutes; they are never returned to the webview. Intentional recovery-key display is the exception.

Biometric unlock is device-local and is excluded from both categories. New imported hosts start with it disabled; enable it locally after the device capability check. An existing local biometric policy is preserved. Export reads credentials through the source host's current native protection before stripping that policy from portable metadata; importing into an existing protected host must pass its current native authentication and never falls back to an unprotected write.

## Review, merge and conflict behavior

Preview fetches and authenticates a snapshot without changing local hosts or credentials. It lists the actual host identities, fingerprints, bastion routes and agent-forwarding policy that would be imported. Applying requires that the remote ETag and local host snapshot still match the reviewed version. A stale preview fails and must be fetched again.

Imports add new profiles. Existing profiles and saved credentials are preserved; conflicting identities are listed and skipped. Imported credentials never overwrite an existing vault item. After explicit fingerprint review, an authenticated credential snapshot can enroll a new host pin or fill an unknown pin on a profile first imported through settings. Enrollment fills only unknown pins for profiles sharing that address/port; an existing verified fingerprint is never replaced. A differing verified pin must be resolved locally before those credentials can be imported.

Uploads preserve profiles and credential records found only in the remote snapshot. Host-address, route, forwarding-policy and pin conflicts refuse the upload. Explicit settings upload uses the current local terminal preferences; preferences are not automatically applied in the background. Concurrent writes fail their HTTP precondition rather than silently winning. Known per-category revision counters reject older snapshots after a device has observed a newer version.

OS vault and host-file updates cannot be one transaction. If credential storage fails after profiles were added, the error says that metadata may have been imported. Existing credentials are preserved, and retrying starts with another review. Failed cleanup keeps the saved-credential marker so remaining partial vault data can be removed explicitly through **Forget credentials**. An item reported as already present is never deleted by a failed import. No compensating deletion removes user profiles.

Deleting a remote resource externally is detected as a changed baseline. The app does not silently recreate or erase it. To initialize an intentionally empty destination, disconnect/re-enroll with the saved recovery secret, review the target folder and upload explicitly.

## Disconnect, rotate and revoke

Disconnect removes this device's sync enrollment and pending previews. It leaves local SSH profiles/credentials and remote ciphertext intact. It cannot revoke a lost device remotely.

To revoke a lost device, revoke its WebDAV app password at the server. For a new encryption group, disconnect a trusted device, configure a fresh WebDAV folder without importing the old recovery key, and save the newly generated secret. Explicitly upload local snapshots and enroll each retained device with the new secret and its own server credential. Remove the old remote resources and retention copies according to your server policy.

A device that learned an old recovery secret can still decrypt previously copied old snapshots. Rotation cannot erase already learned SSH secrets. If a device was compromised, rotate the affected SSH passwords/keys on the hosts as well. Newly enrolled devices have no prior revision baseline and cannot independently prove that a server supplied its latest snapshot; existing devices detect revisions older than their locally observed baseline. The server can still withhold or delete ciphertext.

## Cryptography and checks

Snapshots use the standard age v1 **scrypt passphrase** format with a generated high-entropy recovery secret. This authenticates shared-secret possession as well as protecting confidentiality. Public-recipient age encryption alone would allow anyone knowing the public recipient to create a new ciphertext; it is deliberately not used to authorize imported host pins. Every enrolled recovery-secret holder can create snapshots; there is no claim of individual device authorship.

The scrypt work factor and accepted maximum are both `log2(N)=14` (approximately 16 MiB for the KDF). Security depends on the generated 256-bit secret, not on stretching a weak user password. Ciphertext/plaintext are bounded to 8 MiB, snapshots to 1000 profiles, and network calls to finite connection/request timeouts. HTTPS redirects are never followed, URLs cannot contain userinfo/query/fragment, and error messages omit response bodies and authentication data.

The maintained age 0.11.5 line provides the required standard format and current maintenance fixes without age 0.12's unused post-quantum dependency conflicting with the SSH stack's KEM version. reqwest 0.12 uses Rustls with web PKI roots; sync does not require Android platform-verifier JNI setup.

Cargo tests cover wrong keys, tampering, truncation, excessive KDF headers, category separation, secret-free previews, local revision conflicts, pin preservation, additive upload merging and a real loopback HTTP fixture for GET/PUT conditional writes, redirects and body limits. The loopback substitution exists only in test code; production endpoint validation always requires HTTPS.

Not yet verified: a real WebDAV provider, Android/iOS secure-store enrollment and recovery-key display, cross-device mobile lifecycle, or an operational lost-device revocation exercise.
