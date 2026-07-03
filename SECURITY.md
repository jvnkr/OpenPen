# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Use GitHub's ["Report a vulnerability"](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
flow on this repository (Security → Advisories), or contact the maintainers.

We'll acknowledge your report as soon as we can and keep you updated on a fix.

## Scope & hardening notes

OpenPen is a local desktop app; it does not run a server or accept network
input. Its Electron renderers are hardened accordingly:

- Renderers run with `contextIsolation` and no `nodeIntegration`; the only
  bridge is the small, allow-listed `window.openpen` API in
  `electron/preload.ts`.
- Production builds ship a restrictive Content-Security-Policy (see
  `vite.config.ts`).
- Overlay windows are non-activating and transparent; they never load remote
  content.

If you find a way to escape these boundaries, that's exactly the kind of report
we want.
