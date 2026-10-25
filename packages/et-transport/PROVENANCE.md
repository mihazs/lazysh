# Transport provenance

The crypto adapter in `src/crypto.rs` adapts the MIT-licensed `crypto.rs` from [AArnott/eternal-terminal-client](https://github.com/AArnott/eternal-terminal-client/blob/6c3da110b4b9bb0a82b2c1f37343d51eaebe3d3d/src/crypto.rs). The original copyright notice (`Copyright (c) 2026`) and MIT license are retained in `LICENSE-MIT`. lazysh's adaptation follows the project's GPL-3.0-or-later license in `LICENSE`. Changes remove mutexes from the single-owner crypto state, zeroize retained keys, refuse direction-counter exhaustion, and expose errors through this package's bounded transport API.

The connection/recovery design was informed by that project's `connection.rs` and `backed.rs`, and verified against the Apache-2.0 [official ET 7.0.0 source](https://github.com/MisterTea/EternalTerminal/tree/7656a32a5bc15c6746726a27a5a4ba1e468fab6e). `src/proto.rs` defines compatible messages using field numbers from `proto/ET.proto` and `proto/ETerminal.proto`. This package does not contain the official C++ implementation or its CLI bootstrap/terminal code.

Real interoperability uses the official release source archive `et_7.0.0.orig.tar.gz`, SHA-256 `3065d282c552bc40b8f0d455e1cae2089847c9c4f7f9b4ca07b89f7c653af98e`, matching the GitHub release API digest. Its CMake build used system dependencies with `DISABLE_VCPKG=ON`, `BUILD_TESTING=OFF`, `DISABLE_SENTRY=ON`, and `DISABLE_TELEMETRY=ON`. Native build products are outside this repository. No upstream test scripts are used by this package.

See `docs/et-research.md` at the repository root for the separate released/development protocol boundary and shipped-artifact Evidence.
