# WL1 Studio's pinned probe-rs transport extension

Source: crates.io `probe-rs` 0.32.0, upstream commit
`48f5e4d53c690a1d40c2454033c6f785b4f4f95c`, package SHA-256
`b86561c00e5b857b2807ff4c41059666d8168aea45c180d02dceaa3d6df32f02`.
The original source and target algorithms are included to keep builds independent
of a modified Cargo cache, external firmware checkout, or installed OpenOCD.
Original MIT / Apache-2.0 licenses are included from that same upstream commit.

Local changes are limited to `src/probe/cmsisdap/mod.rs` and
`src/probe/cmsisdap/commands/mod.rs`:

- Add `CmsisDapTransport::exchange` and `CmsisDap::new_from_transport` for an owned,
  synchronous packet transport. USB HID/Bulk paths remain intact.
- Reuse all existing CMSIS-DAP SWD/JTAG, ARM, target discovery, Flash algorithms,
  verification, and reset behavior.
- A custom transport does not use USB draining or 50 ms packet-size retries.
  It confirms the prevalidated packet size once and has no SWO streaming endpoint.
- The application implements TCP framing, same-socket serial validation, bounded
  reads/writes, connection poisoning, and no replay in `src/sticks3_network.rs`.

No new dependency versions were introduced. The main lockfile only changes
probe-rs from a registry source to this local source. Application tests exercise
the real driver over fake TCP peers and an opt-in physical StickS3; see
`docs/sticks3-integration.md` in the repository root for commands and limitations.

When upgrading probe-rs, prefer an upstream packet transport API if available;
otherwise reapply this small extension and rerun the USB and TCP regressions.
