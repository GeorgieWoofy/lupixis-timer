# Lupixis Timer — spec and roadmap

## Goals
1. **One engine, many outputs.** A single timer drives the floating window, confidence monitors, broadcast graphics and Stream Deck buttons. They never disagree.
2. **Works with tiny setups.** One laptop with a presenter view should be enough: the floating always-on-top window plus global hotkeys.
3. **Scales to big setups.** Fullscreen outputs on extra displays, browser views on any device, and OBS/vMix browser sources.
4. **Companion is first-class.** Actions, feedbacks, variables and presets come from the start, not as an add-on later.
5. **LAN-first.** No internet needed, which suits venues and is more secure. Remote access can come later.
6. **Maintainable by a small team.** Plain JavaScript (ES modules) and no front-end build step. There are only three runtime dependencies (`ws`, `qrcode`, Electron).

## Key decisions
- **Server-authoritative timer.** The server stores *when* a timer started, not a ticking counter. Each client syncs its clock to the server with NTP-style pings and draws the time itself. This keeps the display smooth on every screen, and a restart can resume a running countdown.
- **Confidence vs. broadcast.** The confidence view is functional: black, maximum-size digits, colour for urgency. The broadcast view is designed: theme, logo, fonts and animations. By default it holds at 00:00 instead of showing overtime to an audience.
- **Electron** gives a reliable always-on-top window above fullscreen PowerPoint (the `screen-saver` level, re-asserted every 2 s), plus multi-display outputs and global shortcuts on Windows and macOS.
- **Companion module on @companion-module/base 1.12.** That keeps it compatible with Companion 4.0–5.x. The v2 API only runs on Companion 4.3+.

## Timer types
- **Countdown:** the planned duration, going into overtime after zero.
- **Count up:** elapsed time, with colours still based on the planned duration.
- **Until time:** counts down to a time of day, e.g. "stream starts at 19:00". It always runs.

## Roadmap (suggested order)
1. **Field test:** run a real event and adjust readability, hotkeys and defaults.
2. **Controller PIN:** an optional password for `/controller`, with read-only links for clients.
3. **Speaker → operator feedback:** a "message seen" acknowledgement, or a "need help" button on a tablet viewer.
4. **OSC input:** for QLab and lighting desks. The HTTP API already covers most cases.
5. **Agenda view:** the full rundown with planned start times and how far ahead or behind the show is.
6. **Audio chime** at the warning point and at zero.
7. **Remote presenter link:** a secure tunnel (e.g. Cloudflare Tunnel) to share one read-only viewer over the internet.
8. **macOS build:** the code is already cross-platform. It needs an `electron-builder` mac target and signing.
9. **NDI output** with alpha. This means rendering the overlay offscreen and sending frames via an NDI SDK binding.
10. **Auto-update and code signing** before wider distribution.
