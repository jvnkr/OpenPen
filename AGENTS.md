# AGENTS.md

Concise map of the OpenPen codebase for contributors and automated tooling.

## What this project is

OpenPen is a free, open source on-screen annotation tool for Windows. It draws
ink over any app using a transparent Electron overlay, a system tray, and a
floating toolbar.

## Layout

- `src/overlay/` – canvas ink engine and overlay window
- `src/toolbar/` – tool palette, color picker, and theme controls
- `src/settings/` – settings window (appearance, hotkeys, recording, updates, about)
- `src/hotkeys.ts` – hotkey definitions (mirrored in `electron/hotkeys.ts`)
- `src/tools.ts` – tool definitions (single source of truth)
- `src/ipc.ts` – typed renderer ↔ main IPC contract
- `electron/main.ts` – main process, hotkeys, tray, auto-update
- `electron/preload.ts` – IPC allow-list exposed to renderers
- `docs/adr/` – architecture decision records

## Checks

Run before opening a PR or cutting a release:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Releases

1. Set `version` in `package.json`.
2. Commit and tag `vX.Y.Z` (tag must match `package.json`).
3. Push `main` and the tag.

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds Windows
x64/arm64 installers and publishes them to GitHub Releases.

## User-facing copy

Keep README, Settings, notifications, and release notes in plain language.
Avoid em dashes in text users see.

## Adding a tool or IPC channel

1. Tool: `src/tools.ts`, icon in `src/toolbar/Toolbar.tsx`, draw logic in
   `src/overlay/engine.ts`, hotkey in `src/hotkeys.ts` and `electron/hotkeys.ts`.
2. IPC: `src/ipc.ts`, `electron/preload.ts`, handler in `electron/main.ts`.
