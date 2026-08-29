# WL1 Studio Device Control Center

[简体中文](README.md) | **English**

This repository implements an extensible, multi-product desktop control application. The application opens on a product home page and then enters the connection, telemetry, tuning, and diagnostics workspace for the selected product. The first and currently only integrated product is the **WL1 wheel-legged robot**, whose workspace is named **WL1 Studio (WL1 Control Center)**. The project follows the Tauri + React approach used by [hex-gui](https://github.com/hex-meow/hex-gui), while avoiding additional repositories or Git submodules and focusing on a smaller dependency set, a bright liquid-glass interface, and a replaceable communication layer.

> [!WARNING]
> A wheel-legged robot can move suddenly because of incorrect parameters, protocol misidentification, or communication faults. Before the first connection and every tuning session, read the [Safety Guide](docs/safety.md), lift the drive wheels off the ground, prepare a physical emergency stop, and keep people outside the motion area. This software is not a safety controller and cannot replace firmware-side limits, watchdogs, or emergency-stop circuitry.

## Current scope

The current phase focuses on an extensible “product home + isolated product workspace” foundation. The WL1 compatibility layer was checked against both the committed `feature/framework@8f8eb82` baseline and the uncommitted control/communication changes in the local firmware working tree as of 2026-08-24. The interface can still be developed independently with Mock data. Future products can provide their own protocol, pages, and safety policy; future WL1 firmware changes should remain concentrated in the protocol adapter rather than requiring page rewrites.

The first release covers these core scenarios:

- clear any stale device session when the product home starts, then select the WL1 wheel-legged robot; return to the catalog only after the current session has ended safely;
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
- The firmware has no stable version or capability-negotiation protocol. Real serial writes therefore require an independent confirmation that the device matches the two supported Legacy WL1 baselines. Without confirmation the session is read-only, and unknown commands are never sent automatically.
- When telemetry is requested, the frontend disarms real-time control after a channel becomes stale. Rust locks the session after a wider two-second window, repeated parse failures, or frame-boundary loss. All stream-disable commands remain best effort.

See the [Firmware Integration Guide](docs/firmware-integration.md) for the complete protocol boundary.

## Technology

- [Tauri 2](https://tauri.app/): desktop shell, serial access, and system capability boundaries;
- Rust: device state, command validation, communication adapters, and telemetry parsing;
- React 19 + TypeScript: frontend pages and type-safe command wrappers;
- Vite 6: development server and frontend build;
- Lucide React: lightweight icons;
- native CSS: design tokens, responsive layout, and the bright liquid-glass appearance.

The project deliberately avoids a large UI component library. The liquid-glass effect uses translucent backgrounds, `backdrop-filter`, outlines, and soft shadows inside an opaque light window, avoiding the scaling and GPU compositing problems commonly seen with native transparent windows on Windows.

## Requirements

The recommended Windows development environment includes:

- Node.js 20.18 or newer;
- npm 10.8 or newer;
- the Rust stable-msvc toolchain installed through rustup;
- Visual Studio 2022 Desktop development with C++;
- Microsoft Edge WebView2 Runtime.

The repository uses its project-local `@tauri-apps/cli` package; a global Tauri CLI installation is unnecessary. The initial installation of frontend and Rust dependencies requires network access.

## Quick start

```powershell
# Install frontend dependencies and generate the committed package-lock.json
npm install

# Start only the Vite frontend in a browser; use Mock mode without hardware
npm run dev

# Start the complete Tauri desktop application
npm run tauri dev
```

Run these checks before committing:

```powershell
npm run typecheck
npm test
npm run build
```

If Rust is not installed yet, the frontend can still be developed with `npm run dev`. A complete desktop build requires Rust stable-msvc. See the [Development Guide](docs/development.md) for environment details.

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
│   ├── development.md             # Development, testing, and build workflow
│   └── safety.md                  # Real-device operation and development safety
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
- [Development guide](docs/development.md)
- [Safety guide](docs/safety.md)

## Upstream and references

- WL1 firmware: [lk888l/wheeled-legged_Robot-WL1](https://github.com/lk888l/wheeled-legged_Robot-WL1)
- Host application reference: [hex-meow/hex-gui](https://github.com/hex-meow/hex-gui)

Command semantics in this project use the local WL1 `feature/framework@8f8eb82` source and the uncommitted working tree as of 2026-08-24 as a two-layer baseline. Because that working tree is still changing, it cannot be identified by a commit alone. Recheck `commands.md`, `communication_module.cpp`, and `motion_control_module.cpp` and complete bench testing after every relevant change.
