# Signalbox from outside the app

Everything you can do in Signalbox can also be done from a terminal, a script, or an agent you run yourself, such as Claude Code or Codex on your laptop. It all acts as you, in your folders.

## The CLI

```sh
signalbox login
```

`login` prints a link and a code. Open the link, check that it shows the same code, and approve. The CLI keeps a personal key in `~/.config/signalbox`.

Every command follows the same pattern, `signalbox <thing> <action>`:

```sh
signalbox folders list
signalbox folders create --name "Signalbox" --parent-id null
signalbox threads create --input @thread.json
signalbox automations validate --source "$(cat triage.ts)"
```

Automation files compile on your computer, so check and save them through the CLI or `signalbox mcp`. The cloud's own MCP address can run and read automations but can't save them.

`signalbox --help`, or `--help` after any command, shows what's there and what each one takes.

`signalbox pools use` sets up Claude Code and Codex on this computer to run on your pool. It works like **Set up a computer** in Settings › Pools.

## Scripts

A script uses a key of its own, limited to what it needs:

```sh
signalbox keys create --label "nightly report" --scopes '["orchestration:read"]' --model false
```

Give the printed key to the script as `SIGNALBOX_KEY`. A key can never do more than the one that made it.

Every key, including the CLI's, is listed in Settings › Pools, and revoking one there stops it at its next request.

## Agents

Agents get Signalbox through MCP, as two tools: one finds what to do, the other does it.

- **Through the CLI:** `claude mcp add signalbox -- signalbox mcp` uses the CLI's key.
- **Straight to the cloud:** add `https://app.signalbox.run/mcp`. The agent signs in through your browser.

An agent acts for you but never instead of you. Answering an approval or a question, entering a secret, making a key, and finishing a provider sign-in stay yours, and so does deleting anything.
