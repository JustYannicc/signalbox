import { machineConfigJson } from "@signalbox/runner-protocol/RunnerProtocol";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type { MachineSettings } from "../machineBackends.ts";
import {
  type MachineBackendShape,
  MachineBackendError,
  type MachineRecord,
  type MachineRecords,
  type MachineStatus,
} from "../MachineBackend.ts";
import type { BoatApi, BoatApiError, BoatSandbox } from "./BoatApi.ts";

/**
 * The heavy class: one boat VM per thread (2 vCPU / 4 GB by default), whose
 * disk outlives every stop, so checkouts and dependency caches carry over
 * between wakes. The thread's object stops it after the idle tail; boat's own
 * TTL (`BOAT_TTL_SECONDS`, counted from each start and pushed out while a turn
 * runs) stops it if the object never does.
 *
 * The VM runs the Runner image (`RUNNER_IMAGE`) under systemd, installed by
 * the setup script below when the VM is created. `ensure` writes the Runner's
 * config (`RunnerMachineConfig`) to `CONFIG_PATH`; the Runner follows that file
 * (`apps/server/src/signalbox/runner/RunnerMachine.ts`). Writing a new
 * generation to a running VM replaces its Runner, so a thread object that
 * lost its machine's socket never needs a second VM.
 */

/** On the VM. Mounted into the Runner's container at the same path. */
const MACHINE_HOME = "/home/user/signalbox";
export const CONFIG_PATH = `${MACHINE_HOME}/machine.json`;

/** Create, boot, setup and the first image pull. A resume takes seconds. */
const CONNECT_TIMEOUT_MS = 5 * 60_000;

/**
 * Installs the Runner as an enabled systemd unit, which boat starts again on
 * every resume. The unit waits for the config, then runs the image it names;
 * the Runner exits when the config names another image, and the unit restarts
 * it on that one.
 */
const SETUP_SCRIPT = `#!/bin/bash
set -euo pipefail
sudo install -d -m 0755 -o user -g user ${MACHINE_HOME}
sudo tee /usr/local/bin/signalbox-runner >/dev/null <<'SCRIPT'
#!/bin/bash
set -euo pipefail
config=${CONFIG_PATH}
until [ -s "$config" ]; do sleep 1; done
image=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["image"])' "$config")
docker pull --quiet "$image" || true
digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image" 2>/dev/null || true)
docker rm --force signalbox-runner >/dev/null 2>&1 || true
exec docker run --name signalbox-runner --network host --init \\
  --volume ${MACHINE_HOME}:${MACHINE_HOME} \\
  --env SIGNALBOX_RUNNER_IMAGE="$image" \\
  --env SIGNALBOX_RUNNER_IMAGE_DIGEST="$digest" \\
  "$image" machine --config "$config"
SCRIPT
sudo chmod 0755 /usr/local/bin/signalbox-runner
sudo tee /etc/systemd/system/signalbox-runner.service >/dev/null <<'UNIT'
[Unit]
Description=Signalbox Runner
StartLimitIntervalSec=0
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/signalbox-runner
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now signalbox-runner.service
`;

type Actual = MachineStatus["actual"];

const actualOf = (state: string): Actual => {
  switch (state) {
    case "ready":
    case "idle":
    case "running":
      return "running";
    case "archiving":
      return "stopping";
    case "archived":
      return "stopped";
    case "error":
      return "failed";
    case "cancelled":
      return "none";
    default:
      // init, provisioning, provisioned, cloning, and anything newer.
      return "starting";
  }
};

export interface BoatMachineBackendInput {
  readonly settings: Extract<MachineSettings, { kind: "boat" }>;
  readonly api: BoatApi;
  readonly records: MachineRecords["Service"];
  readonly crypto: Crypto.Crypto;
}

