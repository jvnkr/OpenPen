# Electron over Tauri

**Status:** accepted

OpenPen needs a transparent, always-on-top, click-through overlay that spans
multiple monitors and can reliably exclude _itself_ from screen capture on
Windows (so recordings show the ink but not the toolbar). We chose Electron
over Tauri because Chromium + Electron's Windows window management give us
dependable `setContentProtection` (WDA_EXCLUDEFROMCAPTURE), `desktopCapturer`,
non-activating always-on-top windows, and per-display overlays out of the box —
capabilities Tauri's system webview did not offer reliably at the time.

**Consequence:** a larger bundle than a Tauri build. Accepted deliberately in
exchange for stability and the capture/window-management guarantees above.
