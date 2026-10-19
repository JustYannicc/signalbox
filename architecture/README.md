# Signalbox architecture (LikeC4)

The canonical model of Signalbox's target design. It is a decision tool for deep modules:
every module is a black box everywhere above it, and its internals live only in its own view.

## View it

```sh
pnpm dlx likec4@1.60.0 start architecture        # live, from the repo root
pnpm dlx likec4@1.60.0 validate --json --no-layout architecture
pnpm dlx likec4@1.60.0 build architecture -o dist # static site
```

Start at `index` and click: groups open external services, modules open their drill-down.

## Folder map

```
likec4.config.json   project (name: signalbox)
spec.c4              element, deployment and relationship kinds; tags; style groups
model/               people, clients, front-door, external, actors, hierarchy, domain
model/modules/       one file per module with its parts, seams, adapters and technologies
deployment.c4        build layer + production topology (Cloudflare, boxd, SaaS, devices)
views/               landscape, containers (runtime), modules (drill-downs), hierarchy,
                     domain, deployment, smells, v1, packages (publishable vs stays)
views/states/        state machines: thread, turn, ask, pool account, VM, Base, trash, connection
views/workflows/     dynamic views per workflow (Workflows/... in the sidebar)
  workflows/v1.c4    v1 end to end (Workflows/v1/...): 0 first day (index) · 1 sign in · 2 pool on Company
                     · 3 Google and Confluence · 4 set up this computer · 5 local model request · 6 local tool call
views/journeys/      scenario walk-throughs (Scenarios/... in the sidebar)
CONTEXT.md           glossary and the words that are never kinds
```

## Conventions

- Box text is the name. A module's description is its interface: 3-6 verbs. Tech goes in `technology`.
- I/O between modules is relationships. A cross-module edge never targets another module's internals.
- Tags: `#deep`, `#shallow`, `#passthrough` on modules; `#hypothetical-seam` on a seam with one adapter;
  `#v1` on what v1 ships; `#planned` on adapters not built yet; `#publishable` on deep modules and parts that
  become their own public npm packages (see `Overview / Decisions / Packages`); `#decided` / `#assumption` on
  settled answers vs working plans.
- Seams carry `metadata { adapters 'N' }`. Modules carry `interface` and `deletion` (the deletion-test verdict).
- Relationship kinds: `sync`, `async` (outbox), `model`, `tool`, `reach`, `lend`, `mount`, `transition`, `owns`.
- Levels are only `toplevel` and `folder`. An organization is only an owner (see CONTEXT.md).
- At least three people (A, B members; C admin). Assistant and pipeline lanes are per person, at the top layer.
- Generic names only. Nothing private: no real people, companies, repos, hosts or local paths.
- Every view uses `autoLayout TopBottom`. View titles use folders: `Modules / Models`.
- Harnesses (Claude Code, Codex) run in the isolate tier. boxd VMs forked from a warm Base only run
  commands. Containers host CLIProxyAPI only.
- Executor (Gateway's ToolGateway + Connections) is the one gateway for every connector; built-in tools
  (Bash, Read, Edit …) go Harness → Computer, and their network traffic leaves through Gateway's egress filter.

Source of truth for the design lives outside this folder; this model follows it, it does not decide it.
