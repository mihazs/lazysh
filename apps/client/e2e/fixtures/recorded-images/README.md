# Original recorded-image fixtures

These pixel artworks were authored for lazysh and are covered by the repository license. No external image, network download, photograph, or image-generation service was used.

Created once with the already installed Pillow 12.3.0: an RGB 32 × 16 canvas, pure red left half and pure blue right half. PNG uses the default PNG encoder. JPEG uses quality 100, no chroma subsampling, and EXIF tag 274 (Orientation) = 6. Its encoded dimensions remain 32 × 16; displaying EXIF correctly rotates clockwise to 16 × 32, red above blue. Color samples allow JPEG compression tolerance.

The APNG is a valid two-frame PNG: the same first frame followed by a solid green 32 × 16 frame, each lasting 100 ms, looping forever. Pillow independently reopened and decoded every file and verified the JPEG orientation and APNG frame count at creation. The adversarial browser fixture submits this APNG as an imagePreview and expects rejection before bitmap allocation.

The progressive JPEG encodes the same PNG artwork at quality 100 with no chroma subsampling and `progressive=True`, without EXIF rotation. Pillow reopened it, decoded its pixels and reported `progressive=1`. The native admission fixture accepts it within the enforced byte/dimension limits; this is decoder acceptance evidence, not a peak-memory measurement or proof of the advisory allocation budget.

The one-off asset creation did not add a generator script or dependency. Tests read these committed bytes directly.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `regions.png` | 99 | `d75324ced53609627157801dede12bee4b67d086d05d3a9b9370074ba15cc2f5` |
| `regions-orientation6.jpg` | 705 | `f69150a14322c44ec6ee5dfd597da76eb3f58494c06f0dd7a9df3fd0df177623` |
| `regions-animated.png` | 249 | `c73d89f139df0c2dc27ef74069f34f122338fa9d7deee37de000d02a412e98e0` |
| `regions-progressive.jpg` | 541 | `f1645e28cea98a315d159e4a68c0d3763b34f4e489ec9722f91ff23b58359a71` |
