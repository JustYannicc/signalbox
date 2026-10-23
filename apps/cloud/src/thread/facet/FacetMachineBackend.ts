import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { HarnessError } from "../../harness/Harness.ts";
import * as MachineBackend from "../runner/MachineBackend.ts";

export interface FacetHostPort {
  readonly ensure: (
    request: MachineBackend.MachineRequest,
    machineId: string,
  ) => Effect.Effect<void, HarnessError>;
  readonly stop: (threadId: ThreadId) => Effect.Effect<boolean, HarnessError>;
  readonly inspect: (threadId: ThreadId, machineId: string) => Effect.Effect<boolean, HarnessError>;
}

const backendFailure = (operation: string, cause: unknown) =>
  new MachineBackend.MachineBackendError({
    message: `The harness facet could not ${operation}.`,
    cause,
  });

export const layerFacetMachineBackend = (host: FacetHostPort) =>
  Layer.effect(
    MachineBackend.MachineBackend,
    Effect.gen(function* () {
      const records = yield* MachineBackend.MachineRecords;
      const lock = yield* Semaphore.make(1);

      const status = (
        desired: MachineBackend.MachineStatus["desired"],
        actual: MachineBackend.MachineStatus["actual"],
        machineId: string | null,
        wake?: MachineBackend.WakeKind,
      ): MachineBackend.MachineStatus => ({
        desired,
        actual,
        machineId: actual === "none" ? null : machineId,
        ...(wake === undefined ? {} : { wake }),
      });

      const backend: MachineBackend.MachineBackendShape = {
        kind: "facet",
        shape: null,
        image: null,
        connectTimeoutMs: MachineBackend.CONNECT_TIMEOUT_MS,
        idleTailMs: MachineBackend.IDLE_TAIL_MS,
        refreshEveryMs: null,
        refresh: () => Effect.void,
        pending: Effect.map(records.get, (record) => !record.settled),
        ensure: (request) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const machineId = `facet:${request.threadId}:${request.generation}`;
              const previous = yield* records.get;
              if (previous.desired === "destroyed")
                return yield* new MachineBackend.MachineBackendError({
                  message: "The destroyed harness facet cannot be restarted.",
                });

              const alreadyRunning = yield* host
                .inspect(request.threadId, machineId)
                .pipe(Effect.mapError((cause) => backendFailure("inspect", cause)));
              if (
                alreadyRunning &&
                previous.machineId === machineId &&
                previous.desired === "running" &&
                previous.settled
              )
                return status("running", "running", machineId, "warm");

              const record: MachineBackend.MachineRecord = {
                machineId,
                createKey: machineId,
                desired: "running",
                settled: false,
              };
              yield* records.save(record);
              yield* host
                .ensure(request, machineId)
                .pipe(Effect.mapError((cause) => backendFailure("open", cause)));
              yield* records.save({ ...record, settled: true });
              return status("running", "running", machineId, alreadyRunning ? "warm" : "cold");
            }),
          ),
        stop: (threadId) => release(threadId, "stopped"),
        destroy: (threadId) => release(threadId, "destroyed"),
        inspect: (threadId) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const record = yield* records.get;
              const machineId = record.machineId;
              const running =
                machineId !== null &&
                (yield* host
                  .inspect(threadId, machineId)
                  .pipe(Effect.mapError((cause) => backendFailure("inspect", cause))));
              const actual: MachineBackend.MachineStatus["actual"] = running
                ? "running"
                : record.desired === "running"
                  ? record.settled
                    ? "none"
                    : "starting"
                  : record.desired === "stopped"
                    ? "stopped"
                    : "none";
              return status(record.desired, actual, machineId);
            }),
          ),
      };

      function release(threadId: ThreadId, desired: "stopped" | "destroyed") {
        return lock.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* records.get;
            const hadMachine = previous.machineId !== null;
            yield* records.save({ ...previous, desired, settled: false });
            const stopped = yield* host
              .stop(threadId)
              .pipe(Effect.mapError((cause) => backendFailure("stop", cause)));
            yield* records.save({
              machineId: null,
              createKey: null,
              desired,
              settled: true,
            });
            return status(desired, stopped || hadMachine ? "stopped" : "none", null);
          }),
        );
      }

      return MachineBackend.MachineBackend.of({ light: backend, heavy: backend });
    }),
  );
