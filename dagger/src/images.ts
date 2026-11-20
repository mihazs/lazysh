// Base images are pinned by digest (ADR 0006). A tag that `.prototools` asks for has no digest until someone vets it and records it here.
// Resolve one with: curl -sI -H "Authorization: Bearer <pull token>" -H "Accept: application/vnd.oci.image.index.v1+json" https://registry-1.docker.io/v2/<repo>/manifests/<tag>
// The toolchain runs on the runner image's distribution: the tests depend on its tool versions (jq 1.7 accepts keywords as object keys, bookworm's 1.6 does not).
export const UBUNTU = "ubuntu:24.04"

// Only cargo is used from this image (moon-graph checks `cargo metadata`), so the Rust version is not tied to any job's toolchain.
export const RUST = "rust:1.96.1-bookworm"

export const DIGESTS: Record<string, string> = {
  "ubuntu:24.04": "sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8",
  "node:24-bookworm": "sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496",
  "oven/bun:1.3.14": "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
  "rust:1.96.1-bookworm": "sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663",
}

export function pinned(tag: string, digests: Record<string, string> = DIGESTS): string {
  const digest = digests[tag]
  if (!digest) throw new Error(`no pinned digest for ${tag}: resolve it and add it to dagger/src/images.ts`)
  return `${tag}@${digest}`
}
