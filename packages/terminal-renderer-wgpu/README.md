# lazysh-terminal-renderer-wgpu

wgpu implementation of the [Terminal Renderer API](../../docs/architecture/native-rendering.md#terminal-renderer-api)
([#1324](https://github.com/mihazs/lazysh/issues/1324), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)).
Not wired into the app: the Android surface is [#1327](https://github.com/mihazs/lazysh/issues/1327), text with real
fonts is [#1325](https://github.com/mihazs/lazysh/issues/1325), and cursor blink, scale changes and loss recovery
([#1326](https://github.com/mihazs/lazysh/issues/1326)) build on it.

What it does, and where the tests that show it live:

| Property | How | Test |
| --- | --- | --- |
| Same pixels as the CPU reference renderer and the Renderer API's golden PNGs | `layout::row_draws` becomes instanced quads (one pipeline, 32 bytes per instance), glyph masks come from an atlas | `tests/vs_reference.rs` |
| Dirty-row batching | The target persists; a frame submits the instances of the rows that changed (backgrounds merged into runs, the theme background dropped) in one pass | `tests/frames.rs`, `tests/vs_reference.rs` |
| No frames while idle | `needs_draw()` is false and `draw()` touches nothing for an unchanged screen; `GpuStats::submissions` counts what was submitted | `an_unchanged_screen_submits_nothing_and_asks_for_no_frame` |
| Bounded GPU memory | A fixed-size atlas of one- and two-cell slots with LRU eviction (`src/atlas.rs`); a frame with more distinct glyphs than slots is drawn in several passes; the instance buffer is capped | `memory_has_an_upper_bound_under_glyph_churn`, `an_atlas_smaller_than_the_screen_draws_the_same_pixels`, unit tests in `src/atlas.rs` |
| Explicit cleanup | `destroy` destroys every buffer and texture, then reads the driver's counters | `destroy_releases_the_buffers_and_textures_it_created` |
| Capability fallbacks | `Policy` ranks backends (Vulkan then OpenGL ES on Android and Linux, Metal on Apple, Direct3D 12 then Vulkan on Windows); software adapters are refused unless allowed; no usable adapter is `RenderError::Unsupported`, not a loss | `src/adapter.rs` unit tests, `tests/frames.rs` |
| Device loss | `resume` builds a new device from core state; a loss reported by a device that was already replaced is ignored | `a_lost_device_recovers_from_a_snapshot` |

The surface is an offscreen texture (`Target`), which is what the tests and examples read back with `read_image`.
Glyphs are still the reference renderer's dot patterns; fonts are #1325.

## Build and test

The crate depends on `../terminal-runtime`, which builds libghostty-vt with Zig, so build from a copy outside the
checkout with `herdr-upstream`, `terminal-runtime` and this crate as siblings, as the `herdr-native` CI job does
(see the runtime README). The tests need a GPU adapter and **fail without one** instead of skipping, because a
skipped correctness check looks like a pass. CI has none, so it installs Mesa's software Vulkan (lavapipe) and the
tests use `Policy::for_platform().with_software()`; the shipping policy refuses software adapters.

```sh
cargo +1.96.1 test --locked
cargo +1.96.1 run --release --example wgpu_bench       # pipeline cost against the CPU reference renderer
cargo +1.96.1 run --release --example renderer_stats   # idle, atlas, memory and churn counters
```

`UPDATE_GOLDEN=1 cargo test --test renderer` in the runtime crate rewrites the goldens both renderers are compared with.
