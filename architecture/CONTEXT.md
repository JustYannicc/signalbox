# Context: domain terms in this model

One line each. Element kinds in `spec.c4` use these words and no others.

## Our names, not product names

Everything in this model is named in our own words. A product or vendor name (Executor, CLIProxyAPI, boxd, Artifacts, Kernel, 1Password, WorkOS, Cloudflare products) appears only in an adapter's `technology` line, never as an element name, a view title, step text or an issue title. What we use underneath can change; the names don't.

## Layers

Every part of Signalbox belongs to one layer. Kind `layer`.

| Term                    | Meaning                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Identity                | Who is acting (a person or an agent), who they act for, what they may reach, who they share with. |
| Inference               | The model gateway and the pools behind it.                                                        |
| Connectors              | The outside services Signalbox reaches, and the accounts that sign in to them.                    |
| Apps                    | What people and agents use, built from connectors.                                                |
| Harness                 | The model side: context & orchestration plus the runtime.                                         |
| Context & orchestration | What a turn is given; the official Claude Code and Codex, unmodified.                             |
| Runtime                 | The loop, state, transport, triggers and observability around a harness.                          |
| Environment             | The computer an agent works on.                                                                   |
| Clients                 | Web, desktop, mobile and CLI: gateways that hold no work.                                         |

## Primitives

Everything else, the hierarchy included, is derived from these.

| Term        | Meaning                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| identity    | A person or an agent. An agent acts for anything with an accountable person; its chain of accountability ends at a person. |
| connector   | One outside service and how to sign in to it.                                                                              |
| account     | One sign-in to a connector, owned by a person or the organization.                                                         |
| link        | An account linked to an app.                                                                                               |
| app         | Tools, screens, storage and background work, built from connectors; per person, shared explicitly. Kind `app`.             |
| record      | One item of an app's data, owned by that app and addressed by app, kind and id. Kind `record`.                             |
| grant       | What an identity may reach: an app, an account, a folder or a record.                                                      |
| agent grant | A grant that narrows one agent's access.                                                                                   |

## Goals app

| Term                   | Meaning                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| base                   | The status quo as an explicit record; it changes only when a branch merges.                                         |
| branch (alias mission) | A pointer to work happening elsewhere, opened at the idea; it serves a goal and merges into the base or is dropped. |
| goal                   | Where a person is heading; goals nest under one overarching goal.                                                   |
| report                 | A branch's latest state (working, needs you, blocked, done), a one-line summary, the time and a link.               |
| pipeline lanes         | Where a person's "needs you" reports land: Blocker, Ready, Considering.                                             |
| ask                    | A "needs you" report, raised by one thread and answered into that thread.                                           |

## Hierarchy app

One app that arranges records and grants into folders. Its rules (reach goes down the tree, the nearest placement wins, resolution never depends on who sends) belong to this app, not to the primitives.

| Term         | Meaning                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| top level    | A person's root level: one per person, owned by that person. Kind `toplevel`.                                     |
| folder       | Any level below a top level. Folders nest freely. Kind `folder`.                                                  |
| thread       | The durable unit of work (chat or task is display only), filed in one folder. Kind `thread`.                      |
| owner        | Who owns a level or custody object: a person or an organization. Metadata `owner`, or an `owns` relationship.     |
| organization | A group of people that can own folders. Only ever an owner, never a level.                                        |
| role         | Owner, Admin, Member or Viewer on a folder, inherited down. A relationship from a person.                         |
| mount        | Puts an organization-owned folder into a member's tree, under their Work folder. The only edge across owners.     |
| placement    | A thing (pool, account, secret reference, skill, AGENTS.md, automation, drive) put on a level.                    |
| reach        | A placement reaches its level and everything below; the nearest wins. Never depends on who sends.                 |
| loan         | An explicit, revocable placement into a level the lender does not own. The only way to use what is not above you. |
| assistant    | The agent thread of a person's top level. Coordinates, never executes. Sits at the top layer.                     |

## Gateways

A gateway is the one entry point for one kind of crossing. Every caller goes through it, and what serves the call behind it is hidden. Moving work between placements never moves a gateway.

| Term            | Meaning                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| client gateway  | The one typed entry point for every client (web, desktop, mobile, CLI, API) into the modules. Avoid: funnel.                                              |
| command gateway | The one way any command runs, for the model, the person's terminal, hooks, automations and agents alike. One routing table, one live FS.                  |
| files gateway   | The one way files are read and written, whoever reads them.                                                                                               |
| model gateway   | The one entry point for every model request (`/v1`). A pool answers behind it. Avoid: CLIProxyAPI, CPA.                                                   |
| tools gateway   | The one entry point for every tool call and every call to an outside service (`/mcp`). Locally it appears as the `signalbox` MCP server. Avoid: Executor. |
| port gateway    | The one URL for a port a thread serves, for the person, the agent and the renderer.                                                                       |

## Things behind the gateways

| Term              | Meaning                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| pool              | An app holding a set of model accounts (subscriptions and API keys) that answers model requests.          |
| pool account      | One subscription or API key in a pool.                                                                    |
| tool exposure     | Per tool: `search` (found through the tools gateway's search) or `direct` (shown under its own name).     |
| vault             | Where secret values live. Agents only ever see placeholders. Avoid: 1Password.                            |
| computer          | The one machine a thread sees (files, shell, ports). Where it runs is hidden. Avoid: cloudflare/computer. |
| machine           | A real virtual machine a command can escalate to. It exists only while needed. Avoid: boxd VM, box.       |
| snapshot          | A warm machine image of a repo drive's last green `main`; machines fork it to run commands.               |
| drive             | A file history with one writer for `main`; a placement kind.                                              |
| fork              | A thread's own working copy of a drive. Nothing lands until it's accepted. Avoid: Artifacts fork.         |
| browser           | The agent's browser: checks work, uses the web as the person, hands hard steps to them. Avoid: Kernel.    |
| merge run         | The run thread that merges an accepted fork when it needs a machine. Avoid: merge executor.               |
| identity provider | The service that signs people in and holds organizations. Avoid: WorkOS, AuthKit.                         |
| record storage    | The cheap full record of every drive; any drive can be rebuilt from it alone. Avoid: R2.                  |

## Avoided terms

| Avoid                      | Say instead                                                  |
| -------------------------- | ------------------------------------------------------------ |
| connection                 | account (the sign-in) or link (an account linked to an app). |
| scoped connection          | agent grant.                                                 |
| provider (for a connector) | connector; provider means the agent runtime.                 |
| Base (for a machine image) | snapshot; base means the status quo.                         |
| Apps (for clients)         | clients; apps are what clients and agents use.               |

## Modelling terms

| Term           | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| module         | A deep module: a black box with a small interface (verbs) and I/O relationships.          |
| seam / adapter | Where a module can swap implementations; real only with two adapters.                     |
| out of map     | Kept in the model but left out of the post-v1 plan; today the Runtime. Tag `#out-of-map`. |

## Not kinds

These words must never be an element kind, deployment node kind or level kind:

- org
- company
- project
- section
- environment

A "company" or "project" is a folder with a generic name. An organization appears only as an owner. Environment is a layer name, never a kind.
