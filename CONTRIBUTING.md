# Contributing to OpenPen

Thanks for your interest in improving OpenPen! This is a small, focused
project: an on-screen annotation overlay for Windows. Contributions of all
sizes are welcome.

## Getting started

```bash
pnpm install
pnpm dev
```

Requirements: Node 24+ and [pnpm](https://pnpm.io) (the repo pins a version via
`packageManager`; run `corepack enable` to use the right one).

## Before you open a pull request

Run the same checks CI runs:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

All four must pass. CI runs them on every pull request.

See [AGENTS.md](AGENTS.md) for a short codebase map and release steps.

## Project layout

- `src/`: the renderer (Vite-bundled React). Each window has its own entry:
  `overlay/`, `toolbar/`, `picker/`, `settings/`.
  - `src/overlay/engine.ts`: the canvas ink engine.
  - `src/tools.ts`: the single source of truth for the drawing tools.
  - `src/ipc.ts`: the typed contract for renderer and main process messages.
- `electron/`: the main process (`main.ts`) and preload (`preload.ts`),
  compiled separately via `tsconfig.electron.json`.
- `docs/adr/`: architecture decision records.

## Conventions

- **TypeScript is strict.** No `any`; prefer precise types.
- **Comments explain why, not what.** Match the density and voice of the
  surrounding code.
- **Adding a tool?** Add one entry to `src/tools.ts`, its icon to `TOOL_ICONS`
  in `src/toolbar/Toolbar.tsx`, its drawing behaviour to the engine, and the
  matching accelerator to `TOOL_SHORTCUTS` in `electron/main.ts`.
- **Adding an IPC message?** Add it to `src/ipc.ts` (`SendMap`/`RecvMap`), the
  allow-list in `electron/preload.ts`, and the handler in `electron/main.ts`.
- **App icon:** edit `build/icon.svg`, then run `pnpm icons` to regenerate
  `build/icon.png` and the multi-size `build/icon.ico` electron-builder ships.

## Releasing (maintainers)

Releases are built and published by GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)) when a
version tag is pushed. The tag must match `version` in `package.json`.

```bash
# Edit version in package.json, commit, then:
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

Use `npm version patch|minor|major` if you prefer it to bump `package.json` and
create the tag in one step, then `git push --follow-tags`.

The workflow builds on Windows (x64 + arm64) and publishes NSIS installer,
portable, and zip assets to a published GitHub Release for that tag. See
[docs/CODE_SIGNING.md](docs/CODE_SIGNING.md) for the Windows code signing policy.

## Reporting bugs

Open an issue with your OS version, what you did, what you expected, and what
happened. For rendering and overlay issues, note your display setup (multi-monitor,
scaling factor).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