export const makeBoatMachineBackend = ({
  settings,
  api,
  records,
  crypto,
}: BoatMachineBackendInput): MachineBackendShape => {
  const newKey = Effect.orDie(crypto.randomUUIDv4);
  const failed = (cause: BoatApiError) =>
    new MachineBackendError({
      message: `boat ${cause.operation} failed: ${cause.message}`,
      cause,
    });
  const statusOf = (
    record: MachineRecord,
    actual: Actual,
    detail?: string,
    wake?: MachineStatus["wake"],
  ): MachineStatus => ({
    desired: record.desired,
    actual,
    machineId: record.machineId,
    ...(detail === undefined ? {} : { detail }),
    ...(wake === undefined ? {} : { wake }),
  });

  /** Saves `record` when it changed. */
  const update = (before: MachineRecord, after: MachineRecord) =>
    before.machineId === after.machineId &&
    before.createKey === after.createKey &&
    before.desired === after.desired &&
    before.settled === after.settled
      ? Effect.succeed(after)
      : Effect.as(records.save(after), after);

  const createRequest = {
    type: settings.machineType,
    ttlSeconds: settings.ttlSeconds,
    setupScript: SETUP_SCRIPT,
  };

  /** The sandbox behind `record`, forgetting it when boat no longer has it. */
  const sandboxOf = (record: MachineRecord & { readonly machineId: string }) =>
    Effect.gen(function* () {
      const sandbox = yield* api.get(record.machineId);
      if (sandbox !== null && sandbox.state !== "cancelled") {
        return { record, sandbox };
      }
      // Deleted, or a create that never got a machine: the next ensure makes a new one.
      const gone = yield* update(record, { ...record, machineId: null, createKey: null });
      return { record: gone, sandbox: null };
    });

  /** Deletes a broken VM, so the next ensure creates a fresh one. Its disk is only a cache. */
  const replace = (record: MachineRecord, id: string, detail: string) =>
    Effect.gen(function* () {
      yield* api.remove(id).pipe(
        Effect.catchIf(
          (error) => error.status === 404,
          () => Effect.void,
        ),
      );
      const cleared = yield* update(record, { ...record, machineId: null, createKey: null });
      return statusOf(cleared, "failed", detail);
    });

  const ensure: MachineBackendShape["ensure"] = (request) =>
    Effect.gen(function* () {
      const stored = yield* records.get;
      // What the thread wants goes down first, so whatever happens below is retried.
      const createKey = stored.machineId === null ? (stored.createKey ?? (yield* newKey)) : null;
      let record = yield* update(stored, {
        ...stored,
        desired: "running",
        settled: stored.desired === "running" && stored.settled,
        createKey,
      });
      if (record.machineId === null && createKey !== null) {
        const created = yield* api.create(createRequest, createKey).pipe(
          Effect.map((sandbox): BoatSandbox | null => sandbox),
          // The first try is still creating it: ask again later with the same key.
          Effect.catchIf(
            (error) => error.code === "idempotency_in_progress",
            () => Effect.succeed(null),
          ),
        );
        if (created === null) {
          return statusOf(record, "starting", "boat is still creating it.", "cold");
        }
        record = yield* update(record, { ...record, machineId: created.id, createKey: null });
        if (actualOf(created.state) !== "running")
          return statusOf(record, "starting", created.state, "cold");
      }
      const machineId = record.machineId;
      if (machineId === null) return statusOf(record, "starting");
      const { record: current, sandbox } = yield* sandboxOf({ ...record, machineId });
      if (sandbox === null) return statusOf(current, "starting", "The machine was gone.");
      const actual = actualOf(sandbox.state);
      switch (actual) {
        case "stopped":
        case "stopping":
          // A resume also cancels a stop still in progress.
          yield* api.resume(sandbox.id);
          return statusOf(current, "starting", `Resuming from ${sandbox.state}.`, "disk_resume");
        case "starting":
        case "none":
          return statusOf(current, "starting", sandbox.state);
        case "failed":
          return yield* replace(current, sandbox.id, sandbox.error ?? "boat reports an error.");
        case "running":
          break;
      }
      if (sandbox.setupStatus === "failed") {
        return yield* replace(
          current,
          sandbox.id,
          `The machine's setup script failed${sandbox.setupError ? `: ${sandbox.setupError}` : "."}`,
        );
      }
      yield* api.writeFile(
        sandbox.id,
        CONFIG_PATH,
        machineConfigJson.encode({
          threadId: request.threadId,
          generation: request.generation,
          token: request.token,
          modelGatewayUrl: settings.modelGatewayUrl,
          cloudUrl: settings.cloudUrl,
          image: settings.image,
        }),
      );
      return statusOf(current, "running", undefined, "warm");
    }).pipe(Effect.mapError(failed));

  /** Moves the machine toward `desired` (`stopped` or `destroyed`). */
  const letGo = (desired: "stopped" | "destroyed") =>
    Effect.gen(function* () {
      const stored = yield* records.get;
      if (stored.desired === desired && stored.settled) {
        return statusOf(stored, stored.machineId === null ? "none" : "stopped");
      }
      let record = yield* update(stored, { ...stored, desired, settled: false });
      if (record.machineId === null && record.createKey !== null) {
        // A create whose answer was lost may still have made a VM. Replaying it
        // with its key returns that VM (or makes one, which is then stopped).
        const created = yield* api.create(createRequest, record.createKey).pipe(
          Effect.catchIf(
            (error) => error.code === "idempotency_in_progress",
            () => Effect.succeed(null),
          ),
        );
        if (created === null) return statusOf(record, "starting", "boat is still creating it.");
        record = yield* update(record, { ...record, machineId: created.id, createKey: null });
      }
      if (record.machineId === null) {
        return statusOf(
          yield* update(record, { ...record, createKey: null, settled: true }),
          "none",
        );
      }
      if (desired === "destroyed") {
        yield* api.remove(record.machineId).pipe(
          Effect.catchIf(
            (error) => error.status === 404,
            () => Effect.void,
          ),
        );
        const gone = { ...record, machineId: null, createKey: null, settled: true };
        return statusOf(yield* update(record, gone), "none");
      }
      const stopped = yield* api.stop(record.machineId).pipe(
        Effect.as(true),
        // A machine that is still booting, or already gone, says so here.
        Effect.catchIf(
          (error) => error.status >= 400 && error.status < 500,
          () => Effect.succeed(false),
        ),
      );
      if (!stopped) {
        const { record: current, sandbox } = yield* sandboxOf({
          ...record,
          machineId: record.machineId,
        });
        const actual = sandbox === null ? "none" : actualOf(sandbox.state);
        if (actual !== "stopped" && actual !== "stopping" && actual !== "none") {
          return statusOf(current, actual, "boat refused the stop for now.");
        }
        return statusOf(yield* update(current, { ...current, settled: true }), actual);
      }
      return statusOf(yield* update(record, { ...record, settled: true }), "stopping");
    }).pipe(Effect.mapError(failed));

  const inspect: MachineBackendShape["inspect"] = () =>
    Effect.gen(function* () {
      const record = yield* records.get;
      if (record.machineId === null) return statusOf(record, "none");
      const sandbox = yield* api.get(record.machineId);
      return statusOf(record, sandbox === null ? "none" : actualOf(sandbox.state), sandbox?.state);
    }).pipe(Effect.mapError(failed));

  return {
    kind: "boat",
    shape: settings.machineType,
    image: settings.image,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    ensure,
    stop: () => letGo("stopped"),
    destroy: () => letGo("destroyed"),
    inspect,
    pending: Effect.map(records.get, (record) => record.desired !== "running" && !record.settled),
    refresh: () =>
      Effect.flatMap(records.get, (record) =>
        record.machineId === null ? Effect.void : api.setTtl(record.machineId, settings.ttlSeconds),
      ).pipe(Effect.mapError(failed)),
    // Well inside the TTL, so one missed refresh does not stop a working machine.
    refreshEveryMs: (settings.ttlSeconds * 1000) / 4,
  };
};
