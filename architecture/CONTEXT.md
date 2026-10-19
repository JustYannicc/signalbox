# Context: domain terms in this model

One line each. Element kinds in `spec.c4` use these words and no others.

## Our names, not product names

Everything in this model is named in our own words. A product or vendor name (Executor, CLIProxyAPI, boxd, Artifacts, Kernel, 1Password, WorkOS, Cloudflare products) appears only in an adapter's `technology` line, never as an element name, a view title, step text or an issue title. What we use underneath can change; the names don't.

## Levels and people

| Term           | Meaning                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| top level      | A person's root level: one per person, owned by that person. Kind `toplevel`.                                       |
| folder         | Any level below a top level. Folders nest freely. Kind `folder`.                                                    |
| thread         | The durable unit of work (chat or task is display only), filed in one folder. Kind `thread`.                        |
| owner          | Who owns a level or custody object: a person or an organization. Metadata `owner`, or an `owns` relationship.       |
| organization   | A group of people that can own folders. Only ever an owner, never a level.                                          |
| role           | Owner, Admin, Member or Viewer on a folder, inherited down. A relationship from a person.                           |
| mount          | Puts an organization-owned folder into a member's tree, under their Work folder. The only edge across owners.       |
| placement      | A thing (pool, connection, secret reference, skill, AGENTS.md, automation, drive) put on a level.                   |
| reach          | A placement reaches its level and everything below; the nearest wins. Never depends on who sends.                   |
| loan           | An explicit, revocable placement into a level the lender does not own. The only way to use what is not above you.   |
| assistant      | The agent thread of a person's top level. Coordinates, never executes. Sits at the top layer.                       |
| pipeline lanes | A person's asks from every level they reach, in lanes Blocker, Ready, Considering. Top layer, beside the assistant. |
| ask            | The one needs-you record, raised by one thread, answered into that thread.                                          |

## Gateways

A gateway is the one entry point for one kind of crossing. Every caller goes through it, and what serves the call behind it is hidden. Moving work between placements never moves a gateway.

| Term            | Meaning                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| client gateway  | The one typed entry point for every client (web, desktop, mobile, CLI, API) into the modules. Avoid: funnel.                                     |
| command gateway | The one way any command runs, for the model, the person's terminal, hooks, automations and agents alike. One routing table, one live FS.         |
| files gateway   | The one way files are read and written, whoever reads them.                                                                                      |
| model gateway   | The one entry point for every model request. A pool answers behind it. Avoid: CLIProxyAPI, CPA.                                                  |
| tools gateway   | The one entry point for every tool call and every call to an outside service. Locally it appears as the `signalbox` MCP server. Avoid: Executor. |
| port gateway    | The one URL for a port a thread serves, for the person, the agent and the renderer.                                                              |

## Things behind the gateways

| Term              | Meaning                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| pool              | An owned set of model accounts (subscriptions and API keys) that answers model requests; placed on a level. |
| pool account      | One subscription or API key in a pool.                                                                      |
| connection        | One connected account at one outside service, placed on a level; its tools reach what is below.             |
| tool exposure     | Per tool: `search` (found through the tools gateway's search) or `direct` (shown under its own name).       |
| vault             | Where secret values live. Agents only ever see placeholders. Avoid: 1Password.                              |
| computer          | The one machine a thread sees (files, shell, ports). Where it runs is hidden. Avoid: cloudflare/computer.   |
| machine           | A real virtual machine a command can escalate to. It exists only while needed. Avoid: boxd VM, box.         |
| Base              | A warm machine snapshot of a repo drive's last green `main`; machines fork it to run commands.              |
| drive             | A file history with one writer for `main`; a placement kind.                                                |
| fork              | A thread's own working copy of a drive. Nothing lands until it's accepted. Avoid: Artifacts fork.           |
| browser           | The agent's browser: checks work, uses the web as the person, hands hard steps to them. Avoid: Kernel.      |
| merge run         | The run thread that merges an accepted fork when it needs a machine. Avoid: merge executor.                 |
| identity provider | The service that signs people in and holds organizations. Avoid: WorkOS, AuthKit.                           |
| record storage    | The cheap full record of every drive; any drive can be rebuilt from it alone. Avoid: R2.                    |

## Modelling terms

| Term           | Meaning                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| module         | A deep module: a black box with a small interface (verbs) and I/O relationships. |
| seam / adapter | Where a module can swap implementations; real only with two adapters.            |

## Not kinds

These words must never be an element kind, deployment node kind or level kind:

- org
- company
- project
- section
- environment

A "company" or "project" is a folder with a generic name. An organization appears only as an owner.
