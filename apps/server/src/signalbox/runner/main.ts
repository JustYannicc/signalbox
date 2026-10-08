/**
 * The Runner's command line.
 *
 * A local Runner host for Signalbox Cloud development:
 *
 *   node apps/server/src/signalbox/runner/main.ts --cloud http://localhost:8787 --port 8790
 *
 * `--drives /drives` also mounts every drive the thread's user can read
 * there, which needs FUSE: run it in the Runner image under Docker.
 *
 * Point the cloud at it with `LOCAL_RUNNER_URL=http://localhost:8790` in
 * `apps/cloud/.dev.vars`. The same host runs in a light machine's container,
 * where the cloud starts it with `--listen 0.0.0.0` and `--machine-id`. Turns run this machine's `claude` and `codex`, which
 * reach their models through the cloud's ModelGateway rather than any login on
 * this machine. See docs/operations/cloud.md.
 *
 * The Runner on a thread's VM (the Runner image's command):
 *
 *   runner machine --config /home/user/signalbox/machine.json
 *
 * It follows the config file its machine backend writes (`RunnerMachine.ts`)
 * and exits when that file names another image, so the machine restarts it on
 * that image. `SIGNALBOX_RUNNER_IMAGE` names the image it runs,
 * `SIGNALBOX_RUNNER_IMAGE_DIGEST` its digest and `SIGNALBOX_RUNNER_REVISION`
 * the commit it was built from.
 */
// @effect-diagnostics nodeBuiltinImport:off - a CLI entrypoint reads argv, env, the hostname and the cwd.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { RunnerBuild } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";

import packageJson from "../../../package.json" with { type: "json" };
import { spawnAndCollect } from "../../provider/providerSnapshot.ts";
import { runRunnerHost } from "./RunnerHost.ts";
import { runRunnerMachine } from "./RunnerMachine.ts";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    cloud: { type: "string", default: "http://localhost:8787" },
    port: { type: "string", default: "8790" },
    home: { type: "string" },
    config: { type: "string", default: "/home/user/signalbox/machine.json" },
    listen: { type: "string", default: "127.0.0.1" },
    "machine-id": { type: "string" },
    // Host mode only: mount /drives here for every thread (one at a time); the Runner image in Docker.
    drives: { type: "string" },
  },
});

const imageVersion = process.env.SIGNALBOX_RUNNER_IMAGE?.trim() || packageJson.version;
const envValue = (name: string) => process.env[name]?.trim() || null;

/** A harness CLI's `--version` output; empty when it is missing or fails. */
const cliVersion = (command: string) =>
  spawnAndCollect(command, ChildProcess.make(command, ["--version"], { stdin: "ignore" })).pipe(
    Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => ""),
  );

const runnerBuild = Effect.gen(function* () {
  const cliVersions: Record<string, string> = {};
  for (const command of ["claude", "codex"]) {
    const version = yield* cliVersion(command);
    if (version !== "") cliVersions[command] = version;
  }
  return {
    imageDigest: envValue("SIGNALBOX_RUNNER_IMAGE_DIGEST"),
    revision: envValue("SIGNALBOX_RUNNER_REVISION"),
    cliVersions,
  } satisfies RunnerBuild;
});

const program = Effect.gen(function* () {
  if (positionals[0] === "machine") {
    return yield* runRunnerMachine({
      configPath: NodePath.resolve(values.config),
      home: NodePath.resolve(values.home ?? NodePath.dirname(values.config)),
      machineId: `vm:${NodeOS.hostname()}`,
      imageVersion,
      build: yield* runnerBuild,
      // The Runner image makes this folder; elsewhere nothing is mounted.
      drivesMountPoint: "/drives",
    });
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`--port must be a port number, got ${values.port}.`);
  return yield* runRunnerHost({
    cloudUrl: values.cloud,
    port,
    listen: values.listen,
    home: NodePath.resolve(values.home ?? NodePath.join(".t3", "runner")),
    machineId: values["machine-id"] ?? `local:${NodeOS.hostname()}`,
    imageVersion,
    build: yield* runnerBuild,
    ...(values.drives === undefined ? {} : { drivesMountPoint: values.drives }),
  });
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
