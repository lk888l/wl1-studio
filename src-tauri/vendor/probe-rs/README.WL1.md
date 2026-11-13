# WL1 Studio's pinned probe-rs transport extension

Source: crates.io `probe-rs` 0.32.0, upstream commit
`48f5e4d53c690a1d40c2454033c6f785b4f4f95c`, package SHA-256
`b86561c00e5b857b2807ff4c41059666d8168aea45c180d02dceaa3d6df32f02`.
The original source and target algorithms are included to keep builds independent
of a modified Cargo cache, external firmware checkout, or installed OpenOCD.
Original MIT / Apache-2.0 licenses are included from that same upstream commit.

Local changes cover `src/probe/cmsisdap/mod.rs`,
`src/probe/cmsisdap/commands/mod.rs`, `src/probe/usb_util.rs`, and
`src/flashing/flasher.rs`:

- Add `CmsisDapTransport::exchange` and `CmsisDap::new_from_transport` for an owned,
  synchronous packet transport. USB HID/Bulk paths remain intact.
- Reuse all existing CMSIS-DAP SWD/JTAG, ARM, target discovery, Flash algorithms,
  verification, and reset behavior.
- A custom transport does not use USB draining or 50 ms packet-size retries.
  It confirms the prevalidated packet size once and has no SWO streaming endpoint.
- The application implements TCP framing, same-socket serial validation, bounded
  reads/writes, connection poisoning, and no replay in `src/sticks3_network.rs`.
- Reuse USB bulk endpoints for CMSIS-DAP command traffic through the shared
  bounded-transfer helpers in `usb_util.rs`.
- After a successful sector erase, skip programming raw pages whose contents
  (including preserved bytes) already equal the erased value. Keep every page in
  the layout and verify it afterwards, including skipped pages. Do not skip when
  erase is disabled or the algorithm uses encoded data. Both single and double
  buffering still account for skipped bytes in progress.

No new dependency versions were introduced. The main lockfile only changes
probe-rs from a registry source to this local source. Application tests exercise
the real driver over fake TCP peers and an opt-in physical StickS3; see
`docs/sticks3-integration.md` in the repository root for commands and limitations.

When upgrading probe-rs, prefer an upstream packet transport API if available;
otherwise reapply this small extension and rerun the USB and TCP regressions.
The opt-in `wl1_stlink_performance_and_preservation` application test exercises
the actual firmware worker against an independently captured full Flash backup,
including preservation outside the image, unaligned verification, and a mismatch
at the final Flash byte. See `docs/wl1-firmware.md` for the ST-Link benchmark.
The application's `src/firmware_target.rs` also selects 16 KiB programming
buffers for the fingerprinted F411CE main-Flash algorithm, with proportionally
scaled timeouts. Its instruction bytes and physical erase sectors are unchanged;
RAM capacity, two buffers, sector alignment, and other targets are regression
checked. Upgraded algorithm bytes fall back to the original buffer settings.
