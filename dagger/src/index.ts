/** Lazysh CI as code: the same functions run on a laptop (`dagger call`) and in GitHub Actions. See docs/how-to/run-ci-locally-with-dagger.md. */
import { dag, Container, Directory, File, argument, object, func } from "@dagger.io/dagger"
import { pinned, RUST, UBUNTU } from "./images.js"
import { parsePrototools, requireVersion } from "./prototools.js"

// Left out of the build context: what the container recreates (dependencies, build output) and what is local state.
// `.git` is excluded because a worktree's `.git` is a file pointing outside the context; `withSource` builds a one-commit repository instead.
const IGNORE = [".git", "**/node_modules", "**/target", ".moon/cache", ".turbo", "**/.gradle"]

// The tasks the client job checks, in the order `moon` runs them.
const CLIENT_TASKS = ["client:build", "client:check", "client:test", "client:check-mobile-e2e", "client:lint-mobile-e2e", "client:test-mobile-e2e-unit"]

@object()
export class Ci {
  /**
   * Ubuntu 24.04 (the runner image's distribution) with Node and Bun at the versions `.prototools` pins and the tools the CI scripts' tests rely on,
   * without the source, so a source change keeps these layers cached. moon is not installed here: `bun x moon` runs the version in bun.lock.
   */
  @func()
  async toolchain(@argument({ defaultPath: "/.prototools" }) prototools: File): Promise<Container> {
    const versions = parsePrototools(await prototools.contents())
    const bun = dag.container().from(pinned(`oven/bun:${requireVersion(versions, "bun")}`)).file("/usr/local/bin/bun")
    const node = dag.container().from(pinned(`node:${requireVersion(versions, "node")}-bookworm`)).directory("/usr/local")
    return dag
      .container()
      .from(pinned(UBUNTU))
      .withExec(["sh", "-c", "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq tmux strace openssl openssh-client openssh-server libnss-wrapper bubblewrap adb iproute2 && mkdir -p /run/sshd && rm -rf /var/lib/apt/lists/*"])
      .withDirectory("/usr/local", node)
      .withFile("/usr/local/bin/bun", bun)
      .withEnvVariable("MOON_TOOLCHAIN_FORCE_GLOBALS", "true")
      .withMountedCache("/root/.bun/install/cache", dag.cacheVolume("bun-install"))
  }

  /** The toolchain plus the repository: a one-commit git repository (moon needs a VCS) and the frozen Bun install. */
  @func()
  async workspace(@argument({ defaultPath: "/", ignore: IGNORE }) source: Directory): Promise<Container> {
    return this.withSource(await this.toolchain(source.file(".prototools")), source)
  }

  /**
   * The checks of the `client` CI job: hook and CI-script tests, the client moon tasks, then the Playwright e2e suites with both terminal backends.
   * Pass the repository's real `.git` and the pull request's `base` (for example origin/main) to run only the affected tasks, as the job does on a pull request;
   * without `base` every task runs, as on a push to main.
   */
  @func()
  async client(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
    @argument({ defaultPath: "/.git" }) git: Directory,
    base = "",
  ): Promise<string> {
    // The runner image carries cargo too (moon-graph runs `cargo metadata`), so the container gets it explicitly.
    const rust = dag.container().from(pinned(RUST))
    const tools = (await this.toolchain(source.file(".prototools")))
      .withDirectory("/usr/local/cargo", rust.directory("/usr/local/cargo"))
      .withDirectory("/usr/local/rustup", rust.directory("/usr/local/rustup"))
      .withEnvVariable("RUSTUP_HOME", "/usr/local/rustup")
      .withEnvVariable("CARGO_HOME", "/usr/local/cargo")
      .withEnvVariable("PATH", "/usr/local/cargo/bin:$PATH", { expand: true })
      .withEnvVariable("CI", "true")
    const moon = base
      ? ["bun", "x", "moon", "ci", ...CLIENT_TASKS, "-g", "-c", "1"]
      : ["bun", "x", "moon", "run", ...CLIENT_TASKS, "-c", "1"]
    return this.withSource(tools, source)
      .withExec(["rm", "-rf", ".git"])
      .withDirectory("/src/.git", git)
      .withMountedCache("/src/.moon/cache", dag.cacheVolume("moon-cache"))
      .withMountedCache("/root/.cache/ms-playwright", dag.cacheVolume("playwright-browsers"))
      .withExec(["bun", "run", "test:hooks"])
      // bubblewrap (the owned-SSH fixtures) needs user namespaces, which an unprivileged container exec does not get.
      .withExec(["bun", "run", "test:ci"], { insecureRootCapabilities: true })
      .withEnvVariable("MOON_BASE", base)
      .withExec(moon, { insecureRootCapabilities: true }) // the mobile-e2e unit suite starts owned sshd fixtures under bubblewrap too
      .withWorkdir("/src/apps/client")
      .withExec(["bun", "x", "playwright", "install", "--with-deps", "chromium"])
      .withEnvVariable("LAZYSH_E2E_TERMINAL_BACKEND", "xterm")
      .withExec(["bun", "x", "moon", "run", "client:test-e2e"])
      .withEnvVariable("LAZYSH_E2E_TERMINAL_BACKEND", "native")
      .withExec(["bun", "run", "test:e2e:terminal"])
      .stdout()
  }

  private withSource(toolchain: Container, source: Directory): Container {
    return toolchain
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["sh", "-c", "git init -q && git add -A && git -c user.name=ci -c user.email=ci@localhost commit -qm ci"])
      .withExec(["bun", "install", "--frozen-lockfile"])
  }
}
