// @effect-diagnostics nodeBuiltinImport:off - this entrypoint parses its argv and starts the command Runner process.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { runRunnerCommandBootstrap } from "./RunnerCommandBootstrap.ts";

const { values } = NodeUtil.parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    config: { type: "string", default: "/run/signalbox-command/runner.json" },
  },
});

runRunnerCommandBootstrap(NodePath.resolve(values.config)).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
