# Run tasks with moon

Run, inspect and debug workspace tasks with [moon](https://moonrepo.dev). The lookup tables are in the
[moon task reference](../reference/moon-tasks.md).

## Install

`bun install --frozen-lockfile` installs the pinned `@moonrepo/cli`; `bun run <script>` and `bunx moon ...` find it.
With [proto](https://moonrepo.dev/proto), `proto use` installs the `.prototools` pins for moon, Bun and Node.
Install the Rust toolchain yourself (`rustup`); moon does not manage it.

## Run a task

```sh
bunx moon run client:check            # one project's task
bunx moon run :lint                   # the same task in every project that has it
bunx moon run '#companion:test-rust'  # a task in every project with a tag
bun run check                         # the root alias: moon run :check :check-rust
```

`bunx moon run client:build client:check client:test -c 1` runs several targets one at a time.
Tasks that need a device, a simulator or a real SSH server are opt-in (`runInCI: false`); the root
aliases such as `bun run test:android-tmux` start them with their prerequisites.

## See what will run

```sh
bunx moon projects                                  # the project graph, which also validates the constraints
bunx moon task client:test-android-tmux --json      # the resolved command, env, deps and options
bunx moon query tasks                               # every task, grouped by project
bunx moon action-graph client:test-android-ssh --json   # the tasks a target pulls in
```

## Run only what a change affects

```sh
bunx moon ci -g client:build client:check client:test   # compare with the merge base, follow project relations
bunx moon query tasks --affected --downstream deep      # which tasks the working tree touches
```

The `client` and `agent` pull request jobs do this. `main` and every native job run unfiltered.

## Add or change a task

1. Put a task shared by every Cargo crate in `.moon/tasks/cargo.yml`; put a task for one project in its `moon.yml`.
2. Use the task id with `-` where a script name used `:` (ids cannot contain `:`).
3. Set `options.runInCI: false` on a task that needs an emulator, simulator, browser or real service, and on every
   task in its dependency chain. Leave `cache` off unless the inputs and outputs are fully declared.
4. A task that sets a constant already present in the environment (`LAZYSH_ANDROID_UI_QR=1`) needs
   `options.envOverride: true`, otherwise the process value wins.
5. Add the project's Cargo dependencies that moon cannot infer (`cfg` targets, `[patch]`) to its `dependsOn`.
6. Run `bunx moon task <target> --json` and `bun test tests/moon-graph.test.ts`.

## Debug

- `bunx moon task <target> --json` shows exactly what moon resolved, including inherited tasks.
- `bunx moon run <target> --log debug` prints the environment and hashing decisions.
- `bunx moon clean` drops stale cache entries; the cache lives in `.moon/cache` and is ignored by Git.
