import React, { useEffect, useRef, useState } from 'react'
import { Monitor, Moon, Palette, Info, Camera, Sun, Keyboard, RotateCcw, Save, Clipboard, ClipboardCopy, PenLine, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { applyDarkClass } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import type { ScreenshotDest, SettingsState, ThemePref } from '@/ipc'
import { DEFAULT_HOTKEYS, HOTKEY_GROUPS, allHotkeysAtDefault, findHotkeyConflict, hotkeyLabel, UNBOUND_HOTKEY, type HotkeyAction } from '@/hotkeys'
import { HotkeyInput } from './HotkeyInput'
import '@/styles/globals.css'

type Section = 'appearance' | 'canvas' | 'hotkeys' | 'capture' | 'about'

interface SavedState { theme?: ThemePref }

function loadSaved (): SavedState {
  try { return JSON.parse(localStorage.getItem('openpen') ?? '{}') as SavedState } catch { return {} }
}

function resolveTheme (theme: ThemePref): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const THEMES: Array<{ value: ThemePref, label: string, Icon: LucideIcon }> = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon }
]

const SHOT_DESTS: Array<{ value: ScreenshotDest, label: string, Icon: LucideIcon }> = [
  { value: 'file', label: 'Save file', Icon: Save },
  { value: 'clipboard', label: 'Clipboard', Icon: Clipboard },
  { value: 'both', label: 'Both', Icon: ClipboardCopy }
]

const NAV: Array<{ value: Section, label: string, Icon: LucideIcon }> = [
  { value: 'appearance', label: 'Appearance', Icon: Palette },
  { value: 'canvas', label: 'Canvas', Icon: PenLine },
  { value: 'hotkeys', label: 'Hotkeys', Icon: Keyboard },
  { value: 'capture', label: 'Capture', Icon: Camera },
  { value: 'about', label: 'About', Icon: Info }
]

const EMPTY_STATE: SettingsState = {
  protectUi: false,
  hotkeys: DEFAULT_HOTKEYS,
  hotkeyError: null,
  screenshotDir: '',
  screenshotDirDefault: '',
  screenshotDest: 'file',
  restoreInk: true,
  isDev: false,
  version: '',
  canUpdate: false,
  updateStatus: 'idle',
  updateVersion: null,
  updateError: null
}

function updateMessage (state: SettingsState): string | null {
  switch (state.updateStatus) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return state.updateVersion
        ? `Downloading version ${state.updateVersion}…`
        : 'Downloading update…'
    case 'ready':
      return state.updateVersion
        ? `Version ${state.updateVersion} is ready to install.`
        : 'An update is ready to install.'
    case 'uptodate':
      return 'You are on the latest version.'
    case 'error':
      return state.updateError
        ? `Update check failed: ${state.updateError}`
        : 'Update check failed.'
    default:
      return null
  }
}

