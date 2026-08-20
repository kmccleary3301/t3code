# Install T3 Code

T3 Code is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the T3 Code server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## CLI Installer

The release workflow publishes a profile-specific POSIX installer with every release. It
downloads only HTTPS assets, verifies `RELEASE-MANIFEST.json` and `SHA256SUMS`, and never
evaluates downloaded shell or JavaScript:

```sh
curl -fsSL https://github.com/pingdotgg/t3code/releases/latest/download/install.sh |
  sh -s -- --profile upstream
```

For the private Pi + OMP product, use the owner-controlled
[`kmccleary3301/t3code`](https://github.com/kmccleary3301/t3code) release channel:

```sh
curl -fsSL https://github.com/kmccleary3301/t3code/releases/latest/download/install.sh |
  sh -s -- --profile pi-omp --repository kmccleary3301/t3code
```

Do not point the private installer at the official T3 release repository. For a pinned,
auditable install of the published `fork-v0.0.37` release, download the verification files
from that exact release, verify the installer, then run it locally:

```sh
base=https://github.com/kmccleary3301/t3code/releases/download/fork-v0.0.37
curl -fsSLO "$base/install.sh"
curl -fsSLO "$base/RELEASE-MANIFEST.json"
curl -fsSLO "$base/SHA256SUMS"
expected=$(awk '$2 == "install.sh" { print $1 }' SHA256SUMS)
actual=$(shasum -a 256 install.sh | awk '{ print $1 }') # use sha256sum on Linux
test "$actual" = "$expected"
sh install.sh --profile pi-omp --repository kmccleary3301/t3code --version 0.0.37
```

The recorded `fork-v0.0.37` installer SHA-256 is
`452ff311eaff06ce1794be9950a2b0327e8000bb332a65e2641f1a7373069f93`; treat the release's
`SHA256SUMS` as authoritative if this documentation and the release ever disagree.

Use `--channel nightly` for the newest matching nightly, `--version X.Y.Z` for an exact
release, `--prefix "$HOME/.local/share/t3code/pi-omp"` for an isolated prefix, and `--dry-run`
to inspect the resolved action without network or filesystem mutation. `--desktop` downloads
the verified platform desktop artifact into the owned prefix; it does not install or replace
an existing desktop application. `--uninstall` and `--rollback` operate only on an installation
whose ownership marker matches the selected profile.

`--install-runtimes` is opt-in. It installs only Pi/OMP archives explicitly listed in the
release manifest, into the profile-owned prefix, and prints `PI_BINARY_PATH` and
`OMP_BINARY_PATH` for explicit provider configuration. Releases without those optional assets
fail closed when the flag is used. The flag never replaces `pi`, `omp`, or their configuration.

The installer requires Node.js and npm when the release manifest uses its npm package fallback.
It does not install Node.js or the native provider runtimes.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

The verified private Pi + OMP
[`fork-v0.0.37`](https://github.com/kmccleary3301/t3code/releases/tag/fork-v0.0.37)
release includes macOS arm64/x64, Linux arm64/x64, and Windows x64 desktop artifacts. Verify them
against `SHA256SUMS`; the release also carries GitHub build provenance attestations. Platform
code-signing credentials were not configured, so the installers are unsigned and the
[macOS arm64 DMG](https://github.com/kmccleary3301/t3code/releases/download/fork-v0.0.37/T3-Code-Pi-OMP-0.0.37-arm64.dmg)
is not notarized. The fork installs side by side with upstream under a distinct bundle ID and URL
scheme.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

## Providers

T3 Code drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                     | Default binary | Authentication           |
| ---------- | ------------------------------------------------------- | -------------- | ------------------------ |
| Pi         | [Pi coding agent](https://github.com/earendil-works/pi) | `pi`           | Configure in the runtime |
| OMP        | [Oh My Pi](https://github.com/can1357/oh-my-pi)         | `omp`          | Configure in the runtime |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)    | `codex`        | `codex login`            |
| Claude     | [Claude Code](https://claude.com/product/claude-code)   | `claude`       | `claude auth login`      |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                    | `cursor-agent` | `agent login`            |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                      | `grok`         | `grok login`             |
| OpenCode   | [OpenCode](https://opencode.ai)                         | `opencode`     | `opencode auth login`    |

Pi and OMP are separate provider kinds with separate settings and processes. Configuring Pi never
launches OMP, and configuring OMP never launches Pi. Their native runtimes own model, account,
tool, task, and checkpoint behavior; T3 Code negotiates the advertised RPC capabilities and
projects the resulting events.

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Run the login command on the machine running the T3 Code server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
T3 Code. You can install T3 Code, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping T3 Code in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
