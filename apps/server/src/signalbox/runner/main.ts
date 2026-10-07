/**
 * Runs a local Runner host for Signalbox Cloud development:
 *
 *   node apps/server/src/signalbox/runner/main.ts --cloud http://localhost:8787 --port 8790
 *
 * Point the cloud at it with `LOCAL_RUNNER_URL=http://localhost:8790` in
 * `apps/cloud/.dev.vars`. Turns run with this machine's own `claude` and
 * `codex`, signed in as they already are. See docs/operations/cloud.md.
 */
// @effect-diagnostics nodeBuiltinImport:off - a CLI entrypoint reads argv, the hostname and the cwd.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import packageJson from "../../../package.json" with { type: "json" };
import { runRunnerHost } from "./RunnerHost.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    cloud: { type: "string", default: "http://localhost:8787" },
    port: { type: "string", default: "8790" },
    home: { type: "string", default: NodePath.resolve(".t3", "runner") },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0)
  throw new Error(`--port must be a port number, got ${values.port}.`);

runRunnerHost({
  cloudUrl: values.cloud,
  port,
  home: NodePath.resolve(values.home),
  machineId: `local:${NodeOS.hostname()}`,
  imageVersion: packageJson.version,
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
