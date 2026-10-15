---
name: signalbox
description: Use when driving Signalbox from outside the app, through its MCP tools (`signalbox_search`, `signalbox_call`) or its `signalbox` CLI: folders, threads, automations, settings, pools, keys. Also for writing, validating, saving and running an automation in a Signalbox folder from your own session.
---

# Signalbox from outside the app

Signalbox runs your person's work in the cloud. Everything they can do in the app is an **operation** (`folders.create`, `threads.send`, `automations.run`…), and you reach the same operations through MCP or the CLI. You act as them, with an agent's limits.

## Connect

1. **MCP tools present** (`signalbox_search`, `signalbox_call`): use them. Done.
2. **Otherwise the CLI.** Run `signalbox folders list`. If it says you're not signed in, run `signalbox login`. It prints a URL and a code; give both to the person, who approves in their browser, then the command finishes by itself. Done when `signalbox folders list` prints their folders.
3. **To add MCP** to your harness: `claude mcp add signalbox -- signalbox mcp` (stdio, uses the saved key), or the cloud's own `https://app.signalbox.run/mcp`, which signs in through the browser.

## Find and call an operation

- **MCP:** `signalbox_search` with what you want to do ("move a thread to a folder"). It returns operations with their input JSON Schema; pass that input to `signalbox_call`.
- **CLI:** the operation's dots are the command path. `automations.runs.get` is `signalbox automations runs get`. Each input field is a flag (`--parent-id`), and `--input` takes the whole input as JSON, `@file` or `-`. `signalbox <resource> --help` lists what's there. Streams print their current state; `--follow` keeps printing.
- Commands such as `threads.send` and `threads.archive` fill in their own `commandId`.
- Folder ids are the `projectId`/`folderId` in inputs. Read them from `folders.list` and never guess one.

## Write an automation

An automation is one TypeScript file in a folder. The **signalbox-automations** skill is the reference for writing one; read it first. The loop:

1. `automations.list`, then `automations.get` for the one you're changing.
2. Write the file, with `meta.intent` set to the person's request in their words.
3. `automations.validate` with `{ source }` until `ok` is true. Each diagnostic names its line and the fix.
4. `automations.save` with `{ source, projectId }` (plus `automationId` to change one, and `draft: true` when they want to review first).
5. `automations.run`, then `automations.runs.get` until the run finishes. It's done when every step's result is what they asked for: a run that succeeds can still be wrong.

## Limits

- **People only:** answering approvals and questions (`threads.respond`, `automations.answer`), secrets, making keys, and finishing a provider sign-in. Deleting needs a decision gate that doesn't exist yet. Search never shows you these; tell the person what to do in the app instead.
- **Not in the cloud yet:** an operation can answer `not_in_cloud` with the issue that adds it, e.g. `#434` for automations. Report that issue to the person and leave the operation alone.
- **Errors** are the operation's own: `invalid_input` names the field, and a missing scope answers 403.
