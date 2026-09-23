# WL1 Studio Device Control Center

[简体中文](README.md) | **English**

This repository implements an extensible, multi-product desktop control application. The product home opens independent workspaces for the **WL1 wheel-legged robot** (connection, telemetry, and tuning) and **GameBox** (read-only serial diagnostics, button visualization, game/tool reference, and local firmware checks). GameBox still requires real-device serial validation; its current firmware has no receive commands or serial updater. The pocket-piano workspace remains an interaction preview, disabled in production by default. The project uses Tauri + React with least-privilege capabilities, a replaceable transport layer, and an auditable release workflow. Builds do not depend on a separate firmware repository.

> [!WARNING]
> A wheel-legged robot can move suddenly because of incorrect parameters, protocol misidentification, or communication faults. Before the first connection and every tuning session, read the [Safety Guide](docs/safety.md), lift the drive wheels off the ground, prepare a physical emergency stop, and keep people outside the motion area. This software is not a safety controller and cannot replace firmware-side limits, watchdogs, or emergency-stop circuitry.

## Current scope

The **StickS3** workspace now includes a dedicated Wi-Fi / BLE connection page over the device's
USB console: scanning, target selection, temporary connections, remember-after-success, four saved
slots per radio, and BLE service discovery. Its SWD page provides USB CMSIS-DAP chip identification,
full Flash reads, hex/ASCII browsing, address navigation, BIN backups, BIN/HEX/ELF/AXF programming,
independent verification, main-Flash erase, and reset. Device ID and the Flash-size register automatically
select a compatible configuration for medium-density STM32F1, STM32F411, or STM32G431.
Reads, erase ranges and file checks use measured capacity, including a full 64 KiB when reported by an F103.
The G431 desktop erase/blank-check/restore cycle passed, including an independent OpenOCD readback.
USB DAP mode is selected on the device and replaces its USB configuration console. Wi-Fi/BLE DAP
still uses separate OpenOCD/bridge tools. See the [StickS3 integration guide](docs/sticks3-integration.md)
and [hardware validation record](docs/sticks3-swd-validation.md).
The automatic-discovery path, F103 identification result, and remaining hardware checks are documented in the
[capacity discovery notes](docs/sticks3-swd-auto-detection.md).

WL1 supports native **discovery and remote control for the BLE-only ZX-D30 module**. Each real connection starts read-only unless explicitly authorized; choose a leg height and enable control before holding W/A/S/D, arrows, or on-screen buttons. Release sends neutral, Space / Escape stops, and losing focus disarms control. Bluetooth uses 10 Hz updates and framed 20-byte BLE packets. See the [Bluetooth guide](docs/bluetooth-control.md) for SoftEngine firmware requirements, platform setup, and 9600-baud telemetry limits.

The WL1 workspace now offers **Direct robot** and **Tune through remote** serial targets. Remote tuning forwards PID and attitude-bias commands through NRF24L01 and requires the companion serial-bridge firmware; the original remote firmware does not start UART RX. It has no robot telemetry or parameter-execution acknowledgements, and physical joysticks retain motion and height control. See the [remote tuning guide](docs/remote-tuning.md). The Legacy telemetry and idle-framing details below apply to direct robot connections.

The codebase now has a cross-platform “product home + isolated workspace + Rust device gateway” foundation. The WL1 compatibility layer was checked against both the committed `feature/framework@8f8eb82` baseline and the uncommitted control/communication changes in the local firmware working tree as of 2026-08-24. GameBox independently receives the `FW2` button-event protocol. Future products should provide their own protocol, Transport, pages, and safety policy, with real interfaces, hardware-free demos, and outstanding device validation clearly identified.

The first release covers these core scenarios:

- clear any stale device session when the product home starts, then select WL1 or GameBox; return to the catalog only after the current session has ended;
- inspect GameBox button events over read-only serial, browse six games and six tools, and check local `.bin` size, vectors, and CRC-32;
- connect to a serial device and display connection state, a static Legacy compatibility description, and separate IMU/RPM telemetry freshness;
- observe IMU and left/right wheel RPM through `showimu -y/-n` and `showrpm -y/-n`;
- tune four PID groups and `legheight`, and send a combined motion target through `R <turn> <velocity> <roll> <height>`;
- save host-side theme settings, display name, telemetry density, and commonly used parameter profiles;
- develop the UI with Mock mode; a replay interface is reserved but not yet implemented;
- preserve a unified interface for future CAN, UDP, and newer firmware protocols.

The current compatibility scope has two layers: the committed HEAD baseline and the local working-tree extension. The application automatically uses only the allowlisted subset shared by both:

