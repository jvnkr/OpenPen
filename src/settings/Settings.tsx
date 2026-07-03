import React, { useEffect, useState } from 'react'
import { Monitor, Moon, Palette, Info, Video, Sun, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { applyDarkClass } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import type { SettingsState, ThemePref } from '@/ipc'
import '@/styles/globals.css'

type Section = 'appearance' | 'recording' | 'about'

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

const NAV: Array<{ value: Section, label: string, Icon: LucideIcon }> = [
  { value: 'appearance', label: 'Appearance', Icon: Palette },
  { value: 'recording', label: 'Recording', Icon: Video },
  { value: 'about', label: 'About', Icon: Info }
]

const EMPTY_STATE: SettingsState = {
  protectUi: false,
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

  useEffect(() => {
    applyDarkClass(resolveTheme(loadSaved().theme ?? 'system') === 'dark')
    const offs = [
      window.openpen.on('theme', t => applyDarkClass(t === 'dark')),
      window.openpen.on('settings-state', setState)
    ]
    window.openpen.send('settings-ready')
    return () => offs.forEach(off => off())
  }, [])

  const pickTheme = (t: ThemePref): void => {
    setThemeState(t)
    window.openpen.send('set-theme', t)
  }

  const setProtectUi = (v: boolean): void => window.openpen.send('set-protect-ui', v)
  const statusMessage = updateMessage(state)
  const checking = state.updateStatus === 'checking' || state.updateStatus === 'downloading'

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

        {section === 'recording' && (
          <section>
            <h2 className="text-base font-semibold">Recording</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Control what screen recorders and screenshots capture.
            </p>
            <div className="mt-4 divide-y">
              <Row
                title="Hide UI from recordings"
                description={
                  state.isDev
                    ? 'Disabled in development mode.'
                    : 'Exclude the toolbar and panels from screen capture, so recordings show your ink but not the UI.'
                }
              >
                <Switch
                  checked={!state.isDev && state.protectUi}
                  disabled={state.isDev}
                  onChange={setProtectUi}
                />
              </Row>
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
