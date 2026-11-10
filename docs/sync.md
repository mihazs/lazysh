# Optional encrypted sync

lazysh works locally without sync or an account. Sync is an explicit backup/merge workflow for a self-hosted WebDAV folder. It makes no background uploads and does not use the reference client's services.

## Configure and enroll devices

1. Create an HTTPS WebDAV folder whose certificate is trusted by the standard web PKI. The server must support GET/PUT, strong ETags, `If-Match` and `If-None-Match`. Use a dedicated app password for each device so its server access can be revoked independently.
2. Open encrypted sync, enter the folder URL, username and app password, and separately choose **Settings** and/or **Credentials**. Both categories start disabled. Configure saves enrollment locally; it uploads nothing.
3. A first enrollment generates a 256-bit recovery secret. Save it through a trusted channel. An enrolled device can show it again explicitly through the native credential store. The secret is never included in ordinary status responses or remote preview metadata.
4. On another trusted device, configure the same folder with that device's WebDAV app password and paste the recovery secret. Preview each selected category, review host identities and any imported fingerprints, then apply it.

Recovery keys use the `LAZYSH-SYNC-V1-` prefix followed by 64 lowercase hexadecimal characters. Use the generated value unchanged; it is not a human password. Missing the recovery secret and every enrolled device makes existing ciphertext unrecoverable. WebDAV authentication alone cannot decrypt it.

Updating toggles on the same endpoint with an empty recovery field retains the enrolled secret. An empty app-password field retains the existing password only for the same endpoint/account. Changing the endpoint requires explicit recovery-key entry. Disconnect first to create a fresh group and generate a new key.

After importing a host, enable biometric unlock locally only after its device capability check. To initialize an intentionally empty destination, disconnect and re-enroll with the saved recovery secret, review the target folder, and upload explicitly.

## Independent data categories

See [independent data categories](reference/sync.md#independent-data-categories) for details.

## Review, merge and conflict behavior

See [review, merge and conflict behavior](reference/sync.md#review-merge-and-conflict-behavior) for details.

If an upload is interrupted after writing part of the remote settings, preview the
remote copy. When recovery is pending, **Keep local settings and acknowledge
remote** records the reviewed remote baseline without importing its hosts or
preferences. Local settings stay intact; retry the upload explicitly when ready.
The retry can replace the reviewed remote copy.

## Disconnect, rotate and revoke

Disconnect removes this device's sync enrollment and pending previews. It leaves local SSH profiles/credentials and remote ciphertext intact. It cannot revoke a lost device remotely.

To revoke a lost device, revoke its WebDAV app password at the server. For a new encryption group, disconnect a trusted device, configure a fresh WebDAV folder without importing the old recovery key, and save the newly generated secret. Explicitly upload local snapshots and enroll each retained device with the new secret and its own server credential. Remove the old remote resources and retention copies according to your server policy.

A device that learned an old recovery secret can still decrypt previously copied old snapshots. Rotation cannot erase already learned SSH secrets. If a device was compromised, rotate the affected SSH passwords/keys on the hosts as well. Newly enrolled devices have no prior revision baseline and cannot independently prove that a server supplied its latest snapshot; existing devices detect revisions older than their locally observed baseline. The server can still withhold or delete ciphertext.

## Cryptography and checks

See [cryptography and checks](reference/sync.md#cryptography-and-checks) for details.
