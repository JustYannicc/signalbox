# Public API

Signalbox can be driven from outside the app (#436). The API, the `signalbox` CLI and the MCP tools all come from one list of operations, derived from the RPC contracts the clients already use. Agents inside Signalbox reach the same list (#335).

## One list, derived

`packages/api/src/catalog.ts` walks `WsRpcGroup` and gives every RPC an entry from the reach map (`upstreamReach.ts`, `signalboxReach.ts`). Each entry is one of three kinds:

- **Derived:** an operation. The entry says read or write, and optionally a public name, `humanOnly` or `destructive`.
- **Exempt,** with a reason: client-local, a client reporting about itself, or internal machinery.
- **Per-command:** only `dispatchCommand`. Each client-dispatchable command becomes its own operation (`commandReach.ts`), because a caller thinks in "archive this thread", not in a command union.

The maps are typed as complete records over the group, so a new RPC is a type error until someone picks its entry. Nothing else is written per RPC. Payload, result and error schemas come from the contract, and their JSON Schemas come from `Schema.toJsonSchemaDocument`.

Operation names follow `<resource>.<verb>`, and the CLI's command path is the name split on its dots. They default to the RPC tag (`defaultRpcName`) and are overridden where the tag reads badly. A rename is a break for callers, so names are chosen once.

## The surface is checked in

`packages/api/api/v1.json` records every operation's name, flags and schema fingerprints, plus every exemption. `catalog.test.ts` fails when it drifts. Any diff there is a change for every caller of the API, CLI and MCP. Review it as one, then update it with `vp test run -u`. The version in the path only moves when an operation breaks its callers.

## Streams

Subscriptions answer a one-shot call with their first item, the current state. Progress streams answer with their last item, the result. Over HTTP, a caller that wants the live stream can ask for it.

## Serving it

The cloud serves the list under `/api/v1/` (`apps/cloud/src/api/`):

- `GET operations` and `GET operations/<name>` describe the list.
- `POST <name>` calls an operation.

The Worker only checks that a credential is the cloud's own, then hands the call to the person's user object. The object resolves the credential's scopes and runs the operation through `CloudRpcGroup`'s handlers and scope authorization, in process (`RpcTest.makeClient`), exactly as a client's socket does. That's why the API can never do more than the app. Each call logs one `api.call` line: who, which operation, and which folder and thread. Inputs and results never go in it.

## Credentials

There's one credential kind, the personal key (`sbk_…`, `localKeys/LocalKeys.ts`). It was first made for running local harnesses on a pool (#413). A key carries API scopes, model access, or both, so a script's key is never also a pool key, and revoking it in Settings stops its next call.

- **The CLI** signs in with WorkOS's device flow. The cloud runs that flow itself (`POST login`, `POST login/token`) and answers with a personal key holding an app's scopes. The CLI never holds a WorkOS token.
- **Scripts** get keys from `keys.create`, which never grants more than its caller holds. Agents can't create keys.
- **MCP clients** are agents. They sign in through WorkOS AuthKit as the authorization server, and their calls never reach human-only or destructive operations.

## People and agents

Calls act as the person whose credential they carry, and follow the folder rules (#225). `humanOnly` operations (approvals, secret requests, decision gates, finishing a provider sign-in) are never offered to agents. Neither are `destructive` ones, until decision gates exist (#335 decisions 4 and 5).

## The cloud's coverage

The cloud serves a slice of the group (`apps/cloud/src/user/rpc.ts`) and of the commands (`CLOUD_COMMANDS` in `thread/threadDecider.ts`). `apps/cloud/src/api/cloudCoverage.ts` lists every operation it doesn't serve. A gap names the issue that closes it, and an exemption says why the cloud never will. The coverage test fails on an operation that's neither served nor listed, and on a listing that's gone stale. A new RPC therefore reaches the cloud as a decision, not as a silent "unknown request".
