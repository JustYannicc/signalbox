# Signalbox

Signalbox is a fork of [T3 Code](https://github.com/pingdotgg/t3code), the open source "agent harness control surface". It controls the coding agents on your machine from a desktop app, a web app, and a mobile app, and keeps receiving upstream T3 Code updates.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, Signalbox can control them.

Signalbox installs next to T3 Code without sharing state. It keeps its data in `~/.signalbox` (T3 Code uses `~/.t3`), uses its own app ids and `signalbox://` links, and its server starts at port 4783.

## Installation

> [!WARNING]
> Signalbox currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

Releases are published to [GitHub Releases](https://github.com/JustYannicc/signalbox/releases). Until the first one is out, build from source (see below).

### Command line

```bash
curl -fsSL https://raw.githubusercontent.com/JustYannicc/signalbox/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/JustYannicc/signalbox/main/scripts/install.ps1 | iex
```

Then run `signalbox` to start the server and open the local web app. `signalbox service install` keeps it running in the background, `signalbox update` moves to a newer release, and `signalbox --help` has the full reference. The npm package is `signalbox-cli` (`npx signalbox-cli@latest`).

### Desktop app

Download the installer for your platform from [GitHub Releases](https://github.com/JustYannicc/signalbox/releases), or build one locally; artifacts land in `release/`:

```bash
vp i
vp run dist:desktop:dmg    # or dist:desktop:linux, dist:desktop:win
```

## Documentation

Full docs live in [docs/](./docs).

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Signalbox as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Working on Signalbox

### Install `vp`

Signalbox uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Code identifiers, package names (`@t3tools/*`), env vars (`T3CODE_*`), and the `t3.json` project format stay upstream's so upstream patches apply cleanly. User-facing names are renamed in source by a codemod; [docs/operations/upstream-sync.md](./docs/operations/upstream-sync.md) explains how to merge upstream and re-run it.

Bugs in upstream behavior belong in [T3 Code's issues](https://github.com/pingdotgg/t3code/issues) once you've confirmed they reproduce there.
