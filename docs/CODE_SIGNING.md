# Code signing policy

OpenPen Windows installers are built from the public source in this repository
and signed through [SignPath Foundation](https://signpath.org/).

## How releases are built

1. A maintainer pushes a version tag (`vX.Y.Z`) that matches `package.json`.
2. The [Release workflow](https://github.com/jvnkr/openpen/actions/workflows/release.yml)
   runs on GitHub Actions (Windows).
3. The workflow installs dependencies, runs the build, and packages installers
   with electron-builder (NSIS installer, portable, and zip for x64 and arm64).
4. Unsigned artifacts are submitted to SignPath Foundation for Authenticode
   signing.
5. Signed installers are published to [GitHub Releases](https://github.com/jvnkr/OpenPen/releases).

We do not distribute Windows binaries built outside this pipeline.

## Verification

- Source code: [github.com/jvnkr/openpen](https://github.com/jvnkr/openpen)
- Release tags and workflow runs are public on GitHub.
- Tagged releases include GitHub artifact attestations for the published
  installers.

## SignPath Foundation

Free code signing for this project is provided by
[SignPath Foundation](https://signpath.org/). Signed Windows binaries list
SignPath Foundation as the publisher.

## Reporting issues

If a downloaded installer does not match a release built from this repository,
please [open an issue](https://github.com/jvnkr/openpen/issues) or report it
privately through GitHub Security Advisories.