- Default serial settings are **115200 baud, 8N1, no flow control**. The firmware documentation claims LF/CRLF support, but the current source does not strip line endings. The application therefore sends separate commands **without a line terminator** through DMA receive-to-idle and leaves an idle interval between writes. This still requires verification on real hardware.
- Command bodies are limited to **32 bytes**. Length is calculated from the encoded body; the firmware truncates anything beyond the first 32 bytes.
- Commands are case-sensitive. Although the firmware parser can skip repeated whitespace, the host allowlist accepts and generates only a canonical form with one ASCII space to reduce frame-boundary and manual-input ambiguity.
- `showimu -y` outputs at approximately 100 Hz: HEAD emits `Roll,Pitch,Yaw`, while the current working tree appends `a=<|a|g>,ok=<0|1>`. The parser supports both. `showrpm -y` still emits `A: ... B: ...` at approximately 20 Hz.
- `anglepid`, `velocitypid`, and `differpid` use `-p/-i/-d <value>`; `rollpid` supports only `-p/-i <value>`.
- `R` does **not** mean wheel radius. It is the strict combined-motion format `R <turn> <velocity> <roll> <height>`. The `legheight` servo task clamps height to **44.5..78.5 mm**.
- Tuning values currently live only in **RAM** and are lost after restart or power-off. HEAD periodically recomputes angle `Kp`/`anglebias`; numeric commands in the current working tree enable a manual override, and `anglepid auto`/`anglebias auto` restore automatic calculation.
- The current working tree adds a 250 ms zeroing timeout for valid `R` frames; the HEAD baseline does not. Because there is no capability handshake, the application still treats watchdog support as unknown. Stopping the desktop software is not a substitute for physical power isolation.
- `R` can be sent only through the typed real-time control channel, not the diagnostics terminal. Every connection must explicitly choose a leg-height target, and `sessionId` isolates delayed tasks and events from older sessions.
- The firmware has no stable version or capability-negotiation protocol. Session-level write permissions and command allowlists remain enforced. A session without write permission is read-only, and unknown commands are never sent automatically.
- When telemetry is requested, the frontend disarms real-time control after a channel becomes stale. Rust locks the session after a wider two-second window, repeated parse failures, or frame-boundary loss. All stream-disable commands remain best effort.

See the [Firmware Integration Guide](docs/firmware-integration.md) for the complete protocol boundary.

## WL1 firmware and Flash

WL1's **Firmware & Flash** page uses embedded probe-rs over ST-Link/SWD, with the target fixed to **STM32F411CEU / 512 KiB**. It supports BIN/HEX/ELF/AXF programming with read-back verification, separate main-Flash erase, and full Flash reads with hex/ASCII browsing and BIN backup. Windows x64 includes the original ST USB driver; Linux includes a narrowly scoped udev rule. USB setup is a manual in-app action with system administrator consent, never a startup/install hook. No external programmer CLI is needed. See the [firmware guide](docs/wl1-firmware.md) for safety and hardware validation limits.

## Motion workbench

WL1 opens on one motion workbench with body pitch bias, leg height, all four PID groups, direction controls, and telemetry. The inline connection bar remembers the last serial port and selects a sole available port without connecting automatically. Numeric editors and sliders share parameter drafts; connecting preserves those drafts, while motion requires an explicitly chosen height and activation. Profiles and local geometry settings are available in an expandable section.

VOFA ranges and slider steps are applied consistently in the UI and TypeScript/Rust validators. See the [range and firmware reference notes](docs/motion-parameter-ranges.md) for source details and version differences.

## GameBox workspace

GameBox receives eight-button diagnostics at **115200 baud / 8N1**, with event visualization and logs. It sends no serial probes, controls, or firmware bytes. The game/tool catalog describes applications running on the device; desktop and browser demos use explicitly labeled synthetic events.

GameBox's **Firmware & Flash** page currently targets **STM32F103C8T6 / 64 KiB**. Embedded probe-rs supports ST-Link programming of BIN/HEX/ELF/AXF, read-back verification, and full 64 KiB reads with hex/ASCII browsing and BIN backups. Updates are restricted to the first **62 KiB**, preserving the last **2 KiB settings** region; reads include both. It shares the existing offline USB setup workflow. **Storage & Checks** retains the independent local BIN size, vector and CRC-32 checker. Versioned serial capabilities, external SPI Flash storage and a recovery bootloader remain plans. See the [GameBox integration guide](docs/gamebox-integration.md) for partition boundaries and pending hardware checks.

## Technology

