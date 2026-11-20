// Base images are pinned by digest (ADR 0006). A tag that `.prototools` asks for has no digest until someone vets it and records it here.
// Resolve one with: curl -sI -H "Authorization: Bearer <pull token>" -H "Accept: application/vnd.oci.image.index.v1+json" https://registry-1.docker.io/v2/<repo>/manifests/<tag>
export const DIGESTS: Record<string, string> = {
  "node:24-bookworm": "sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496",
  "oven/bun:1.3.14": "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
}

export function pinned(tag: string, digests: Record<string, string> = DIGESTS): string {
  const digest = digests[tag]
  if (!digest) throw new Error(`no pinned digest for ${tag}: resolve it and add it to dagger/src/images.ts`)
  return `${tag}@${digest}`
}
