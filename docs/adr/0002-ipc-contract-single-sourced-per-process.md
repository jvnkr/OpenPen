# IPC contract & tool registry are single-sourced per process

**Status:** accepted

The renderer and the main process are compiled separately: `tsconfig.electron.json`
sets `rootDir: "electron"` with NodeNext resolution and no `@` path alias, and
`main.ts` depends on `__dirname` resolving to `dist-electron/` to find the
preload script and the built HTML pages. Sharing a module across both worlds
(the typed IPC channel contract in `src/ipc.ts`, the tool registry in
`src/tools.ts`) would require moving `rootDir` up, which shifts the compiled
output layout and breaks those `__dirname`-relative paths.

So we keep those modules **renderer-side**, and the main process mirrors what it
needs in its own small maps: the `ipcMain` channel names, and the tool
accelerator digits in `TOOL_SHORTCUTS`. The channel-name and tool-name strings
are the deliberately-shared vocabulary across the process seam.

**Consequence:** a small, intentional duplication at the seam. Keep the two
sides in step (the code comments point at each other). Don't "dedupe" by
cross-importing without _also_ restructuring the build layout — that's the
trade-off this record exists to flag.