- [Tauri 2](https://tauri.app/): desktop shell, serial access, and system capability boundaries;
- Rust: device state, command validation, communication adapters, and telemetry parsing;
- React 19 + TypeScript: frontend pages and type-safe command wrappers;
- Vite 8 + Biome: development builds, static analysis, and frontend quality gates;
- Lucide React: lightweight icons;
- native CSS: design tokens, responsive layout, and the bright liquid-glass appearance.

The project deliberately avoids a large UI component library. The liquid-glass effect uses translucent backgrounds, `backdrop-filter`, outlines, and soft shadows inside an opaque light window, avoiding the scaling and GPU compositing problems commonly seen with native transparent windows on Windows.

## Requirements

The verified toolchain is Node.js 24.18, npm 11.16, and Rust 1.95. The repository-local Tauri CLI is used; no global CLI is required. Lockfiles provide repeatable installs, while the first npm/crates download requires network access.

| Platform | Status | Native requirements |
|---|---|---|
| Ubuntu 24.04 x86_64 | Compilation, tests, deb, and AppImage packaging verified | WebKitGTK 4.1, GTK 3, and build tools; see the [Linux guide](docs/linux.md) |
| Windows x64 | Previously compiled and verified; guarded by CI | Visual Studio 2022 C++, WebView2, stable-msvc |
| macOS | Signing and runtime validation not established; unsupported | Xcode, Developer ID, and notarization are future work |

On Ubuntu, `./scripts/bootstrap-ubuntu.sh --with-dialout` installs system dependencies. It does not install Node/Rust and never launches the app as root.

## Quick start

Prepare Ubuntu once with the [Linux guide](docs/linux.md), then use the same project commands on every platform:

```bash
npm ci
npm run check
npm run tauri dev
```

For frontend-only work, run `npm run dev` and use the WL1 Mock or GameBox demo. Real serial connections require the Tauri desktop runtime. Build Linux packages with:

```bash
npm run bundle:linux
```

deb and AppImage artifacts are written below `src-tauri/target/release/bundle/`. The piano interaction preview is available only in development builds or when `VITE_ENABLE_PIANO_PREVIEW=true` is explicitly set; it never accesses hardware. See the [Development Guide](docs/development.md) and [Release Guide](docs/release.md).

## Project layout

```text
.
├── src/                           # React frontend
│   ├── components/ProductHome.tsx # Product selection home
│   └── components/pages/          # WL1 product workspace pages
├── src-tauri/                     # Tauri / Rust backend and desktop configuration
├── docs/
│   ├── architecture.md            # Layers, state, and version strategy
│   ├── firmware-integration.md    # WL1 firmware and transport integration contract
│   ├── gamebox-integration.md     # GameBox serial diagnostics and storage roadmap
│   ├── linux.md                   # Ubuntu development, runtime, and packaging
│   ├── release.md                 # Cross-platform release and signing gates
│   ├── security-audit.md          # Security findings and residual risks
│   ├── development.md             # Development, testing, and build workflow
│   └── safety.md                  # Real-device operation and development safety
├── .github/workflows/             # Cross-platform CI and dependency audits
├── package.json
└── vite.config.ts
```

## Design principles

1. **Safe defaults:** unidentified devices, incompatible protocol major versions, or unknown capabilities remain read-only.
2. **Transport/business separation:** pages never access serial handles. Legacy text commands go through the device gateway and are validated again in Rust for type, range, and length.
3. **Facts separate from assumptions:** documentation explicitly marks confirmed firmware facts, compatibility assumptions, and items requiring real-hardware verification.
4. **Offline development:** Mock and replay transports should cover connection, telemetry, timeout, and error states.
5. **One-repository builds:** no extra protocol repository must be cloned. If packages are split later, prefer a Cargo workspace in this repository.
6. **Chinese first:** the default UI and documentation use Simplified Chinese, while protocol fields and code identifiers remain in English.
7. **Isolated product workspaces:** the product home page only selects an entry; each product independently owns its protocol, device session, pages, and safety constraints.

## Documentation

The supporting guides are currently written in Simplified Chinese:

- [System architecture](docs/architecture.md)
- [Firmware integration](docs/firmware-integration.md)
- [GameBox integration](docs/gamebox-integration.md)
- [PN532 NFC card backup and writing](docs/nfc-pn532.md)
- [Ubuntu 24.04 guide](docs/linux.md)
- [Development guide](docs/development.md)
- [Release guide](docs/release.md)
- [Security audit](docs/security-audit.md)
- [Safety guide](docs/safety.md)
- [Vulnerability disclosure policy](SECURITY.md)

## Upstream and references

- WL1 firmware: [lk888l/wheeled-legged_Robot-WL1](https://github.com/lk888l/wheeled-legged_Robot-WL1)
- Host application reference: [hex-meow/hex-gui](https://github.com/hex-meow/hex-gui)

Command semantics in this project use the local WL1 `feature/framework@8f8eb82` source and the uncommitted working tree as of 2026-08-24 as a two-layer baseline. Because that working tree is still changing, it cannot be identified by a commit alone. Recheck `commands.md`, `communication_module.cpp`, and `motion_control_module.cpp` and complete bench testing after every relevant change.
