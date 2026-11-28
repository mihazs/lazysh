# ECDSA private scalars with leading zero bytes

Based on the crates.io `ssh-key` **0.7.0-rc.11** release (crate SHA-256
`f9a32fae177b74a22aa9c5b01bf7e68b33545be32d9e381e248058d2adc15ce3`; 0.7.0-rc.12
has the same defect). Original MIT/Apache-2.0 licenses and notices are retained.
The upstream tests, changelog, `Cargo.lock` and `[[test]]` targets are dropped.

OpenSSH stores an ECDSA private scalar as an SSH `mpint`, which omits leading zero
bytes. About one P-256 key in 256 has a scalar whose first byte is zero, so its
`mpint` is 31 bytes. Upstream `private/ecdsa.rs` rejected any `mpint` shorter than
32 bytes with `Encoding(Length)`, so `ssh-keygen`-generated keys failed to import
(#2483). The patch accepts any length from 1 byte to the curve size; the existing
code already left-pads the value with zeros.

The regression test is `identities::tests::openssh_files::ecdsa_scalar_with_a_leading_zero_byte_imports`.
Drop this patch once an upstream release decodes short ECDSA scalars.
