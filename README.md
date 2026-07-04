<div align="center">
  <h1>OpenPen</h1>
  <p>A free and open source on-screen annotation tool for Windows. Draw over anything on your screen.</p>
</div>

[![CI](https://github.com/jvnkr/openpen/actions/workflows/ci.yml/badge.svg)](https://github.com/jvnkr/openpen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat)](LICENSE)

## Download

Get the latest Windows installer from [Releases](https://github.com/jvnkr/OpenPen/releases).

## Features

- Draw over any app with a transparent overlay that stays on top
- Works on every monitor. Undo and redo apply to the screen under your cursor
- Recording friendly. Ink shows up in OBS and Zoom. The toolbar can stay hidden from recordings
- Switch between draw mode and mouse mode with one hotkey. Your ink stays visible either way
- Pen, highlighter, eraser, line, arrow, rectangle, ellipse, text, and drag to move objects
- Fading ink for temporary annotations. Strokes fade out on their own, with an adjustable duration
- Custom color picker with a palette you build yourself. Add swatches, pick a color from the screen, and adjust brush size with a slider, `[` `]`, or the mouse wheel
- Unlimited undo and redo, plus clear screen
- Whiteboard and blackboard modes
- Hide or show ink without clearing it
- Save a screenshot with your annotations to `Pictures\OpenPen\`
- System tray with quick actions. Draggable toolbar
- Auto-updates from GitHub Releases, with update status in Settings
- Light and dark themes
- Customize global hotkeys in Settings. Reset per action or all at once, unbind shortcuts you do not need

## Hotkeys

Default global shortcuts are listed below. Change them in **Settings → Hotkeys**.

| Hotkey | Action |
| --- | --- |
| `Ctrl+Shift+D` | Toggle draw / mouse mode |
| `Ctrl+Shift+0` | Mouse mode |
| `Ctrl+Shift+1` … `Ctrl+Shift+9` | Pen, drag/move, highlighter, eraser, text, line, arrow, rectangle, ellipse |
| `Ctrl+Shift+C` | Clear screen |
| `Ctrl+Shift+U` | Undo |
| `Ctrl+Shift+Y` | Redo |
| `Ctrl+Shift+S` | Save screenshot |
| `Ctrl+Shift+W` / `Ctrl+Shift+B` | Whiteboard / blackboard |
| `Ctrl+Shift+H` | Hide / show ink |
| `Ctrl+Shift+T` | Show / hide toolbar |

While drawing on the overlay, `[` and `]` (or the mouse wheel) adjust brush size. Hold **Shift** while drawing shapes to lock to squares, circles, or 45° lines.

While ink is on screen, `Ctrl+Z` undoes and `Ctrl+Shift+Z` or `Ctrl+Y` redoes on the display under your cursor.

Text tool: click to place, type, `Enter` to commit, `Shift+Enter` for a new line, `Esc` to cancel.

Fading ink: open the timer button in the toolbar to turn it on and set how long strokes stay visible.

## Recording with OBS

**Display Capture (recommended):** ink is drawn on screen, so a Display Capture source records it with no extra setup. Turn on "Hide UI from recordings" in Settings or the tray menu to keep the toolbar out of your recording.

**Window / Game Capture:** add a Window Capture source for the window named `OpenPen Overlay` (one per display), layer it above your game, and set the capture method to "Windows 10 (1903 and up)".

## Development

```bash
pnpm install
pnpm dev
pnpm start
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm dist
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout and how to cut a release.

## Contributing

Bug reports and pull requests are welcome. Please run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` before opening a PR.

## License

[MIT](LICENSE)
