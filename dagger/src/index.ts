// Throwaway spike for issue #2172: NOT for merge. Runs the verdict-client / verdict-agent commands in Dagger.
import { dag, Container, Directory, argument, object, func } from "@dagger.io/dagger"

const BUN = "1.3.14"
const IGNORE = [".git", "**/node_modules", "**/target", ".moon/cache", ".turbo", "**/.gradle", "**/build/outputs"]

@object()
export class Ci {
  // Toolchain layers come before the source so a source change (a PR) does not invalidate them.
  private toolchain(image: string): Container {
    const bun = dag.container().from(`oven/bun:${BUN}`).file("/usr/local/bin/bun")
    return dag
      .container()
      .from(image)
      .withFile("/usr/local/bin/bun", bun)
      .withEnvVariable("MOON_TOOLCHAIN_FORCE_GLOBALS", "true")
      .withMountedCache("/root/.bun/install/cache", dag.cacheVolume("bun-install"))
  }

  // `nonce` changes per run so the source-dependent execs re-run, as they do when a PR changes the source.
  private withSource(c: Container, source: Directory, nonce: string): Container {
    return c
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withEnvVariable("SPIKE_NONCE", nonce)
      // moon needs a VCS; a worktree's .git file points outside the context, so build a one-commit repo instead.
      .withExec(["sh", "-c", "git init -q && git add -A && git -c user.name=ci -c user.email=ci@localhost commit -qm ci"])
      .withExec(["bun", "install", "--frozen-lockfile"])
  }

  @func()
  async client(@argument({ defaultPath: "/", ignore: IGNORE }) source: Directory, nonce = ""): Promise<string> {
    return this.withSource(this.toolchain("node:24-bookworm"), source, nonce)
      .withExec(["bun", "x", "moon", "run", "client:build", "client:check"])
      .stdout()
  }

  @func()
  async agent(@argument({ defaultPath: "/", ignore: IGNORE }) source: Directory, nonce = ""): Promise<string> {
    const rust = this.toolchain("rust:1-bookworm")
      .withExec(["rustup", "component", "add", "rustfmt", "clippy"])
      .withMountedCache("/usr/local/cargo/registry", dag.cacheVolume("cargo-registry"))
      .withMountedCache("/src/target", dag.cacheVolume("agent-target"))
    return this.withSource(rust, source, nonce)
      .withExec(["bun", "x", "moon", "run", "#companion:check-rust", "#companion:lint", "#companion:format-check"])
      .stdout()
  }
}
