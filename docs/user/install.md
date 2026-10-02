# Install Signalbox

Signalbox runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Signalbox and configure providers afterwards.

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/JustYannicc/signalbox/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/JustYannicc/signalbox/main/scripts/install.ps1 | iex
```

This puts `signalbox` in `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `T3CODE_CHANNEL=nightly` to install the nightly train, or
`T3CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Start the server and open the web app            | `signalbox`                                                      |
| Start the server without a browser               | `signalbox serve`                                                |
| Keep it running in the background (macOS, Linux) | `signalbox service install` ([details](./background-service.md)) |
| Move to the newest release                       | `signalbox update`                                               |
| Remove it again                                  | `signalbox uninstall`                                            |

Run `signalbox --help` for the full reference.

To try Signalbox once without installing it, run `npx signalbox-cli@latest` instead (needs
Node.js for `npx`).

### Intel Macs

There is no `signalbox` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with Node.js 24 and `vp`
([Install vp](https://github.com/JustYannicc/signalbox#install-vp)):

```bash
git clone https://github.com/JustYannicc/signalbox
cd signalbox && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`signalbox update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download the installer for your platform from
[GitHub Releases](https://github.com/JustYannicc/signalbox/releases): a `.dmg` for
macOS, an `.exe` for Windows, and an AppImage or `.deb` for Linux
(`sudo apt install ./Signalbox-*.deb`). Signalbox installs next to
[T3 Code](https://github.com/pingdotgg/t3code) and keeps its own data in `~/.signalbox`.

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### Importing existing data

If [T3 Code](https://github.com/pingdotgg/t3code) is installed, the first launch offers
to import its projects, threads, and settings. The import copies them and leaves the
originals in the `.t3` folder of your home directory unchanged, so both apps keep working
side by side. Imported threads keep using their existing worktrees. Saved remote
connections and Connect sign-in are not imported, so reconnect those in Signalbox.

The command line asks the same question the first time you start `signalbox` in a
terminal. To import from a script, run `signalbox import-t3` before the first start. The
import only fills a fresh Signalbox home and refuses once Signalbox has data of its own.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. Signalbox installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
signalbox app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `signalbox app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

The Signalbox mobile app is not in the App Store or Google Play yet. Build it from
source with the [mobile README](../../apps/mobile/README.md). The phone connects to a
server on another machine. Follow [remote access](./remote-access.md) to link it
through Signalbox Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Signalbox's provider settings.                                                                                       |

Provider CLIs must be on the server's `PATH`. If Signalbox cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Signalbox warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Signalbox can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Signalbox does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Signalbox](./updating.md): update the app and connected servers.