function Row ({ title, description, children }: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Switch ({ checked, disabled, onChange }: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'bg-primary' : 'bg-input',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block size-4 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

export default function Settings (): React.JSX.Element {
  const [section, setSection] = useState<Section>('appearance')
  const [theme, setThemeState] = useState<ThemePref>(() => loadSaved().theme ?? 'system')
  const [state, setState] = useState<SettingsState>(EMPTY_STATE)
  const [recordingAction, setRecordingAction] = useState<HotkeyAction | null>(null)
  const [pendingHotkey, setPendingHotkey] = useState<{
    action: HotkeyAction
    accelerator: string
    conflict: HotkeyAction
  } | null>(null)
  const rowRefs = useRef<Map<HotkeyAction, HTMLDivElement>>(new Map())
  const [confirmResetAll, setConfirmResetAll] = useState(false)

  useEffect(() => {
    applyDarkClass(resolveTheme(loadSaved().theme ?? 'system') === 'dark')
    const offs = [
      window.openpen.on('theme', t => applyDarkClass(t === 'dark')),
      window.openpen.on('settings-state', setState)
    ]
    window.openpen.send('settings-ready')
    return () => {
      window.openpen.send('hotkey-capture', false)
      offs.forEach(off => off())
    }
  }, [])

  useEffect(() => {
    window.openpen.send('hotkey-capture', recordingAction !== null || pendingHotkey !== null)
  }, [recordingAction, pendingHotkey])

  useEffect(() => {
    if (!pendingHotkey) return
    rowRefs.current.get(pendingHotkey.action)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [pendingHotkey])

  const pickTheme = (t: ThemePref): void => {
    setThemeState(t)
    window.openpen.send('set-theme', t)
  }

  const setProtectUi = (v: boolean): void => window.openpen.send('set-protect-ui', v)
  const setRestoreInk = (v: boolean): void => window.openpen.send('set-restore-ink', v)
  const setScreenshotDest = (d: ScreenshotDest): void => window.openpen.send('set-screenshot-dest', d)
  const applyHotkey = (action: HotkeyAction, accelerator: string, force = false): void => {
    setPendingHotkey(null)
    window.openpen.send('set-hotkey', { action, accelerator, force })
    setRecordingAction(null)
  }
  const trySetHotkey = (action: HotkeyAction, accelerator: string): void => {
    const conflict = findHotkeyConflict(state.hotkeys, action, accelerator)
    if (conflict) {
      setPendingHotkey({ action, accelerator, conflict })
      return
    }
    applyHotkey(action, accelerator)
  }
  const cancelHotkeyEdit = (): void => {
    setPendingHotkey(null)
    setRecordingAction(null)
  }
  const unbindHotkey = (action: HotkeyAction): void => {
    setPendingHotkey(null)
    applyHotkey(action, UNBOUND_HOTKEY)
  }
  const resetHotkeys = (): void => {
    setRecordingAction(null)
    setPendingHotkey(null)
    window.openpen.send('reset-hotkeys')
  }
  const resetOneHotkey = (action: HotkeyAction): void => {
    const defaultAccel = DEFAULT_HOTKEYS[action]
    const conflict = findHotkeyConflict(state.hotkeys, action, defaultAccel)
    applyHotkey(action, defaultAccel, Boolean(conflict))
  }
  const statusMessage = updateMessage(state)
  const checking = state.updateStatus === 'checking' || state.updateStatus === 'downloading'
  const allHotkeysDefault = allHotkeysAtDefault(state.hotkeys)

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-muted/30 p-2">
        <div className="px-2 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Settings
        </div>
        {NAV.map(({ value, label, Icon }) => (
          <button
            key={value}
            onClick={() => setSection(value)}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none',
              section === value
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {section === 'appearance' && (
          <section>
            <h2 className="text-base font-semibold">Appearance</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Customize how OpenPen&apos;s toolbar and panels look.
            </p>
            <div className="mt-4 divide-y">
              <Row title="Theme" description="Use the system setting, or force light or dark.">
                <div className="flex gap-1.5">
                  {THEMES.map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      onClick={() => pickTheme(value)}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-md border px-3 py-2 text-xs transition-colors duration-150 ease-out',
                        theme === value
                          ? 'border-primary bg-accent text-accent-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      )}
                    >
                      <Icon className="size-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </Row>
            </div>
          </section>
        )}

        {section === 'canvas' && (
          <section>
            <h2 className="text-base font-semibold">Canvas</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Control what happens to your ink between sessions.
            </p>
            <div className="mt-4 divide-y">
              <Row
                title="Restore ink on launch"
                description="Save your annotations for each display and bring them back the next time OpenPen starts. Turn off to begin every session with a clean screen and keep no ink on disk."
              >
                <Switch checked={state.restoreInk} onChange={setRestoreInk} />
              </Row>
            </div>
          </section>
        )}

        {section === 'hotkeys' && (
          <section>
            <h2 className="text-base font-semibold">Hotkeys</h2>
            <div className="mt-1 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
              <p>Global shortcuts work from any app.</p>
              <p>Click a shortcut to change it, then hold Ctrl, Shift, or Alt plus a key.</p>
              <p>Backspace or Delete unbinds a shortcut.</p>
              <p>Esc cancels.</p>
            </div>
            {state.hotkeyError && (
              <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {state.hotkeyError}
              </p>
            )}
            <div className="mt-4 space-y-6">
              {HOTKEY_GROUPS.map(group => (
                <div key={group.label}>
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {group.label}
                  </h3>
                  <div className="mt-2 divide-y">
                    {group.actions.map(({ id, label }) => (
                      <div
                        key={id}
                        ref={el => {
                          if (el) rowRefs.current.set(id, el)
                          else rowRefs.current.delete(id)
                        }}
                        className="flex items-start justify-between gap-4 py-2.5"
                      >
                        <div className="min-w-0 pt-1.5 text-sm text-foreground">{label}</div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <div className="flex items-center gap-1.5">
                            <HotkeyInput
                              value={
                                pendingHotkey?.action === id
                                  ? pendingHotkey.accelerator
                                  : state.hotkeys[id]
                              }
                              defaultValue={DEFAULT_HOTKEYS[id]}
                              recording={recordingAction === id && pendingHotkey?.action !== id}
                              onStart={() => { setPendingHotkey(null); setRecordingAction(id) }}
                              onCancel={cancelHotkeyEdit}
                              onChange={accel => trySetHotkey(id, accel)}
                              onUnbind={() => unbindHotkey(id)}
                            />
                            <button
                              type="button"
                              title="Reset to default"
                              aria-label={`Reset ${label} to default`}
                              disabled={state.hotkeys[id] === DEFAULT_HOTKEYS[id]}
                              onClick={() => resetOneHotkey(id)}
                              className={cn(
                                'inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors outline-none',
                                'hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                                'disabled:pointer-events-none disabled:opacity-40'
                              )}
                            >
                              <RotateCcw className="size-3.5" />
                            </button>
                          </div>
                          {pendingHotkey?.action === id && (
                            <div className="max-w-[16rem] rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs">
                              <p className="text-muted-foreground">
                                Used by{' '}
                                <span className="font-medium text-foreground">
                                  {hotkeyLabel(pendingHotkey.conflict)}
                                </span>
                                . Assigning here unbinds it.
                              </p>
                              <div className="mt-2 flex gap-1.5">
                                <Button
                                  size="xs"
                                  onClick={() => applyHotkey(pendingHotkey.action, pendingHotkey.accelerator, true)}
                                >
                                  Assign anyway
                                </Button>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={() => setPendingHotkey(null)}
                                >
                                  Try again
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 border-t pt-4">
              {confirmResetAll ? (
                <div className="max-w-md rounded-md border border-border bg-muted/40 px-3 py-3">
                  <p className="text-sm text-foreground">
                    Reset all hotkeys to their defaults?
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => { resetHotkeys(); setConfirmResetAll(false) }}>
                      Yes
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmResetAll(false)}>
                      No
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  disabled={allHotkeysDefault}
                  onClick={() => setConfirmResetAll(true)}
                >
                  Reset all to defaults
                </Button>
              )}
            </div>
          </section>
        )}

        {section === 'capture' && (
          <section>
            <h2 className="text-base font-semibold">Capture</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Control what screen capture includes and where screenshots are saved.
            </p>
            <div className="mt-4 divide-y">
              <Row
                title="Hide UI from capture"
                description={
                  state.isDev
                    ? 'Disabled in development mode.'
                    : 'Exclude the toolbar and panels from screen capture, so recordings and screenshots show your ink but not the UI.'
                }
              >
                <Switch
                  checked={!state.isDev && state.protectUi}
                  disabled={state.isDev}
                  onChange={setProtectUi}
                />
              </Row>
              <Row
                title="Screenshot destination"
                description="Where the screenshot hotkey sends the capture: a PNG file, the clipboard, or both."
              >
                <div className="flex gap-1.5">
                  {SHOT_DESTS.map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      onClick={() => setScreenshotDest(value)}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-md border px-3 py-2 text-xs transition-colors duration-150 ease-out',
                        state.screenshotDest === value
                          ? 'border-primary bg-accent text-accent-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      )}
                    >
                      <Icon className="size-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </Row>
              <div className={cn('py-3', state.screenshotDest === 'clipboard' && 'opacity-50')}>
                <div className="text-sm font-medium text-foreground">Screenshot save folder</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {state.screenshotDest === 'clipboard'
                    ? 'Not used while screenshots go to the clipboard only.'
                    : 'Annotated screenshots are saved here.'}
                </p>
                {state.screenshotDir && (
                  <p className="mt-2 break-all font-mono text-xs text-foreground">
                    {state.screenshotDir}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.screenshotDest === 'clipboard'}
                    onClick={() => window.openpen.send('open-screenshot-dir')}
                  >
                    Open folder
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.screenshotDest === 'clipboard'}
                    onClick={() => window.openpen.send('pick-screenshot-dir')}
                  >
                    Change…
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      state.screenshotDest === 'clipboard' ||
                      !state.screenshotDirDefault ||
                      state.screenshotDir === state.screenshotDirDefault
                    }
                    onClick={() => window.openpen.send('reset-screenshot-dir')}
                  >
                    Use default
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}

        {section === 'about' && (
          <section>
            <h2 className="text-base font-semibold">About</h2>
            <div className="mt-4 space-y-1">
              <div className="text-lg font-semibold">OpenPen</div>
              <div className="text-sm text-muted-foreground">
                Version {state.version || 'unknown'}
              </div>
              <p className="max-w-md pt-2 text-sm text-muted-foreground">
                A free and open source on-screen annotation tool for Windows. Draw over
                anything on your screen. MIT licensed.
              </p>
            </div>

            <div className="mt-6 border-t pt-4">
              <h3 className="text-sm font-semibold">Updates</h3>
              {state.canUpdate ? (
                <div className="mt-3 space-y-3">
                  {statusMessage && (
                    <p className="text-sm text-muted-foreground">{statusMessage}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {state.updateStatus === 'ready' && (
                      <Button onClick={() => window.openpen.send('install-update')}>
                        Restart to install
                        {state.updateVersion ? ` v${state.updateVersion}` : ''}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={checking}
                      onClick={() => window.openpen.send('check-for-updates')}
                    >
                      {checking ? 'Checking…' : 'Check for updates'}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    OpenPen also checks for updates on launch and every six hours.
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Updates are available in installed builds only.
                </p>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
