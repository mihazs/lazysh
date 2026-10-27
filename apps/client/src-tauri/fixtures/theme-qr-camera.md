# Owned camera calibration fixtures

These are synthetic, nonsecret test images. No physical camera or private user image is involved.

| File | Dimensions / bytes | SHA256 | Purpose |
| --- | --- | --- | --- |
| `theme-qr.png` | 212×212 | `ccb83c409118e384e7e3fbee856a4c282984688a582ef7372fb7eb9980f0e778` | Unchanged original PNG/JPEG decoder control. |
| `theme-qr-camera-feed.png` | 640×480 / 8,400 | `d1c857c2360d20c170a3bfde8d65e97f02f79d60167f2e01d4f11afd4632605e` | White RGB canvas with the entire original image copied at `(214,134)`, without resampling or changing symbol pixels. Dedicated emulator input. |
| `theme-qr-camera-cropped.png` | 375×500 / 42,949 | `ae3599cc82aaf2723be4e7657e70ec6b37b52efadaaa8dd15680e22c17c9d76a` | Exact exported negative frame from the original square camera input; native decoder returns no code. |

The captured frame comes from [run40465723548](https://github.com/mihazs/lazysh/actions/runs/40465723548), published head `01610aa1d6744b18ca6d1351fddd1239bc1907d4`, tested merge `a48744a978044f837fbe3739c3310e9ecb35dfe7`. Artifact12717097368 has SHA256 `c9fb17a2c00f9b51e055c91bdc8ffaaf53d2ecd215d5af109d248c1a4fbb3dbd`. Retained HAL `configureStreams` metadata reports width640, height480 and rotation0; public video is480×640. Visual comparison confirms the old square input was cropped. This is emulator fixture calibration, not a production camera or decoding change.

The existing native `theme_qr::tests` module pins the captured frame and feed hashes, checks every copied/padding pixel, retains original PNG/JPEG controls, and checks the feed after a90° rotation and375×500 scaling in PNG/JPEG. Those simulated transforms are decoder controls, not proof of actual emulator projection or UI preview success.

The test reconstructs the pixel-copy recipe in memory and verifies it against the checked-in feed with `include_bytes!`. It never writes or regenerates repository assets. The original decoder control is never overwritten. Packaged Android preview acceptance must still pass independently, with no automatic Apply; physical-camera testing remains explicitly waived and unexecuted.
