# lazysh-terminal-renderer-wgpu

wgpu implementation of the [Terminal Renderer API](../../docs/architecture/native-rendering.md#terminal-renderer-api)
([#1324](https://github.com/mihazs/lazysh/issues/1324), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)).
Not wired into the app: the Android surface is [#1327](https://github.com/mihazs/lazysh/issues/1327). Real fonts
([#1325](https://github.com/mihazs/lazysh/issues/1325)), cursor blink, scale changes and loss recovery
([#1326](https://github.com/mihazs/lazysh/issues/1326)) are in.

What it does, and where the tests that show it live:

| Property | How | Test |
| --- | --- | --- |
| Same pixels as the CPU reference renderer and the Renderer API's golden PNGs | `layout::row_draws` becomes instanced quads (one pipeline, 32 bytes per instance), glyph masks come from an atlas | `tests/vs_reference.rs` |
| Dirty-row batching | The target persists; a frame submits the instances of the rows that changed (backgrounds merged into runs, the theme background dropped) in one pass | `tests/frames.rs`, `tests/vs_reference.rs` |
| No frames while idle | `needs_draw()` is false and `draw()` touches nothing for an unchanged screen; `GpuStats::submissions` counts what was submitted | `an_unchanged_screen_submits_nothing_and_asks_for_no_frame` |
| Bounded GPU memory | A fixed-size atlas of one- and two-cell slots with LRU eviction (`src/atlas.rs`); a frame with more distinct glyphs than slots is drawn in several passes; the instance buffer is capped | `memory_has_an_upper_bound_under_glyph_churn`, `an_atlas_smaller_than_the_screen_draws_the_same_pixels`, unit tests in `src/atlas.rs` |
| Explicit cleanup | `destroy` destroys every buffer and texture, then reads the driver's counters | `destroy_releases_the_buffers_and_textures_it_created` |
| Capability fallbacks | `Policy` ranks backends (Vulkan then OpenGL ES on Android and Linux, Metal on Apple, Direct3D 12 then Vulkan on Windows); software adapters are refused unless allowed; no usable adapter is `RenderError::Unsupported`, not a loss | `src/adapter.rs` unit tests, `tests/frames.rs` |
| Device loss | `resume` builds a new device from core state; a loss reported by a device that was already replaced is ignored; a reset the renderer was not told about is learned from the device | `a_lost_device_recovers_from_a_snapshot`, `tests/lifecycle.rs` (five losses, identical pixels, resource counts, bounded time) |
| Cursor blink | `wants_blink_timer()` and the host-side `BlinkClock`: one timer for every session, none for a steady or hidden cursor; a phase is one row in one pass | `tests/lifecycle.rs` (virtual time) |
| Display scale and refresh rate | `CellMetrics::scaled` and `set_appearance` + `resize` repaint from the held screen; `FramePacer` draws at most once per refresh | `tests/lifecycle.rs`, goldens at 2x and 3x |
| Fonts, fallback and grapheme clusters | `Target::with_fonts(FontLibrary)`: the host registers font bytes per family and style, `Appearance::font_families` orders them (preferred family, then the fallback list; unknown names skipped, other registered families last; `FontLibrary::restrict` limits a family such as the imported CJK font to its Unicode ranges, as `fonts.ts` does, so it never draws Latin text from the primary font). A cluster takes the first family that has all its scalars (a color face for emoji presentation), is shaped alone with `swash` (GPOS marks, GSUB ZWJ, flag and keycap sequences), fitted to the cells the core gave it (shrunk if wider, centered if narrower) on one baseline, and rasterized unhinted. Coverage goes to the `R8` atlas, color glyphs to a separate `RGBA8` atlas. Bold and italic use the family's faces, else are synthesized. `set_fonts` swaps fonts live | `tests/text.rs`, goldens `tests/golden/text_*.png` |
| Selection highlight | the layout's selection overlay; a drag redraws only the rows it changes | `a_selection_drag_redraws_only_the_rows_it_changes_and_matches_the_reference` |

The surface is an offscreen texture (`Target`), which is what the tests and examples read back with `read_image`.
Without a `FontLibrary` glyphs are the reference renderer's dot patterns, which is what the pixel-for-pixel parity tests
against the CPU renderer use; with one they are real glyphs and the checks are the text tests and goldens (within 2 per
channel, because the GPU blends the last bit). The fonts of those tests are subsets, see [`tests/fonts`](tests/fonts/README.md).
Fonts are bytes the host provides, never looked up by name on the machine: the user's imported fonts live in the
WebView's storage and system fonts differ per platform.

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
cargo +1.96.1 run --release --example text_stats       # glyph cache hit rate and text time with real fonts
```

`UPDATE_GOLDEN=1 cargo test --test renderer` in the runtime crate rewrites the goldens both renderers are compared with;
`UPDATE_GOLDEN=1 cargo test --test text` here rewrites `tests/golden/text_*.png` (look at them before committing).
