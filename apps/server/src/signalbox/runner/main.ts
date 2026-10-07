/**
 * The Runner's command line.
 *
 * A local Runner host for Signalbox Cloud development:
 *
 *   node apps/server/src/signalbox/runner/main.ts --cloud http://localhost:8787 --port 8790
 *
 * Point the cloud at it with `LOCAL_RUNNER_URL=http://localhost:8790` in
 * `apps/cloud/.dev.vars`. Turns run this machine's `claude` and `codex`, which
 * reach their models through the cloud's ModelGateway rather than any login on
 * this machine. See docs/operations/cloud.md.
 *
 * The Runner on a thread's VM (the Runner image's command):
 *
 *   runner machine --config /home/user/signalbox/machine.json
 *
 * It follows the config file its machine backend writes (`RunnerMachine.ts`)
 * and exits when that file names another image, so the machine restarts it on
 * that image. `SIGNALBOX_RUNNER_IMAGE` names the image it runs.
 */
// @effect-diagnostics nodeBuiltinImport:off - a CLI entrypoint reads argv, env, the hostname and the cwd.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import packageJson from "../../../package.json" with { type: "json" };
import { runRunnerHost } from "./RunnerHost.ts";
import { runRunnerMachine } from "./RunnerMachine.ts";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    cloud: { type: "string", default: "http://localhost:8787" },
    port: { type: "string", default: "8790" },
    home: { type: "string" },
    config: { type: "string", default: "/home/user/signalbox/machine.json" },
  },
});

const imageVersion = process.env.SIGNALBOX_RUNNER_IMAGE?.trim() || packageJson.version;

const program =
  positionals[0] === "machine"
    ? runRunnerMachine({
        configPath: NodePath.resolve(values.config),
        home: NodePath.resolve(values.home ?? NodePath.dirname(values.config)),
        machineId: `vm:${NodeOS.hostname()}`,
        imageVersion,
      })
    : Effect.suspend(() => {
        const port = Number(values.port);
        if (!Number.isInteger(port) || port <= 0)
          throw new Error(`--port must be a port number, got ${values.port}.`);
        return runRunnerHost({
          cloudUrl: values.cloud,
          port,
          home: NodePath.resolve(values.home ?? NodePath.join(".t3", "runner")),
          machineId: `local:${NodeOS.hostname()}`,
          imageVersion,
        });
      });

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
