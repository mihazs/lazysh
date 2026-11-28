# @lazysh/account-usage

## 1.105.1

No changes in this release.

## 1.105.0

No changes in this release.

## 1.104.2

No changes in this release.

## 1.104.1

No changes in this release.

## 1.104.0

No changes in this release.

## 1.103.0

No changes in this release.

## 1.102.5

No changes in this release.

## 1.102.4

No changes in this release.

## 1.102.3

No changes in this release.

## 1.102.2

No changes in this release.

## 1.102.1

No changes in this release.

## 1.102.0

No changes in this release.

## 1.101.5

No changes in this release.

## 1.101.4

No changes in this release.

## 1.101.3

No changes in this release.

## 1.101.2

No changes in this release.

## 1.101.1

No changes in this release.

## 1.101.0

No changes in this release.

## 1.100.3

No changes in this release.

## 1.100.2

No changes in this release.

## 1.100.1

No changes in this release.

## 1.100.0

No changes in this release.

## 1.99.0

No changes in this release.

## 1.98.6

No changes in this release.

## 1.98.5

No changes in this release.

## 1.98.4

No changes in this release.

## 1.98.3

No changes in this release.

## 1.98.2

No changes in this release.

## 1.98.1

No changes in this release.

## 1.98.0

No changes in this release.

## 1.97.11

No changes in this release.

## 1.97.10

No changes in this release.

## 1.97.9

No changes in this release.

## 1.97.8

No changes in this release.

## 1.97.7

No changes in this release.

## 1.97.6

No changes in this release.

## 1.97.5

No changes in this release.

## 1.97.4

No changes in this release.

## 1.97.3

No changes in this release.

## 1.97.2

No changes in this release.

## 1.97.1

No changes in this release.

## 1.97.0

### Minor Changes

