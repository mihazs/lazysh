/** Lazysh CI as code: the same functions run on a laptop (`dagger call`) and in GitHub Actions. See docs/how-to/run-ci-locally-with-dagger.md. */
import { dag, Container, Directory, File, argument, object, func } from "@dagger.io/dagger"
import { pinned } from "./images.js"
import { parsePrototools, requireVersion } from "./prototools.js"

// Left out of the build context: what the container recreates (dependencies, build output) and what is local state.
// `.git` is excluded because a worktree's `.git` is a file pointing outside the context; `workspace` builds a one-commit repository instead.
const IGNORE = [".git", "**/node_modules", "**/target", ".moon/cache", ".turbo", "**/.gradle"]

@object()
export class Ci {
  /**
   * Node and Bun at the versions `.prototools` pins, without the source, so a source change keeps these layers cached.
   * moon is not installed here: `bun x moon` runs the version in bun.lock.
   */
  @func()
  async toolchain(@argument({ defaultPath: "/.prototools" }) prototools: File): Promise<Container> {
    const versions = parsePrototools(await prototools.contents())
    const bun = dag.container().from(pinned(`oven/bun:${requireVersion(versions, "bun")}`)).file("/usr/local/bin/bun")
    return dag
      .container()
      .from(pinned(`node:${requireVersion(versions, "node")}-bookworm`))
      .withFile("/usr/local/bin/bun", bun)
      .withEnvVariable("MOON_TOOLCHAIN_FORCE_GLOBALS", "true")
      .withMountedCache("/root/.bun/install/cache", dag.cacheVolume("bun-install"))
  }

  /** The toolchain plus the repository: a one-commit git repository (moon needs a VCS) and the frozen Bun install. */
  @func()
  async workspace(@argument({ defaultPath: "/", ignore: IGNORE }) source: Directory): Promise<Container> {
    const toolchain = await this.toolchain(source.file(".prototools"))
    return toolchain
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["sh", "-c", "git init -q && git add -A && git -c user.name=ci -c user.email=ci@localhost commit -qm ci"])
      .withExec(["bun", "install", "--frozen-lockfile"])
  }
}
