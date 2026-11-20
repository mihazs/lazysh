/** Parses the `tool = "version"` lines of `.prototools`; `.prototools` stays the one place tool versions are pinned. */
export function parsePrototools(text: string): Record<string, string> {
  const versions: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const match = /^\s*([\w-]+)\s*=\s*"([^"]+)"\s*(#.*)?$/.exec(line)
    if (match) versions[match[1]] = match[2]
  }
  return versions
}

export function requireVersion(versions: Record<string, string>, tool: string): string {
  const version = versions[tool]
  if (!version) throw new Error(`.prototools pins no ${tool}`)
  return version
}
