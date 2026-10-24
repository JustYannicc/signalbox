// @effect-diagnostics nodeBuiltinImport:off - this entrypoint parses its argv and starts the command Runner process.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runRunnerCommandBootstrap } from "./RunnerCommandBootstrap.ts";
import * as RunnerMachineFiles from "./RunnerMachineFiles.ts";
import * as RunnerNativeFileSystem from "./RunnerNativeFileSystem.ts";

const { values } = NodeUtil.parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    config: { type: "string", default: "/run/signalbox-command/runner.json" },
  },
});

runRunnerCommandBootstrap(NodePath.resolve(values.config)).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      RunnerMachineFiles.layer.pipe(Layer.provide(RunnerNativeFileSystem.layer)),
    ),
  ),
  NodeRuntime.runMain,
);