- feat(usage): let a host forbid account quota reads ([#1823](https://github.com/mihazs/lazysh/pull/1823))

  <details><summary>Details</summary>

  Let a host forbid account quota reads (#1588, slice of #18). `lazysh-agent usage-collection show` and `usage-collection update --expected-revision R --account-quota-enabled true|false` read and change a new `usage-collection.json` policy beside `settings.json`. With the switch off, `lazysh-agent account-usage` answers a new `disabled` state with no report before it opens a credential, starts a helper or contacts a provider, and the app shows that the host does not allow account usage reads, in English, Portuguese and Spanish, with no percentage. The default is on, so nothing changes for existing hosts; an unreadable policy fails the read closed.

  </details>

## 1.96.0

No changes in this release.

## 1.95.7

No changes in this release.

## 1.95.6

No changes in this release.

## 1.95.5

No changes in this release.

## 1.95.4

No changes in this release.

## 1.95.3

No changes in this release.

## 1.95.2

No changes in this release.

## 1.95.1

No changes in this release.

## 1.95.0

No changes in this release.

## 1.94.0

No changes in this release.

## 1.93.9

No changes in this release.

## 1.93.8

No changes in this release.

## 1.93.7

No changes in this release.

## 1.93.6

No changes in this release.

## 1.93.5

No changes in this release.

## 1.93.4

No changes in this release.

## 1.93.3

No changes in this release.

## 1.93.2

No changes in this release.

## 1.93.1

No changes in this release.

## 1.93.0

No changes in this release.

## 1.92.3

No changes in this release.

## 1.92.2

No changes in this release.

## 1.92.1

No changes in this release.

## 1.92.0

No changes in this release.

## 1.91.4

No changes in this release.

## 1.91.3

No changes in this release.

## 1.91.2

No changes in this release.

## 1.91.1

No changes in this release.

## 1.91.0

No changes in this release.

## 1.90.0

No changes in this release.

## 1.89.1

No changes in this release.

## 1.89.0

No changes in this release.

## 1.88.0

No changes in this release.

## 1.87.1

No changes in this release.

## 1.87.0

No changes in this release.

## 1.86.0

No changes in this release.

## 1.85.1

No changes in this release.

## 1.85.0

No changes in this release.

## 1.84.0

No changes in this release.

## 1.83.1

No changes in this release.

## 1.83.0

No changes in this release.

## 1.82.1

No changes in this release.

## 1.82.0

No changes in this release.

## 1.81.0

No changes in this release.

## 1.80.4

No changes in this release.

## 1.80.3

No changes in this release.

## 1.80.2

No changes in this release.

## 1.80.1

No changes in this release.

## 1.80.0

No changes in this release.

## 1.79.7

No changes in this release.

## 1.79.6

No changes in this release.

## 1.79.5

No changes in this release.

## 1.79.4

No changes in this release.

## 1.79.3

No changes in this release.

## 1.79.2

No changes in this release.

## 1.79.1

No changes in this release.

## 1.79.0

No changes in this release.

## 1.78.2

No changes in this release.

## 1.78.1

No changes in this release.

## 1.78.0

No changes in this release.

## 1.77.2

No changes in this release.

## 1.77.1

No changes in this release.

## 1.77.0

No changes in this release.

## 1.76.0

No changes in this release.

## 1.75.1

No changes in this release.

## 1.75.0

No changes in this release.

## 1.74.0

No changes in this release.

## 1.73.1

No changes in this release.

## 1.73.0

No changes in this release.

## 1.72.0

No changes in this release.

## 1.71.0

No changes in this release.

## 1.70.0

No changes in this release.

## 1.69.0

No changes in this release.

## 1.68.3

No changes in this release.

## 1.68.2

No changes in this release.

## 1.68.1

No changes in this release.

## 1.68.0

No changes in this release.

## 1.67.1

No changes in this release.

## 1.67.0

No changes in this release.

## 1.66.1

No changes in this release.

## 1.66.0

No changes in this release.

## 1.65.0

No changes in this release.

## 1.64.2

No changes in this release.

## 1.64.1

No changes in this release.

## 1.64.0

No changes in this release.

## 1.63.0

No changes in this release.

## 1.62.0

No changes in this release.

## 1.61.0

No changes in this release.

## 1.60.0

No changes in this release.

## 1.59.0

No changes in this release.

## 1.58.0

No changes in this release.

## 1.57.0

No changes in this release.

## 1.56.1

No changes in this release.

## 1.56.0

No changes in this release.

## 1.55.0

No changes in this release.

## 1.54.1

No changes in this release.

## 1.54.0

No changes in this release.

## 1.53.0

No changes in this release.

## 1.52.0

No changes in this release.

## 1.51.0

No changes in this release.

## 1.50.0

No changes in this release.

## 1.49.0

No changes in this release.

## 1.48.0

No changes in this release.

## 1.47.0

No changes in this release.

## 1.46.0

No changes in this release.

## 1.45.0

No changes in this release.

## 1.44.0

No changes in this release.

## 1.43.0

No changes in this release.

## 1.42.0

No changes in this release.

## 1.41.0

No changes in this release.

## 1.40.0

No changes in this release.

## 1.39.0

No changes in this release.

## 1.38.0

No changes in this release.

## 1.37.0

No changes in this release.

## 1.36.0

No changes in this release.

## 1.35.0

No changes in this release.

## 1.34.0

No changes in this release.

## 1.33.4

No changes in this release.

## 1.33.3

No changes in this release.

## 1.33.2

No changes in this release.

## 1.33.1

No changes in this release.

## 1.33.0

No changes in this release.

## 1.32.0

No changes in this release.

## 1.31.2

No changes in this release.

## 1.31.1

No changes in this release.

## 1.31.0

No changes in this release.

## 1.30.5

No changes in this release.

## 1.30.4

No changes in this release.

## 1.30.3

No changes in this release.

## 1.30.2

No changes in this release.

## 1.30.1

No changes in this release.

## 1.30.0

No changes in this release.

## 1.29.3

No changes in this release.

## 1.29.2

No changes in this release.

## 1.29.1

No changes in this release.

## 1.29.0

No changes in this release.

## 1.28.2

No changes in this release.

## 1.28.1

No changes in this release.

## 1.28.0

No changes in this release.

## 1.27.1

No changes in this release.

## 1.27.0

No changes in this release.

## 1.26.1

No changes in this release.

## 1.26.0

No changes in this release.

## 1.25.1

No changes in this release.

## 1.25.0

No changes in this release.

## 1.24.0

No changes in this release.

## 1.23.0

No changes in this release.

## 1.22.0

No changes in this release.

## 1.21.0

No changes in this release.

## 1.20.0

No changes in this release.

## 1.19.0

No changes in this release.

## 1.18.2

No changes in this release.

## 1.18.1

No changes in this release.

## 1.18.0

No changes in this release.

## 1.17.1

No changes in this release.

## 1.17.0

No changes in this release.

## 1.16.0

No changes in this release.

## 1.15.0

No changes in this release.

## 1.14.0

No changes in this release.

## 1.13.0

No changes in this release.

## 1.12.0

### Patch Changes

- 5406843: Follow Cline CLI credential-store overrides for quota discovery and reads without silently selecting another login or using another provider's OAuth credential. Validate the pinned store schema and bounded regular-file inputs, and follow the saved Cline account selection rather than token-expiry ranking.
- 816f09b: Honor a valid host CODEX_HOME for automatic account discovery without a usage profile, keeping explicit configuration authoritative and invalid paths unavailable.

## 1.11.0

No changes in this release.

## 1.10.4

No changes in this release.

## 1.10.3

No changes in this release.

## 1.10.2

No changes in this release.

## 1.10.1

No changes in this release.

## 1.10.0

No changes in this release.

## 1.9.11

No changes in this release.

## 1.9.10

No changes in this release.

## 1.9.9

No changes in this release.

## 1.9.8

No changes in this release.

## 1.9.7

No changes in this release.

## 1.9.6

No changes in this release.

## 1.9.5

No changes in this release.

## 1.9.4

No changes in this release.

## 1.9.3

No changes in this release.

## 1.9.2

No changes in this release.

## 1.9.1

No changes in this release.

## 1.9.0

No changes in this release.

## 1.8.4

No changes in this release.

## 1.8.3

No changes in this release.

## 1.8.2

No changes in this release.

## 1.8.1

No changes in this release.

## 1.8.0

No changes in this release.

## 1.7.8

No changes in this release.

## 1.7.7

No changes in this release.

## 1.7.6

No changes in this release.

## 1.7.5

No changes in this release.

## 1.7.4

No changes in this release.

## 1.7.3

No changes in this release.

## 1.7.2

No changes in this release.

## 1.7.1

No changes in this release.

## 1.7.0

No changes in this release.

## 1.6.0

No changes in this release.

## 1.5.5

No changes in this release.

## 1.5.4

No changes in this release.

## 1.5.3

No changes in this release.

## 1.5.2

No changes in this release.

## 1.5.1

No changes in this release.

## 1.5.0

No changes in this release.

## 1.4.2

No changes in this release.

## 1.4.1

No changes in this release.

## 1.4.0

### Patch Changes

- bc6c84d: Recover built-in account quotas from empty external reports and offer companion setup when a remote usage command is missing or outdated.

## 1.3.3

No changes in this release.

## 1.3.2

No changes in this release.

## 1.3.1

No changes in this release.

## 1.3.0

### Minor Changes

- 9565f8a: Add compact AI account quotas and built-in host collectors when ai-usagebar is unavailable, keeping credentials on the session machine.
