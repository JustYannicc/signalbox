// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This preload guards the official profiler's actual native child spawn.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as Schema from "effect/Schema";
import { requireWorkerdLaunchAdmissionSync } from "../harnessReleases/workerdLaunchAdmission.ts";

const decodeSpawn = Schema.decodeUnknownSync(
  Schema.Struct({
    file: Schema.String,
    args: Schema.Array(Schema.String),
    envPairs: Schema.Array(Schema.String),
  }),
);
const executable = process.env.SIGNALBOX_STARTUP_WORKERD;
const ledger = process.env.SIGNALBOX_STARTUP_LEDGER;
if (!executable || !ledger) throw new Error("WORKER_STARTUP_HOOK_INPUT_MISSING");
const nativeExecutable = NodeFS.realpathSync(executable);
const original: unknown = Reflect.get(NodeChildProcess.ChildProcess.prototype, "spawn");
if (typeof original !== "function") throw new Error("WORKER_STARTUP_SPAWN_UNAVAILABLE");
let starts = 0;
const record = (event: object) =>
  NodeFS.appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

Reflect.set(
  NodeChildProcess.ChildProcess.prototype,
  "spawn",
  function (this: NodeChildProcess.ChildProcess, raw: unknown) {
    const options = decodeSpawn(raw);
    if (NodeFS.realpathSync(options.file) !== nativeExecutable || options.args[1] !== "serve")
      throw new Error("WORKER_STARTUP_UNEXPECTED_CHILD");
    if (starts !== 0) throw new Error("WORKER_STARTUP_SECOND_START_REFUSED");
    const env = new Map(
      options.envPairs.map((pair) => {
        const separator = pair.indexOf("=");
        return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
      }),
    );
    for (const key of [
      "SIGNALBOX_WORKERD_ACTIVE",
      "SIGNALBOX_WORKERD_OWNER",
      "SIGNALBOX_WORKERD_BATCH",
    ])
      if (!process.env[key] || env.get(key) !== process.env[key])
        throw new Error("WORKER_STARTUP_CHILD_GUARD_ENV_DIFFERS");
    // No await or other executable work separates the public guard from the actual spawn.
    requireWorkerdLaunchAdmissionSync();
    starts += 1;
    const result: unknown = Reflect.apply(original, this, [raw]);
    record({ event: "workerd-spawn", pid: this.pid, guardPassed: true });
    this.once("close", (code, signal) =>
      record({
        event: "workerd-close",
        pid: this.pid,
        code,
        signal,
        streamsClosed: this.stdio.map(
          (stream) => stream == null || Reflect.get(stream, "closed") === true,
        ),
      }),
    );
    return result;
  },
);
const mutableChildProcess: typeof NodeChildProcess = NodeModule.createRequire(import.meta.url)(
  "node:child_process",
);
for (const name of ["spawnSync", "execSync", "execFileSync"])
  Reflect.set(mutableChildProcess, name, () => {
    throw new Error("WORKER_STARTUP_UNEXPECTED_SYNC_CHILD");
  });
NodeModule.syncBuiltinESMExports();
